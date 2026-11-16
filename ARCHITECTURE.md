# ARCHITECTURE

Processador distribuído de apostas: recebe transações de provedores de jogos por **HTTP** e por **SQS**, aplica-as de
forma idempotente e segura sob concorrência em carteiras com **ledger auditável**, e publica eventos por **outbox
transacional**.

> **Estado de verificação (seção 15):** 317 testes executados (179 unitários, 121 de integração, 17 de concorrência) passam contra
> um PostgreSQL 16 real; a stack Docker Compose (3 instâncias + PostgreSQL + LocalStack) sobe saudável e os 10 testes
> e2e (HTTP em 3 instâncias e SQS real) passam. A seção 15 lista o que ainda **não** é coberto.

## 1. Princípio de projeto: cada garantia mora na camada mais baixa que consegue impô-la

| Garantia | Onde é imposta | Como |
|---|---|---|
| Saldo nunca negativo | PostgreSQL | `CHECK (balance >= 0)` |
| Sem débito/crédito duplicado | PostgreSQL | `UNIQUE (provider_id, external_transaction_id)`, `UNIQUE (idempotency_key)`, `UNIQUE (wallet_id, transaction_id)` no ledger |
| Uma reversão por transação | PostgreSQL | índice único parcial `uq_wager_tx_one_reversal_per_reference` |
| Ledger imutável | PostgreSQL | triggers `BEFORE UPDATE/DELETE/TRUNCATE` + ausência de `GRANT UPDATE/DELETE` ao role da aplicação |
| Saldo = último `balance_after` do ledger | PostgreSQL | *constraint trigger* `DEFERRABLE INITIALLY DEFERRED` em `wallets` (checado no COMMIT) |
| Aritmética de cada lançamento | PostgreSQL | `CHECK (balance_after = balance_before ± amount)` |
| Exclusão mútua por carteira | PostgreSQL | `SELECT ... FOR NO KEY UPDATE` |
| Dedup de mensagens SQS | PostgreSQL | `PRIMARY KEY (consumer_name, message_id)` na inbox |
| Regras de negócio (BET/WIN/…) | Domínio puro | `settle()` + `Wallet` + `WagerTransaction`, sem I/O |
| Nada publicado antes do commit | Arquitetura | eventos só são escritos no outbox, na mesma transação |

Nada disso depende de memória do processo, de cache ou da ordenação do FIFO. Por isso a solução é correta com 1 ou N
instâncias (provado com 3 processos reais, seção 13).

## 2. Visão geral

```
        HTTP (NestJS)                          SQS wager-transactions.fifo
   POST /wagering/transactions                 (consumidor, N pollers)
              │  parse + valida                        │  parse + valida (mesmo parser)
              └────────────────┬───────────────────────┘
                               ▼
              ProcessWagerTransactionUseCase     (UM caso de uso para as duas entradas)
   ┌───────────────────────────────────────────────────────────────────────────┐
   │  UMA transação SQL                                                          │
   │  (0) inbox:        INSERT ... ON CONFLICT DO NOTHING          [só SQS]      │
   │  (1) idempotência: INSERT wager_transaction ... ON CONFLICT DO NOTHING      │
   │        └─ já existia? → replay (mesmo resultado) ou 409 (payload diferente) │
   │  (2) concorrência: SELECT wallet ... FOR NO KEY UPDATE                      │
   │  (3) regras:       settle() → APPLIED | REJECTED | WAIT_REFERENCE           │
   │        wallet UPDATE (WHERE version = ?) + ledger INSERT + tx UPDATE        │
   │        + outbox INSERT (eventos)                                            │
   └───────────────────────────────────────────────────────────────────────────┘
                               │ COMMIT
        ┌──────────────────────┼───────────────────────────┐
        ▼                      ▼                           ▼
   ack da mensagem     OutboxPublisher              PendingReferenceWorker
   (só após commit)    SKIP LOCKED → SQS events     SKIP LOCKED → mesmo caso de uso
```

Camadas (`src/`): `domain/` (puro, sem framework nem ORM) → `application/` (casos de uso, portas, workers) →
`infrastructure/` (SQL, MikroORM, SQS, logs, métricas) → `interfaces/http/` (controllers finos). As dependências
apontam para dentro; as portas (`ports.ts`) são interfaces TypeScript, sem decorators de DI no domínio.

## 3. ORM, mapeamento de `Money` e estratégia transacional

### 3.1 MikroORM — papel exato e por que não usamos Unit of Work/Identity Map no caminho quente

MikroORM é o **gerenciador de pool e de transação** em produção: `EntityManager.fork().transactional()` abre
`BEGIN … COMMIT/ROLLBACK`, um *fork* por unidade de trabalho (identity map próprio, nunca compartilhado entre
requisições/mensagens). O SQL dos repositórios é **explícito** (`src/infrastructure/persistence/repositories.ts`) e
roda pelo `EntityManager` que detém a transação corrente (`MikroOrmSqlExecutor`).

Decisão consciente: **as entidades de domínio não são entidades MikroORM**. Os motivos são concretos:

1. O núcleo da correção usa `INSERT … ON CONFLICT DO NOTHING RETURNING`, `FOR NO KEY UPDATE SKIP LOCKED`, índice único
   parcial e `lag() OVER` na reconciliação. Nenhum deles é expresso por Unit of Work; o UoW faria o `INSERT` só no
   `flush()`, **perdendo exatamente o portão de idempotência** que precisa ser a primeira operação da transação.
2. O Identity Map é um risco numa carteira disputada: uma leitura anterior sem lock devolveria estado velho de um
   agregado que depois seria "salvo". O desenho elimina isso: a **primeira** leitura da carteira na unidade de
   trabalho é a com lock.
3. O domínio fica testável sem ORM (179 testes de unidade e 121 de integração rodam sem MikroORM).

`LockMode.PESSIMISTIC_WRITE` do MikroORM emite `FOR UPDATE`; usamos `FOR NO KEY UPDATE` (§4), que dá a mesma exclusão
mútua entre escritores sem bloquear verificações de chave estrangeira vindas de `wager_transactions`/ledger.

**Migrations:** arquivos SQL versionados (`migrations/sql/NNNN_nome.{up,down}.sql`) com runner próprio
(`src/infrastructure/persistence/migrator.ts`), porque CHECK, triggers, índices parciais e GRANTs são parte do desenho
e nenhum gerador de schema os reproduz com fidelidade. O runner exige o par `up/down` (rejeita migration sem `down`),
aplica cada migration + seu registro em `schema_migrations` **numa transação** e usa `pg_advisory_xact_lock`, então
6 instâncias subindo juntas aplicam cada migration exatamente uma vez (testado). Ciclo `up → down → up` testado.

**Trade-off assumido:** perdemos o mapeamento automático e o *change tracking* do MikroORM; ganhamos controle total do
SQL concorrente. O custo é escrever e testar os repositórios à mão (feito: ver `test/integration`).

### 3.2 `Money`

* Na borda (HTTP/SQS) e nos eventos: **string decimal** com escala 2 (`"25.00"`). Nunca `number` (critério eliminatório).
* No domínio: `Money` imutável sobre **`bigint` de unidades menores** (centavos). Soma/subtração exatas, sem float.
  Parse por regex `^\d{1,17}(\.\d{1,2})?$`: rejeita sinal, expoente, `NaN`, `Infinity`, vazio e mais de 2 casas
  (**não arredonda silenciosamente**: `"1.234"` é 400). Moeda `^[A-Z]{3}$`; operar moedas diferentes lança
  `CurrencyMismatchError`. Faixa limitada a `numeric(19,2)`.
* No banco: `numeric(19,2)`. O driver devolve `numeric` como **string**, que o repositório converte direto para
  `Money`, sem passar por `number`.
* `LOSS` aceita `0.00` (registra resultado sem mover dinheiro); as demais exigem `> 0`.

### 3.3 Estratégia transacional

* **Uma** transação SQL por unidade de trabalho (inbox + idempotência + carteira + ledger + transação + outbox).
  Atomicidade provada por testes que injetam falha no meio e verificam que **nada** persistiu.
* `SET LOCAL lock_timeout` / `statement_timeout` por transação (`set_config(..., true)`): uma carteira presa vira erro
  **limitado e transitório** (503 / retry), não uma espera infinita.
* **Rejeição de negócio não é exceção.** `settle()` *retorna* `APPLIED | REJECTED | WAIT_REFERENCE`. Uma exceção dentro
  da transação desfaria o registro `REJECTED` (que precisa ser auditável e idempotente). Só erros de infraestrutura lançam.
* Deadlock/serialization (`40P01`/`40001`) são repetidos internamente (até 3×, com jitter): sempre seguros por causa da
  idempotência. `55P03` (lock timeout) é devolvido como transitório.

## 4. Estratégia de concorrência

**Escolha: lock pessimista por carteira** (`SELECT … FOR NO KEY UPDATE`) + `UPDATE … WHERE version = ?` como cinto de
segurança. Justificativa por alternativa:

| Alternativa | Por que não (como mecanismo principal) |
|---|---|
| Otimista com retry limitado | Numa carteira quente (muitas apostas simultâneas) vira tempestade de retries e desperdiça trabalho; o enunciado exige carteira quente. |
| `UPDATE … SET balance = balance - x WHERE balance >= x` | Ótimo para BET, mas o ledger precisa de `balance_before`, e WIN/REFUND/ROLLBACK têm regras próprias (referência, reversão única, direção). Reimplementaríamos o agregado em SQL. |
| **Pessimista (escolhida)** | Serializa só quem disputa **a mesma carteira**; carteiras distintas nunca esperam entre si (testado); o resultado é determinístico: a 2ª aposta lê o saldo já debitado. |

* O `version` não é o mecanismo, é a **rede de segurança**: `UPDATE … WHERE version = esperada` afetando 0 linhas indica
  bug (lock ignorado) e vira erro transitório (`version_mismatch`, a unidade de trabalho inteira é refeita), nunca
  "último a escrever vence".
* **Sem deadlock por construção:** toda transação toca no máximo **uma** carteira, e sempre na mesma ordem (linha da
  transação → carteira). O worker e o publisher usam `SKIP LOCKED`, então nunca esperam por linha alheia.
* **Teto medido numa carteira única:** ~286 req/s (seção 14): o commit serializado é o limite físico de uma linha.
  Escalar uma carteira quente exigiria particionar a carteira, o que muda o modelo de negócio. Fora de escopo.

## 5. Idempotência

* **Persistente**, no banco: dois índices únicos (`idempotency_key` e `(provider_id, external_transaction_id)`).
* **Portão primeiro:** `INSERT … ON CONFLICT DO NOTHING` é a 1ª operação. Réplicas concorrentes esperam o commit da
  primeira no índice único e depois leem a linha já comitada: 50 requisições iguais em paralelo → 1 débito, 49
  *replays*, sem tocar a carteira (o portão nem pega o lock da carteira: testado com a carteira travada).
* **Replay devolve o resultado original**, inclusive o saldo **observado no momento** do processamento
  (`observed_balance`), não o saldo atual. Replay de `REJECTED` devolve a mesma rejeição; de `PENDING_REFERENCE`, o
  estado atual daquela transação.
* **Mesma chave com payload diferente → 409** (`IdempotencyConflictError`), nunca replay silencioso. Também é 409 o
  mesmo `(provider, externalTransactionId)` com **outra** chave.
* **Hash do payload** (`src/application/payload-hash.ts`): SHA-256 (hex) do **JSON canônico** (chaves ordenadas
  recursivamente, sem espaços, `undefined` omitido) dos campos de negócio: `providerId, externalTransactionId,
  playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId` (`null` se
  ausente). Ficam **fora** o header `Idempotency-Key`, ids de correlação e metadados de transporte; o dinheiro é
  normalizado (`"25.5"` e `"25.50"` geram o mesmo hash). Ordem de chaves diferente → mesmo hash (testado).
* **SQS:** duas camadas. (a) *inbox* por `(consumer_name, message_id)`, na **mesma transação** dos efeitos: a linha
  existir significa que o efeito foi aplicado; (b) a chave de idempotência de negócio. A (a) cobre redelivery; a (b)
  cobre o mesmo fato de negócio reenviado em outra mensagem. O mesmo `messageId` com payload diferente é mensagem
  venenosa (DLQ `INBOX_PAYLOAD_CONFLICT`), não duplicata.

## 6. Máquina de estados de `WagerTransaction`

```
 PENDING ───────────────► PROCESSED            (terminal)
    │  ─────────────────► REJECTED             (terminal, carrega failureCode)
    │  ─────────────────► FAILED               (terminal, carrega failureCode)
    └──► PENDING_REFERENCE ─► PROCESSED | REJECTED | FAILED
             ▲      │
             └──────┘  (nova tentativa: reagenda com backoff)
```

| De | Para | Quando |
|---|---|---|
| `PENDING` | `PROCESSED` | regra aplicada |
| `PENDING` | `PENDING_REFERENCE` | referência ausente ou ainda não liquidada |
| `PENDING` | `REJECTED` | violação de regra de negócio |
| `PENDING_REFERENCE` | `PENDING_REFERENCE` | worker tentou, referência ainda ausente (contador++, novo `next_attempt_at`) |
| `PENDING_REFERENCE` | `PROCESSED` / `REJECTED` | referência chegou / orçamento esgotado / referência rejeitada |
| qualquer não-terminal | `FAILED` | erro **permanente** de infraestrutura/invariante (só no caminho do worker, após `claim`) |
| `PROCESSED`, `REJECTED`, `FAILED` | — | **terminais**: transição lança `InvalidTransactionStateError`, e um trigger no banco impede `UPDATE`/`DELETE` |

`PENDING` só existe dentro da transação de processamento (não é observável de fora). No caminho síncrono (HTTP/SQS) um
erro permanente reverte a transação e responde 500 (não deixa registro); `FAILED` com registro auditável existe para
o caminho do worker, onde a linha já foi comitada antes.

## 7. Taxonomia de `failureCode`

Códigos estáveis (`src/domain/failure-code.ts`), todos persistidos, publicados no evento `WagerTransactionRejected`
e devolvidos no 422 com `failure.providerAction` (o que o provedor deve fazer):

| Código | Ação do provedor | Significado |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `RESEND_NEW` | BET sem saldo |
| `REVERSAL_WOULD_OVERDRAW` | `GIVE_UP` | reverter WIN/REFUND deixaria saldo negativo (**distinto** de `INSUFFICIENT_FUNDS`) |
| `REFERENCE_NOT_FOUND` | `FIX_PAYLOAD` | referência não chegou dentro do orçamento |
| `REFERENCE_NOT_SETTLED` | `GIVE_UP` | referência existe mas não liquidou no orçamento |
| `REFERENCE_REJECTED` | `GIVE_UP` | a referência foi rejeitada; nada a reverter |
| `REFERENCE_INVALID_KIND` | `FIX_PAYLOAD` | tipo de referência inválido para esta operação |
| `REFERENCE_MISMATCH_{PROVIDER,PLAYER,WALLET,ROUND,CURRENCY}` | `FIX_PAYLOAD` | referência pertence a outro provedor/jogador/carteira/rodada/moeda |
| `REFERENCE_AMOUNT_MISMATCH` | `FIX_PAYLOAD` | valor da reversão difere do original (sem reversão parcial) |
| `ALREADY_REVERSED` | `GIVE_UP` | a referência já foi revertida (REFUND ou ROLLBACK) |
| `WALLET_PLAYER_MISMATCH` | `FIX_PAYLOAD` | `playerId` não é dono da carteira |
| `CURRENCY_MISMATCH` | `FIX_PAYLOAD` | moeda da transação ≠ moeda da carteira |
| `INTERNAL_ERROR` | `CONTACT_SUPPORT` | falha permanente nossa (status `FAILED`) |

**Mapeamento HTTP** (`http-mapping.ts`, um só lugar): `200` aplicada (inclui replay) · `201` carteira criada · `202`
`PENDING_REFERENCE` (não final; consulte, **não reenvie**) · `400` payload inválido (reenviar igual nunca ajuda) · `404`
inexistente · `409` conflito de idempotência / carteira duplicada · `422` rejeição de negócio (final, com `failureCode`)
· `503` + `Retry-After` falha transitória (reenviar **a mesma** requisição é seguro) · `500` inesperado. As cinco
situações que o enunciado manda não confundir têm cinco status distintos (testado).

## 8. Regras de negócio e interpretações

| Operação | Efeito |
|---|---|
| `BET` | débito; rejeita `INSUFFICIENT_FUNDS`. Não aceita referência. |
| `WIN` | crédito. Referência a uma BET é **opcional**; se vier, é validada. |
| `LOSS` | não move dinheiro, não gera lançamento nem `WalletBalanceChanged`; valor pode ser `0.00`. |
| `REFUND` | crédito; **exige** referência a uma BET, mesmo valor. |
| `ROLLBACK` | **inverso** da direção da referência: reverter BET credita; reverter WIN/REFUND debita. Referência: BET, WIN ou REFUND. |
| `OPENING` | **interno**: crédito do saldo inicial, criado com a carteira (provedor reservado `internal`). Recusado em HTTP e SQS. |

Interpretações assumidas (o texto admite mais de uma leitura):

1. **Uma reversão por transação, por qualquer tipo** (REFUND *ou* ROLLBACK). A leitura "mesmo tipo" permitiria
   BET → REFUND → ROLLBACK creditando duas vezes, violando a invariante global. Imposto por índice único parcial.
2. **Sem reversão parcial:** o valor deve igualar o da referência.
3. **ROLLBACK de WIN/REFUND que estouraria o saldo** é `REVERSAL_WOULD_OVERDRAW`, não `INSUFFICIENT_FUNDS`: o
   significado operacional é outro (o jogador já gastou o prêmio).
4. A referência é validada na ordem identidade (provedor/jogador/carteira/moeda/rodada) → tipo → valor → estado.
5. Moeda divergente da carteira é **rejeição de negócio** (422 `CURRENCY_MISMATCH`), não 400, porque o payload é válido.
6. Rejeição **não** gera lançamento no ledger, mas **gera** registro auditável, `observed_balance` e evento.
7. Valor zero: rejeitado para tudo exceto `LOSS`.

## 9. `PENDING_REFERENCE`: limite e justificativa

Referência ausente → a transação é **comitada** como `PENDING_REFERENCE` (nenhum dinheiro se move) com evento
`WagerTransactionPendingReference` emitido **uma única vez**. Um worker a retoma pelo **mesmo caso de uso**
(`FOR NO KEY UPDATE SKIP LOCKED`: seguro com N instâncias, sem eleição de líder).

* **Orçamento:** `maxAttempts = 10` **ou** TTL de **15 min**, o que vier primeiro (configurável por env).
* **Backoff:** `min(120 s, 2 s · 2^(n-1)) ± 20 % de jitter` → 2, 4, 8, 16, 32, 64, 120, 120, 120 s.
* **Por quê:** a referência faltante é, na prática, uma mensagem SQS atrasada ou reordenada (segundos). 10 tentativas
  ao longo de ~8 min cobrem lag de fila e *backlog*; o TTL de 15 min limita o tempo de dinheiro "em dúvida" e impede
  que referências que nunca virão fiquem vivas para sempre. Jitter evita que várias dependentes acordem juntas.
* **Aceleração:** processar (ou rejeitar) uma transação faz `next_attempt_at = now()` nas dependentes
  (`wakePendingReferencing`, que pula linhas travadas), então o caso comum resolve em ~1 tick do worker, não no backoff.
* **Esgotado:** `REJECTED / REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_SETTLED`), terminal e com evento. A avaliação final
  ainda **consulta a referência antes de rejeitar**, então uma referência que chega no último instante é aplicada.
* **Referência rejeitada** → dependente `REJECTED / REFERENCE_REJECTED` (não espera).

## 10. Mensageria (SQS)

* **Consumidor** (`queue-consumer.ts`): agrupa por `MessageGroupId` (= `walletId`), processa cada grupo em ordem e
  grupos distintos em paralelo. **ack só depois do commit.** Mesma validação do HTTP.
* **Taxonomia de erro:**
  * resultado de negócio (inclui `REJECTED`): já comitado → **ack**;
  * transitório (conexão, lock timeout, deadlock esgotado): **não** apaga; `ChangeMessageVisibility` com backoff
    exponencial `2 s · 2^(n-1)` (teto 300 s) lido de `ApproximateReceiveCount`; após `maxReceiveCount` (5) → DLQ;
  * permanente (payload inválido, `OPENING`, carteira inexistente, conflito de idempotência, conflito de inbox):
    **direto para a DLQ** com atributo `reason`, depois apaga da fila principal.
* **DLQ em dois níveis:** a aplicação envia à DLQ aos 5 recebimentos; o `RedrivePolicy` da fila (10) é só rede de
  segurança. Num grupo FIFO as mensagens inocentes atrás de uma falha também são recebidas várias vezes, e não devem
  ir para a DLQ só por esperar.
* **Bloqueio de cabeça de fila:** num FIFO uma mensagem que falha trava o grupo (a carteira) até sair para a DLQ. É a
  semântica do FIFO e fica documentada como limitação.
* **Duplicata e crash entre commit e ack:** a redelivery encontra a linha da inbox e apenas dá ack. Provado com
  `afterCommitBeforeAck` lançando exceção: o dinheiro já tinha se movido, a redelivery não move de novo.
* **SIGTERM:** `stop()` interrompe o *long polling*, deixa a mensagem em andamento terminar (e dar ack), devolve as
  demais com visibility 0 (outra instância pega **imediatamente**, sem esperar o visibility timeout), com limite de
  25 s; só então o pool de banco fecha (`BeforeApplicationShutdown` → HTTP → `OnApplicationShutdown`).
* **Janela de dedup do FIFO (5 min)** é otimização, não garantia: a garantia é a inbox/idempotência no banco.

## 11. Outbox transacional

* Eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`,
  `WalletBalanceChanged`) são **escritos no outbox na mesma transação** da mudança financeira. Nada é publicado antes
  do commit (testado: transação aberta é invisível ao publisher; transação revertida não deixa evento).
  `WalletBalanceChanged` só existe quando o saldo muda (nunca em LOSS ou rejeição).
* Envelope estável (`eventId, eventType, aggregateId(=walletId), correlationId, causationId, occurredAt, version, data`),
  dinheiro como string decimal. `eventId` = id do outbox = `MessageDeduplicationId`.
* **Publisher:** `SELECT … ORDER BY next_attempt_at, seq FOR UPDATE SKIP LOCKED`, publica no SQS e marca
  `published_at` na mesma transação. Dois (ou dez) publishers nunca compartilham linha (testado: 10 publishers, 122 eventos, zero
  duplicata). Se o processo morre após o broker aceitar e antes do commit, a linha volta e é **republicada**
  (**at-least-once**) com o **mesmo `eventId`**. Falha do broker: `attempts++`, backoff 1 s … 60 s; um evento
  envenenado não bloqueia o lote.
* **Trade-offs declarados:** (i) at-least-once: consumidores deduplicam por `eventId`; (ii) a ordem entre instâncias não
  é global: consumidores usam `walletVersion` (e o `MessageGroupId` = `walletId` ordena no FIFO); (iii) a transação
  fica aberta durante o I/O de rede do lote (lotes pequenos, 50 por padrão).
* **Medição:** um único publisher não acompanha 1 200 req/s (lag p95 ≈ 7,7 s, esvazia em ~1,8 s após a carga). A
  correção é horizontal (mais instâncias, `SKIP LOCKED`); ver seção 14.

## 12. Reconciliação, observabilidade e autenticação

**Reconciliação** (`POST /wallets/{id}/reconciliation`): **somente leitura**, **uma única consulta SQL** (portanto um
*snapshot* consistente, sem falso positivo sob escrita concorrente) que compara `wallets.balance` com a soma assinada
do ledger e verifica a cadeia `balance_before == balance_after` do lançamento anterior (`lag()`). Divergência **nunca é
corrigida em silêncio**: é logada, contada em `reconciliation_divergences_total` e sinalizada na resposta. O invariante
`wallet.balance == saldo reconstruído do ledger` roda ao final dos testes (`findInconsistentWallets`).

**Observabilidade:** logs JSON estruturados (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`),
com **redação por chave** de dinheiro, saldos e payloads (nunca logados); `GET /metrics` (Prometheus):
`wager_transactions_total{status,kind}`, `wager_duplicates_total`, `wager_retries_total{reason}`,
`wager_dlq_messages_total{reason}`, `wallet_lock_conflicts_total{outcome}`, `wallet_lock_wait_seconds`,
`wager_processing_duration_seconds`, `outbox_lag_seconds`, `pending_reference_attempts_total`, `outbox_published_total`;
`GET /health/live` (processo vivo, **não** depende de banco/SQS) e `GET /health/ready` (PostgreSQL e SQS respondem em 2 s).
Métricas são por instância.

**Autenticação (decisão: não implementada, ponto de extensão explícito).** O enunciado a pontua com 0 e pede para não
competir com a correção financeira. Em código: `ProviderIdentityPort` + `AuthGuard` *no-op* aplicado a todos os
endpoints de negócio (nunca a `/health/*`), em `src/interfaces/http/auth.ts`. **Desenho pretendido:** IdP OIDC externo
(Keycloak ou Zitadel), JWT *bearer* validado contra o JWKS do IdP; o `client_id`/`azp` mapeia para um `providerId`, e o
guard compara com o `providerId` de **todo** payload (um provedor não opera em nome de outro). Sem armazenar
usuário/senha. Para webhooks de provedores, alternativa: assinatura HMAC do corpo ou mTLS.

## 13. Estratégia de testes

Banco **real** (PostgreSQL 16) em todos os testes de integração e concorrência; nenhum teste substitui o banco por mock.

| Camada | Qtde | O que prova |
|---|---|---|
| Unidade (`test/unit`) | 182 | `Money` (escala, arredondamento recusado, entradas inválidas), invariantes de `Wallet`, regras BET/WIN/LOSS/REFUND/ROLLBACK, moedas, máquina de estados, hash canônico, mapeamento HTTP, logger, métricas, config |
| Integração (`test/integration`) | 121 | migrations e constraints (`up→down→up`), atomicidade carteira+ledger+inbox+outbox, imutabilidade do ledger, inbox/redelivery, retry/DLQ/shutdown, publishers concorrentes, recuperação após crash, `PENDING_REFERENCE`, role de aplicação de menor privilégio |
| Concorrência (`test/concurrency`) | 17 | os 8 itens obrigatórios, com paralelismo real e **3 processos OS** (`Bun.spawn`) |
| E2E (`test/e2e`) | 10 | stack completa: 3 instâncias + LocalStack (**não executados aqui**, §15) |

Mapa dos 8 itens de concorrência obrigatórios: (1) 50 iguais → `concurrency.test.ts` "same BET sent 50 times";
(2) cenário 100/80/80 + 60 repetições; (3) carteiras distintas em paralelo, 40 × 5; (4) 3 processos reais; (5) worker
morto após commit/antes do ack → `queue-consumer.test.ts`; (6) dois publishers → `outbox.test.ts`; (7) REFUND/ROLLBACK
antes da referência → `pending-reference.test.ts`; (8) restart com prova de consistência eventual (instâncias
`SIGKILL`adas no meio e reiniciadas). **Invariante final em todos:** `wallet.balance == saldo reconstruído do ledger`.

Determinismo: relógio e jitter injetáveis (`TestClock`, `random()`), sem `sleep` para "dar tempo" onde há alternativa;
o teste dos 60 repetições existe para provar que o 100/80/80 não é sorte.

## 14. Teste de carga (bônus): `bun run test:load`

**O que mede:** o núcleo (caso de uso + repositórios + PostgreSQL real) com o publisher do outbox rodando em paralelo.
**Não** passa por HTTP/NestJS nem por rede SQS. **Ambiente:** VM de sandbox, 2 vCPU Xeon, 8 GB, PostgreSQL 16.15 com
configuração **padrão** (`shared_buffers=128MB`, `fsync=on`), Bun 1.4.4, gerador de carga e banco **na mesma
máquina**. Os números são **indicativos, não um benchmark de capacidade**. Relatórios completos em `docs/load-test/`.
Mix: ~70 % BET, ~10 % LOSS, ~10 % WIN referenciada, ~10 % reenvios duplicados; 32 workers; 10 s.

| Cenário | req/s | p50 / p95 / p99 (ms) | Erros | Esperas de lock | Lag outbox p95 | Invariantes |
|---|---|---|---|---|---|---|
| 200 carteiras, 20 % na carteira quente | 987 | 5,5 / 192,9 / 461,7 | 0 % | 1 433 (timeouts 0) | 0,28 s | ok |
| **1 única carteira** (pior caso) | 286 | 65,5 / 378,8 / 699,0 | 0 % | 1 905 (timeouts 0) | 0,03 s | ok |
| 200 carteiras distribuídas | 1 184 | 26,5 / 43,5 / 57,0 | 0 % | 92 | **7,7 s** | ok |

Leituras: (a) o custo de uma carteira quente é a serialização do commit (~286 req/s: limite físico da linha), com
latência que cresce com a fila no lock, mas **sem timeout, sem erro, sem saldo negativo**; (b) com carteiras
distribuídas o gargalo passa a ser o **publisher único** (1 184 req/s ≈ 2 000 eventos/s): o lag sobe a ~7,7 s e se
recupera em 1,8 s ao fim da carga: mais instâncias do publisher resolvem (`SKIP LOCKED`); (c) em todos os cenários
as invariantes finais se mantêm (ledger = transações processadas, 0 saldos negativos, 0 pendências presas).
O número de `deadlockRetries` foi 0, como previsto pelo desenho de uma carteira por transação.

## 15. Limitações, riscos e o que NÃO foi verificado

**Verificado por execução** (Bun 1.4.4, PostgreSQL 16, Docker Compose com LocalStack 3.8.1):

* `test:unit` 179 (hoje 182, ver abaixo), `test:integration` 121 (PostgreSQL real) e `test:concurrency` 17 (inclui 3 processos reais e SIGKILL no
  meio do processamento): **317 passando, 0 falhas**. Depois dessa execução entraram 3 testes unitários da trava de
  banco de teste (`test/unit/test-database-guard.test.ts`; lógica validada em Node, ainda não executados no Bun).
* `docker compose up --build -d`: PostgreSQL, LocalStack e as 3 instâncias `healthy`; `test:e2e` **10/10** (o cenário
  obrigatório, 50 duplicatas em paralelo entre instâncias, códigos HTTP distintos, REFUND fora de ordem, reconciliação,
  paginação, consumo SQS com duplicatas, DLQ e outbox para a fila de eventos).
* `test:load` reproduzido em outra máquina (i7-1165G7, 8 CPUs, 15,9 GB; PostgreSQL e gerador na mesma máquina): 7 605
  requisições em 15 s, 498 req/s, p50/p95/p99 de 11,8/380/992 ms, 0 erros, 0 divergências entre saldo e ledger. Os
  números diferem dos da seção 14 porque o ambiente e a mistura de carga são outros: continuam **indicativos**.
* O adaptador MikroORM (`transactional()` + `execute()` na mesma conexão), o AWS SDK (`ReceiveMessage` com atributos de
  sistema) e o healthcheck do LocalStack, que eram os pontos de maior risco, foram exercitados pelo e2e sem ajuste de
  código. O único defeito na primeira execução real foi **operacional**: o `init-queues.sh` perdia o bit de execução ao
  baixar o projeto como `.zip`, as filas não eram criadas e o `localstack` nunca ficava `healthy`. O pacote agora o traz
  executável e o README documenta o `chmod +x`.

**Não coberto por testes (lacunas conhecidas):**

1. Os testes de integração do **consumidor** (retry com backoff, DLQ por `maxReceiveCount`, crash entre commit e ack,
   SIGTERM) usam uma **fila FIFO em memória** (`test/helpers/in-memory-queue.ts`, modelada na semântica do SQS: grupo,
   visibility, receive count, redrive) com o **PostgreSQL real**. Contra o **SQS real** (LocalStack) o e2e cobre apenas
   consumo com deduplicação, mensagem inválida na DLQ e outbox para a fila de eventos. Retry com visibilidade real,
   `RedrivePolicy`, redelivery após crash e devolução de mensagens no SIGTERM **não** têm teste contra o SQS real.
2. O `package.json` não tem script de verificação de tipos (`tsc --noEmit`): o Bun executa sem checar tipos.
3. O **back office** (seção 16) tem testes escritos, mas **não executados**; por isso é opt-in no compose (`--profile
   backoffice`) e fica fora do `test:all`.
4. Medições de carga são indicativas (gerador e banco na mesma máquina).

**Limitações de desenho (conhecidas e aceitas):** at-least-once no outbox; ordem de eventos não global entre
instâncias; bloqueio de cabeça de fila do FIFO por carteira; carteira única limitada a ~286 req/s; ids UUID v4 (sem
localidade de índice do v7); sem particionamento de tabelas, sem política de retenção/arquivamento do ledger e do
outbox publicado; autenticação apenas como ponto de extensão; métricas por instância (sem agregação). O que fazer a respeito, e em que
ordem, está na [seção 17 (roadmap v2)](#17-roadmap-v2-escala-sharding-e-evolução-da-arquitetura).


---

## 16. BÔNUS: MVP do Back Office Operacional e SRE

**Documentação completa (uso, API, segurança e testes): [`backoffice.md`](./backoffice.md).**

Implementado em [`backoffice/`](./backoffice): serviço Bun sem dependências (HTTP + uma página HTML), na porta 4000 do
compose, **opt-in** (`docker compose --profile backoffice up --build -d`): não faz parte da stack padrão nem do `test:all`. Leitura direta do PostgreSQL e chamadas à API só onde a regra já mora nela.

1. **Transações:** totais por status e listagem filtrável (`PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`,
   `FAILED`), com a ação **reprocessar agora** para `PENDING_REFERENCE`.
2. **Reconciliação de carteira:** repasse a `POST /wallets/{id}/reconciliation` (saldo armazenado × ledger, somente leitura).
3. **SRE:** `wallet_lock_conflicts_total` (por resultado `waited`/`timeout`) lido de `/metrics` de cada instância e somado.

Decisões: o reprocessamento só reagenda `reference_next_attempt_at = now()` (único UPDATE do painel, guardado por
`status = 'PENDING_REFERENCE'`); quem processa continua sendo o worker, pelo mesmo caso de uso, então nenhuma regra
financeira é duplicada e o painel nunca escreve em saldo ou ledger. Transações terminais são imutáveis no banco (trigger),
logo o retry nelas devolve `409`. Todas as consultas são parametrizadas; filtros são validados contra listas fechadas.
Autenticação do painel: token compartilhado **opcional** (`BACKOFFICE_TOKEN`) e porta só em `127.0.0.1`; login por usuário
é extensão futura, coerente com a autenticação da API (ponto de extensão, §12). O porquê e os riscos estão em
[`backoffice.md` §2](./backoffice.md#2-por-que-não-tem-senha-e-o-que-existe-no-lugar).


---

## 17. Roadmap v2: escala, sharding e evolução da arquitetura

Nada aqui é necessário para a v1 estar correta: as garantias financeiras (seção 1) já valem com 1 ou N instâncias sobre
**um** PostgreSQL. Esta seção lista o que muda quando o volume, a operação ou a regulação passarem do que um primário único
sustenta, e **em que ordem** atacar. A medição da seção 14 (sandbox de 2 vCPU, indicativa) mostra o que apareceu primeiro:
a carteira quente (~286 req/s, limite físico da linha), depois o publisher único do outbox (~2 000 eventos/s). O banco
ainda **não** era o limite com carteiras distribuídas, então sharding é a última etapa, não a primeira.

### 17.1 Escada de escala (do mais barato ao mais caro)

| # | Passo | Resolve | Custo |
|---|---|---|---|
| 1 | Mais instâncias do publisher/consumidor (já seguro: `SKIP LOCKED`, FIFO por carteira) | lag do outbox (§14) | configuração |
| 2 | PgBouncer/RDS Proxy: hoje são `instâncias × DB_POOL_MAX` conexões (3 × 20); o `Migrator` usa advisory lock, então ele conecta direto | limite de conexões | baixo |
| 3 | Réplica de leitura para consultas, reconciliação e back office | tirar leitura do primário | baixo; atenção ao atraso de réplica |
| 4 | Instância maior + ajuste de PostgreSQL (`shared_buffers`, WAL, storage de baixa latência) | todo o resto, até o teto | baixo |
| 5 | Particionamento por tempo e arquivamento (17.4) | tamanho de tabela e de índice | médio |
| 6 | *Group commit* por carteira (17.3) | carteira quente | médio |
| 7 | **Sharding por carteira (17.2)** | teto de escrita do primário | alto: muda operação, não regras |

### 17.2 Sharding SQL

**Chave: a carteira.** Todo estado financeiro é por carteira (saldo, versão, ledger, transações), o lock já é por carteira
e o domínio **já exige** que uma referência (REFUND/ROLLBACK/WIN/LOSS) aponte para transação da *mesma* carteira, jogador e
moeda (`evaluateReference`). Isso significa que **não existe transação distribuída entre carteiras**: cada shard continua
impondo, sozinho, tudo o que a seção 1 lista (CHECKs, triggers do ledger, índice único de reversão, `FOR NO KEY UPDATE`).

```
 HTTP / SQS --> router (walletId -> shard lógico -> banco físico) --> shard N: wallets + wager_transactions
                  ^ tabela de rotas versionada                                 + ledger + inbox + outbox
 workers (consumidor, outbox, PENDING_REFERENCE) rodam POR SHARD; migrations rodam em CADA shard
```

* **Shards lógicos, não físicos.** Ex.: 1 024 shards lógicos mapeados para N bancos. Mover carga é trocar o mapa, não
  rehashear.
* **Roteamento sem consulta.** O `walletId` carrega o shard lógico (ex.: UUID v7 em que os primeiros bits aleatórios são
  o id do shard). Isso resolve também a nota de localidade de índice do UUID v4 (§15). A **criação** de carteira roteia por
  `hash(playerId)`, para manter `UNIQUE (player_id, currency)` dentro de um único shard.
* **Mensageria.** `MessageGroupId = walletId` já garante a ordem por carteira; o consumidor roteia pelo `walletId` do
  corpo, então duplicatas da mesma `messageId` caem sempre na mesma inbox. Filas por shard (ou grupo de shards) isolam
  vizinhos barulhentos; conferir as cotas de vazão do SQS FIFO vigentes antes de dimensionar.
* **Outbox por shard**, com `seq` próprio: **não há ordem global de eventos** (só por carteira, como hoje). Consumidores
  continuam deduplicando por `eventId`.
* **Leitura agregada.** Listagem global, totais por status, reconciliação em massa e o back office deixam de ser uma
  consulta única: alimentar um *read model* (CDC para um banco de relatórios) em vez de fazer *scatter-gather*.

**O problema difícil: idempotência global.** Hoje `UNIQUE (provider_id, external_transaction_id)` e `UNIQUE
(idempotency_key)` são globais, e reenviar o mesmo id externo com **outra carteira** dá `409`. Com sharding por carteira
essa duplicata cairia em outro shard e passaria. Opções, da mais barata à mais forte:

1. **Contrato:** o id externo é único por `(provedor, carteira)`; combinar com os provedores e documentar. Detecção
   residual por auditoria assíncrona (CDC) com alerta.
2. **Registro global de idempotência** (KV com *put* condicional, ou tabela mínima própria) consultado antes de rotear.
   Preserva o `409`, mas adiciona um salto e um componente crítico (precisa de HA).

**Ferramentas.** O desenho é amigável a *sharding* de aplicação sobre PostgreSQL comum (o que mais preserva o que já foi
provado). Citus exige que índices únicos incluam a coluna de distribuição, o que reabre exatamente a questão acima. Motores
SQL distribuídos mudam isolamento e locking; o projeto depende de **triggers** (ledger imutável, consistência
saldo × ledger *deferred*), CHECKs, índice único parcial e `FOR NO KEY UPDATE`: validar cada um antes de adotar qualquer
motor, e repetir as suítes de concorrência e SIGKILL (seção 13) contra ele.

**Resharding (mover um shard lógico).** (1) marcar o shard como *draining*: requisições recebem `503 + Retry-After` e
mensagens SQS não são confirmadas, ambos já seguros pela taxonomia de erros transitórios; (2) esperar as transações em
voo; (3) copiar (replicação lógica ou dump); (4) validar com `ReconcileWalletUseCase` e *checksums* do ledger; (5) trocar
a rota; (6) manter a origem somente leitura por um período antes de apagá-la.

**O que sharding NÃO resolve:** uma carteira é um único shard, então o limite de ~286 req/s por carteira continua (17.3).
Também introduz custo operacional real: migrations em N bancos (padrão *expand/contract* e política de versões
convivendo), backup e PITR por shard, e monitoramento por shard. **Se algum dia surgir transferência entre carteiras ou
bônus entre jogadores, deixa de valer "sem transação distribuída"** e é preciso uma saga com ledger de compensação.

### 17.3 Carteira quente: *group commit*

O teto de uma carteira é a serialização do commit. Como o consumidor SQS já recebe em ordem por `MessageGroupId`, v2 pode
aplicar **várias transações da mesma carteira em uma só transação SQL** (um lock, um `UPDATE` de saldo, N lançamentos de
ledger, um `COMMIT`), mantendo **uma linha de ledger e um resultado por transação**. Cuidados: isolamento por *savepoint*
para que uma rejeição ou mensagem venenosa não derrube as vizinhas do lote, tamanho máximo de lote e invariantes
validadas pelas mesmas suítes de concorrência. O caminho HTTP fica como está (uma por requisição).

### 17.4 Ciclo de vida dos dados

* Particionar `wallet_ledger_entries`, `wager_transactions`, `outbox_messages` e `inbox_messages` por mês (ex.:
  `pg_partman`); arquivar partições antigas em armazenamento frio (S3/Parquet) e manter retenção de **inbox** (janela de
  deduplicação) e de **outbox publicado**.
* **Tensão a resolver antes:** em tabela particionada, índice único precisa conter a chave de partição, e hoje
  `idempotency_key` e `(provider, external id)` são únicos globalmente. Alternativas: janela de idempotência por tempo
  (único por partição + registro global curto) ou o registro de idempotência de 17.2.
* O ledger é protegido por triggers contra `UPDATE/DELETE/TRUNCATE`; destacar partição para arquivar exige um **papel de
  manutenção** explícito e auditado, sem afrouxar o papel da aplicação.

### 17.5 Eventos

* Trocar o publisher por polling por **CDC** (replicação lógica, ex.: Debezium) mantendo a tabela outbox como contrato:
  menos latência e sem o publisher como gargalo. Mantém *at-least-once* e `eventId` estável.
* Registro de esquema e versionamento dos eventos (hoje o tipo e a versão vão no nome da classe).
* DLQ de eventos e **ferramenta de reprocesso** (listar, inspecionar `reason`, reenviar ou descartar com auditoria).

### 17.6 Segurança e auditoria

* Autenticação real (OIDC/JWT validado no JWKS; `azp` → `providerId` imposto contra o payload), *rate limit* e limites por
  provedor, mTLS opcional; segredos em gerenciador de segredos, não em variáveis de ambiente em texto.
* **Auditoria de ações de operador:** hoje o `retry` do back office é um `UPDATE` sem trilha. Criar `operator_actions`
  (quem, quando, o quê, correlação), de escrita única como o ledger.
* Ledger com **encadeamento de hash** (cada lançamento inclui o hash do anterior) se a regulação pedir evidência de
  adulteração além das travas do banco.

### 17.7 Observabilidade e operação

* Métricas **agregadas** (Prometheus raspando todas as instâncias; hoje são por instância), painéis e alertas/SLOs:
  atraso do outbox, backlog de `PENDING_REFERENCE`, profundidade das DLQs, `wallet_lock_conflicts_total` com *timeout*,
  taxa de `503`, divergência na reconciliação.
* Tracing distribuído (OpenTelemetry) reaproveitando o `X-Correlation-Id` que já atravessa HTTP, SQS e logs.
* **Reconciliação contínua:** worker agendado, com *checkpoints* de saldo periódicos para não reler o ledger inteiro da
  carteira; divergência vira métrica e alerta, continua sem correção automática.
* HA e recuperação: failover do PostgreSQL (Patroni/gerenciado), backups com PITR e RPO/RTO definidos, ensaios de
  restauração. Multi-região ativo-ativo só com carteira "pertencendo" a uma região (sharding por região); fora disso,
  DR ativo-passivo.

### 17.8 Back office v2

Hoje é um MVP (seção 16; detalhes em [`backoffice.md`](./backoffice.md)). Evoluções: login e papéis (SSO, perfil só-leitura × operador); papel de banco **somente leitura**
para consultas e um papel estreito só para o reagendamento; paginação por *keyset* (o `offset` degrada em tabelas
grandes); consultas em réplica ou no *read model*; atualização automática da tela; visão de carteira (saldo, ledger,
reconciliação); inspeção e *redrive* de DLQ; exportação CSV; todas as ações registradas em `operator_actions`.

### 17.9 Modelo de dinheiro

`Money` é decimal exato com **escala fixa 2** (`numeric(19,2)`), o que não cobre moedas com 0 ou 3 casas nem ativos
cripto. v2: valor em **unidades mínimas** (inteiro) + expoente da moeda, com tabela de moedas. Câmbio, se houver, fica
fora do ledger de carteira (carteira continua mono-moeda).

### 17.10 Qualidade e entrega

* CI com PostgreSQL e **LocalStack reais** (integração do consumidor hoje usa fila em memória, §15), e o E2E como etapa.
* Testes de caos no compose (derrubar PostgreSQL ou LocalStack no meio da carga) e carga HTTP/SQS em ambiente dedicado,
  com PostgreSQL ajustado, para substituir o número indicativo da seção 14.
* OpenAPI gerado e testes de contrato com os provedores; política de versionamento da API e dos eventos.
* IaC e orquestração (HPA por profundidade de fila e por atraso do outbox).

### 17.11 Priorização

| Prioridade | Itens | Gatilho |
|---|---|---|
| **P1: antes de produção** | autenticação real + *rate limit*; auditoria de operador; métricas agregadas e alertas; PgBouncer; backup/PITR; CI com LocalStack | go-live |
| **P2: crescimento** | réplica de leitura; particionamento e retenção; *group commit*; DLQ com ferramenta de reprocesso; back office v2; reconciliação contínua; dinheiro em unidades mínimas | tabelas grandes, carteira quente real, operação diária |
| **P3: escala ou regulação** | **sharding por carteira** + registro de idempotência; CDC; multi-região; ledger com hash encadeado | primário no teto da maior instância viável (CPU, IOPS, WAL ou tamanho), ou exigência regulatória |

Para decidir o gatilho de sharding, acompanhar no primário: taxa de commits e latência de commit, saturação de
IOPS/WAL, tempo de *autovacuum* e tamanho de tabelas/índices, e `wallet_lock_conflicts_total`. Se o gargalo for **uma**
carteira, sharding não ajuda: é o caso de 17.3.
