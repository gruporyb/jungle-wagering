# Back Office (MVP)

Painel operacional e de SRE do Distributed Wagering Processor. Código em [`backoffice/`](./backoffice); contexto de
arquitetura em [`ARCHITECTURE.md` §16](./ARCHITECTURE.md#16-bônus-mvp-do-back-office-operacional-e-sre) e evolução em
[§17.8](./ARCHITECTURE.md#17-roadmap-v2-escala-sharding-e-evolução-da-arquitetura).

> **Estado de verificação:** a lógica (validação de filtros, SQL parametrizado, leitura de métricas, roteamento,
> autenticação por token e erros do handler) foi exercitada num teste de fumaça sob Node, com banco simulado. As suítes
> do Bun (`bun run test:backoffice`), que usam PostgreSQL real, foram escritas num ambiente **sem Bun nem PostgreSQL** e
> precisam ser executadas por você antes de confiar nelas. Por isso o serviço é **opt-in** no compose (`--profile
> backoffice`) e a suíte fica **fora** do `bun run test:all`. Se algo falhar, veja [Solução de problemas](#solução-de-problemas).

## 1. O que é

Um serviço **separado da API**, sem dependências npm (o Bun já traz o servidor HTTP e o driver SQL), que serve uma página
HTML única e uma API JSON em `/api/*`.

```
 navegador ──> backoffice (Bun, :4000) ──┬─> PostgreSQL ........ SELECT (listar, totais) + 1 UPDATE (reagendar)
                                         └─> API de apostas .... POST /wallets/{id}/reconciliation e GET /metrics
```

| Função | O que faz |
|---|---|
| Totais por status | Quantas transações em `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| Listagem e filtros | Por status, tipo, provedor e carteira, paginada, mais recentes primeiro |
| **Reprocessar agora** | Antecipa o reprocessamento de uma transação `PENDING_REFERENCE` |
| Reconciliação de carteira | Compara saldo armazenado × ledger (somente leitura, feito pela API) |
| SRE: conflitos de lock | `wallet_lock_conflicts_total` (`waited` e `timeout`) de cada instância da API, somado |

## 2. Por que não tem senha (e o que existe no lugar)

O painel **não tem login de usuário e senha**. Por padrão ele também **não exige nada**: só se você definir
`BACKOFFICE_TOKEN` é que `/api/*` passa a exigir `Authorization: Bearer <token>`. Isso é uma decisão de escopo de MVP, não
uma recomendação para produção. Os motivos:

1. **Coerência com o resto do projeto.** A autenticação da própria API é um *ponto de extensão declarado* (`AuthGuard`
   no-op, ver `src/interfaces/http/auth.ts` e `ARCHITECTURE.md` §12): o projeto "não armazena usuários nem senhas". Um painel
   com senha ao lado de uma API aberta protegeria pouco e daria falsa sensação de segurança.
2. **Código de credenciais é sensível e não deve ser improvisado.** Senha própria exige hash, política de senha, proteção
   contra força bruta, sessão, recuperação e rotação. O caminho certo é delegar a um provedor de identidade (OIDC/SSO), que
   é o que o roadmap prevê (§17.6 e §17.8), e não escrever isso à mão num MVP.
3. **O dano possível já é limitado por desenho.** O painel só consegue ler e executar **um** `UPDATE`
   (`reference_next_attempt_at = now()`, restrito a `status = 'PENDING_REFERENCE'`). Ele não escreve em saldo nem em ledger;
   transações finalizadas e o ledger são protegidos por triggers do banco e respondem `409` ou erro; e o reprocessamento
   passa pelo mesmo caso de uso de uma requisição normal (idempotência, orçamento de tentativas e TTL).

**Controles que existem hoje**

* Porta publicada só em `127.0.0.1` no compose (acessível apenas da própria máquina).
* Token opcional, comparado em tempo constante; `/health` e a página ficam abertos, `/api/*` não.
* Todas as consultas são parametrizadas e os filtros são validados contra listas fechadas (testado com tentativa de injeção).
* A página monta o DOM com `textContent` (sem `innerHTML` com dados do banco).

**Riscos reais, sem token ou com o token atual**

* Sem token, quem alcançar `:4000` vê dados sensíveis (`playerId`, `walletId`, valores) e pode reagendar transações.
* **Não há identificação de quem fez o quê:** o reagendamento não deixa trilha de auditoria (`operator_actions` está no §17.6).
* O token é um segredo compartilhado, trafega em cabeçalho (use TLS em qualquer ambiente real), fica em `sessionStorage` no
  navegador e não há limite de tentativas.
* O painel conecta ao banco com o role da aplicação (`wagering_app`), e não com um role mínimo próprio.

**Regra prática:** em máquina local, tudo bem sem token. Em qualquer ambiente compartilhado, defina `BACKOFFICE_TOKEN`
**e** coloque o painel atrás de TLS e de um proxy autenticado (SSO). Para produção, implemente o §17.8 (login, papéis,
auditoria, papel de banco somente leitura).

## 3. Como subir

**Docker Compose** (recomendado): o serviço `backoffice` está no `docker-compose.yml` sob o *profile* `backoffice`, ou
seja, **não sobe** com o `docker compose up` padrão.

```bash
chmod +x infra/localstack/init-queues.sh     # só se o bit de execução se perdeu
docker compose --profile backoffice up --build -d     # ou: bun run backoffice:up
docker compose --profile backoffice ps       # backoffice: Up, 127.0.0.1:4000->4000
curl -s localhost:4000/health                # {"status":"ok"}
```

Abra **http://localhost:4000**. Para exigir token, crie/edite o `.env` ao lado do compose e suba de novo:

```bash
echo 'BACKOFFICE_TOKEN=troque-este-segredo' >> .env
docker compose --profile backoffice up -d backoffice
```

Para derrubar tudo, inclusive o painel: `docker compose --profile backoffice down -v` (ou `bun run compose:down`). Sem o
`--profile`, o `down` não remove o container do painel e a rede pode ficar em uso.

**Sem Docker para o painel** (Postgres e API já no ar; pare antes o container para liberar a porta):

```bash
docker compose stop backoffice
DATABASE_URL=postgres://wagering_app:wagering_app@localhost:5432/wagering \
API_BASE_URLS=http://localhost:3001,http://localhost:3002,http://localhost:3003 \
bun run backoffice:start
```

## 4. Como usar

### 4.1 Gerar dados para ver no painel

```bash
PLAYER=$(cat /proc/sys/kernel/random/uuid)
WALLET=$(curl -s localhost:3001/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "$WALLET"

tx() {  # uso: tx <idExterno> <tipo> <valor> [idExternoReferenciado]
  curl -s -w ' -> HTTP %{http_code}\n' localhost:3002/wagering/transactions \
    -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$1" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"$2\",\"money\":{\"amount\":\"$3\",\"currency\":\"BRL\"}${4:+,\"referenceExternalTransactionId\":\"$4\"}}"
}

tx bet-1 BET 30.00                 # 200: processada
tx bet-2 BET 500.00                # 422: rejeitada (saldo insuficiente)
tx refund-1 REFUND 10.00 bet-3     # 202: parada em PENDING_REFERENCE (a bet-3 ainda não chegou)
```

### 4.2 Na tela

1. **Atualizar** recarrega totais, tabela e métricas. Os cartões de status são atalhos de filtro.
2. **Filtros:** status, tipo, `providerId` e `walletId`; **Filtrar** aplica e volta à primeira página.
3. **Reprocessar agora** aparece só nas linhas `PENDING_REFERENCE`. Para ver o efeito completo, envie a aposta que faltava e
   clique no botão do REFUND:

   ```bash
   tx bet-3 BET 10.00
   ```

   O REFUND passa a `PROCESSED` em instantes (o worker o executa; sem o botão, ele esperaria o backoff).
4. **Reconciliação:** cole o `walletId` e clique em **Reconciliar**. O resultado traz saldo armazenado, calculado,
   diferença e `consistent`. Divergência é reportada, nunca corrigida.
5. **SRE:** total e por instância de conflitos de lock; uma instância fora do ar aparece com o erro, sem derrubar o resto.
6. Se `BACKOFFICE_TOKEN` estiver definido, informe-o no campo do topo.

### 4.3 API do painel

Com token, acrescente `-H "Authorization: Bearer $TOKEN"` aos exemplos.

| Rota | Respostas |
|---|---|
| `GET /health` | `200` (aberta) |
| `GET /api/summary` | `200 {total, byStatus}` · `401` |
| `GET /api/transactions?status=&kind=&providerId=&walletId=&limit=&offset=` | `200 {items, limit, offset, hasMore}` · `400` filtro inválido · `401` |
| `POST /api/transactions/{id}/retry` | `200` agendada · `400` id malformado · `404` inexistente · `409` não é `PENDING_REFERENCE` · `401` |
| `POST /api/wallets/{id}/reconciliation` | status e corpo da API · `400` · `502` API fora do ar · `503` nenhuma instância configurada · `401` |
| `GET /api/sre/lock-conflicts` | `200 {total, instances[]}` · `401` |

`limit` vai de 1 a 200 (padrão 50); `offset` de 0 a 100 000. Valores fora de lista (`status`, `kind`) ou UUID malformado
retornam `400`.

```bash
curl -s 'localhost:4000/api/summary'
curl -s 'localhost:4000/api/transactions?status=PENDING_REFERENCE&limit=10'
curl -s -X POST "localhost:4000/api/wallets/$WALLET/reconciliation"
```

### 4.4 O que "reprocessar" faz (e não faz)

`POST /api/transactions/{id}/retry` executa apenas:

```sql
UPDATE wager_transactions SET reference_next_attempt_at = now()
 WHERE id = $1 AND status = 'PENDING_REFERENCE'
```

A transação fica **devida**; o worker de `PENDING_REFERENCE` (em qualquer instância) a processa pelo mesmo caso de uso de
uma requisição nova. Se a referência ainda não existir, ela continua parada e conta mais uma tentativa; se o prazo (TTL) ou
o limite de tentativas já tiver estourado, ela é rejeitada como de costume. O painel **não** aplica saldo, não escreve no
ledger e não ultrapassa o orçamento de tentativas.

## 5. Como testar

### 5.1 Automatizados

```bash
docker compose up -d postgres
docker compose exec postgres createdb -U wagering wagering_test     # uma vez
export TEST_DATABASE_URL=postgres://wagering:wagering@127.0.0.1:5432/wagering_test
bun run test:backoffice
```

`TEST_DATABASE_URL` precisa apontar para um banco **descartável** (nome terminado em `_test`, senão o teste se recusa a
rodar): os testes de integração recriam o schema. O `.env` não interfere, pois os testes não leem `DATABASE_URL`. Esta
suíte **não** faz parte do `bun run test:all`.

| Arquivo | Banco | O que cobre |
|---|---|---|
| `backoffice/test/query.test.ts` | não | Validação dos filtros (listas fechadas, UUID, limites), SQL 100 % parametrizado, valor hostil preso como parâmetro |
| `backoffice/test/prometheus.test.ts` | não | Leitura da métrica certa (sem casar prefixo), `waited`/`timeout`, métrica ausente = 0, valores malformados |
| `backoffice/test/handler.test.ts` | **PostgreSQL real** | Acesso (token, `/health`, 404), totais, filtros, paginação sem lacuna nem repetição, `400` e tentativa de injeção, reprocessamento ponta a ponta, reconciliação (repasse, 404, 502, id inválido), soma de métricas com instância caída |

Os testes de integração usam o banco real e as fixtures da suíte principal; a API de apostas é simulada (nenhuma rede).
O cenário central: REFUND parado → chega a BET → `retry` o torna devido → o worker aplica → saldo final `70.00` e 4
lançamentos no ledger; e o `retry` sozinho não altera saldo nem ledger.

### 5.2 Manual (com a stack no ar)

```bash
# 1) Sem token configurado: abre
curl -s -o /dev/null -w '%{http_code}\n' localhost:4000/api/summary                       # 200

# 2) Com BACKOFFICE_TOKEN definido e o serviço recriado: exige o token
curl -s -o /dev/null -w '%{http_code}\n' localhost:4000/api/summary                       # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer errado' localhost:4000/api/summary   # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" localhost:4000/api/summary   # 200

# 3) Validações
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:4000/api/transactions?status=APPLIED'              # 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4000/api/transactions/nope/retry            # 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4000/api/transactions/22222222-2222-4222-8222-222222222222/retry   # 404

# 4) Reprocessar uma transação já finalizada (use o id de uma PROCESSED): 409
ID=$(curl -s 'localhost:4000/api/transactions?status=PROCESSED&limit=1' | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s -w ' -> %{http_code}\n' -X POST "localhost:4000/api/transactions/$ID/retry"
```

## 6. Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | obrigatória | PostgreSQL (no compose: role `wagering_app`) |
| `API_BASE_URLS` (ou `API_BASE_URL`) | `http://localhost:3001` | Instâncias da API, separadas por vírgula; reconciliação usa a primeira, métricas usam todas |
| `BACKOFFICE_PORT` | `4000` | Porta do painel. **Não é `PORT`**, que é a da API |
| `BACKOFFICE_TOKEN` | vazio | Se definido, `/api/*` exige `Authorization: Bearer <token>` |

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `port is already allocated` na 4000 | Outro processo usa a porta | `docker ps`; pare o painel rodando via Bun ou mude o mapeamento |
| Tabela vazia com erro `relation ... does not exist` | Migrations não rodaram | `docker compose down -v && docker compose up --build -d` |
| Tudo responde `401` | `BACKOFFICE_TOKEN` definido | Informe o token no campo do topo ou nos cabeçalhos |
| Reconciliação responde `502` | Instância `app-1` indisponível | `docker compose ps`; `docker compose logs app-1` |
| SRE mostra `erro: HTTP ...` numa instância | Essa instância está fora ou sem `/metrics` | Verifique a instância; as outras continuam somadas |
| Painel não sobe fora do Docker | Porta 4000 ocupada pelo container | `docker compose stop backoffice` |
| `Refusing to reset database` | `TEST_DATABASE_URL` não termina em `_test` | Use `wagering_test`, como em 5.1 |

## 7. Limites do MVP

Paginação por `offset` (degrada em tabelas grandes), sem login de usuários nem papéis, sem trilha de auditoria das ações,
sem atualização automática da tela, conexão com o role da aplicação, sem visão de ledger por carteira nem ferramenta de DLQ.
Tudo isso está planejado no [§17.8](./ARCHITECTURE.md#17-roadmap-v2-escala-sharding-e-evolução-da-arquitetura).
