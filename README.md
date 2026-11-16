# Distributed Wagering Processor

Processador de apostas distribuído: recebe transações de provedores de jogos por **HTTP** e por **SQS**, aplica-as com
**idempotência persistente**, **segurança sob concorrência** (carteira quente, N instâncias) e **ledger auditável**, e
publica eventos por **outbox transacional**.

**Stack:** Bun 1.x · TypeScript estrito · NestJS · PostgreSQL 16 · MikroORM (pool/transação) · AWS SQS (LocalStack) ·
Docker Compose · migrations SQL versionadas e reversíveis.

> **Estado de verificação:** **317 testes executados e passando** contra PostgreSQL 16 real (179 unitários, 121 de
> integração, 17 de concorrência), a stack Docker Compose (3 instâncias + PostgreSQL + LocalStack) sobe saudável e os
> **10 testes E2E** (HTTP e SQS reais) passam. Depois dessa execução foram acrescentados 3 testes unitários da trava de
> banco de teste (`test/unit/test-database-guard.test.ts`; lógica validada em Node, suíte ainda não executada no Bun), por
> isso `test:unit` agora lista 182. O que **não** é coberto está em
> [`ARCHITECTURE.md` §15](./ARCHITECTURE.md#15-limitações-riscos-e-o-que-não-foi-verificado). Se algo falhar no seu
> ambiente, veja [Solução de problemas](#solução-de-problemas).

Decisões, trade-offs, taxonomia de falhas, máquina de estados e interpretações de regra: **[`ARCHITECTURE.md`](./ARCHITECTURE.md)**.

## Requisitos

* [Bun](https://bun.sh) 1.x
* Docker + Docker Compose (para a stack completa)
* PostgreSQL 16 acessível (só para rodar os testes sem Docker)

Instalar o Bun no Linux/WSL (o instalador precisa de `unzip` e `curl`):

```bash
sudo apt update && sudo apt install -y unzip curl
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc && bun --version
```

No Windows, use o WSL e o Docker Desktop com *Settings → Resources → WSL Integration* ativado para a sua distro.

## Subir tudo (Docker Compose)

```bash
bun install                                    # gera bun.lock (commite-o)
chmod +x infra/localstack/init-queues.sh       # ver a nota abaixo
docker compose up --build -d                   # PostgreSQL + LocalStack(SQS) + migrations + 3 instâncias da aplicação
docker compose ps                              # postgres, localstack e app-1..3 devem ficar "healthy"
```

> **O `init-queues.sh` precisa ser executável.** O LocalStack só roda scripts de `ready.d` com permissão de execução.
> Ao baixar o projeto como `.zip` (ou em alguns clones no Windows) esse bit se perde, as filas não são criadas e o
> `localstack` nunca fica `healthy` (`dependency failed to start: container ...-localstack-1 is unhealthy`). Para
> versionar a permissão: `git update-index --chmod=+x infra/localstack/init-queues.sh`.

Sobem: `postgres`, `localstack` (cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`),
`migrate` (one-shot, como dono do schema) e **`app-1`, `app-2`, `app-3`** em `localhost:3001`, `3002` e `3003`. A
aplicação conecta como `wagering_app`, um role que **não pode** `UPDATE`/`DELETE` o ledger. Cada instância executa a
API, o consumidor SQS, o publisher do outbox e o worker de `PENDING_REFERENCE`, todos seguros com qualquer número de
instâncias. Derrubar: `docker compose down -v`.

> LocalStack está fixado em `3.8.1` (sem token). Para usar MiniStack, aponte `SQS_ENDPOINT` e crie as mesmas filas com
> `infra/localstack/init-queues.sh` (são chamadas `aws sqs` comuns).

## Rodar localmente (sem Docker para a aplicação)

```bash
docker compose up -d postgres localstack   # dependências (o compose mapeia 5432 e 4566)
cp .env.example .env                       # valores prontos para essa combinação; veja o aviso abaixo
bun run migration:up                       # aplica as migrations (usa MIGRATION_DATABASE_URL = dono do schema)
bun run start                              # exige DATABASE_URL e as filas SQS acessíveis
bun run migration:down                     # reverte 1 migration (use `... down all` para todas)
bun src/cli/migrate.ts status
```

> **O Bun carrega o `.env` automaticamente, inclusive em `bun test`.** Por isso os testes **não** leem `DATABASE_URL`
> (a da aplicação): usam `TEST_DATABASE_URL` (padrão `.../wagering_test`) e **recusam** resetar um banco cujo nome não
> termine em `_test`. Copiar o `.env.example` não afeta os testes (veja a seção seguinte).

## Testes

```bash
bun run test:unit              # 182 testes, sem dependências externas
bun run test:integration       # 121 testes, PostgreSQL REAL (TEST_DATABASE_URL)
bun run test:concurrency       # 17 testes, paralelismo real + 3 processos OS
bun run test:all               # as três suítes acima
bun run test:e2e               # stack completa (ver abaixo)
bun run test:load              # teste de carga (bônus)
```

Os testes de integração/concorrência usam um banco **descartável** (`TEST_DATABASE_URL`, padrão
`postgres://wagering:wagering@127.0.0.1:5432/wagering_test`) e **recriam o schema** a cada teste. Nunca aponte para um
banco com dados. O jeito mais simples é reaproveitar o PostgreSQL do compose:

```bash
docker compose up -d postgres
docker compose exec postgres createdb -U wagering wagering_test
```

Ou, com um PostgreSQL local: `createdb wagering_test` (usuário `wagering`, superuser, senha `wagering`).

Para usar outro banco, defina `TEST_DATABASE_URL` (o nome **deve terminar em `_test`**; a trava existe porque os testes
fazem `DROP SCHEMA`; `ALLOW_TEST_DB_RESET=1` a desativa):

```bash
export TEST_DATABASE_URL=postgres://wagering:wagering@127.0.0.1:5432/wagering_test
bun run test:integration
```

**E2E** (precisa da stack no ar; é pulado se `E2E_BASE_URLS` não existir):

```bash
docker compose up --build -d
E2E_BASE_URLS=http://localhost:3001,http://localhost:3002,http://localhost:3003 \
SQS_ENDPOINT=http://localhost:4566 bun run test:e2e
```

**Carga:** `bun run test:load` (ver `ARCHITECTURE.md` §14; variáveis `DURATION_S`, `CONCURRENCY`, `WALLETS`,
`HOT_RATIO`, `DUP_RATIO`). Mede o núcleo + PostgreSQL real, **sem** HTTP/SQS; recria o schema.

## Back office

Painel operacional (MVP) em [`backoffice/`](./backoffice). **Guia completo (uso, API, por que não tem senha, testes): [`backoffice.md`](./backoffice.md).**
É um serviço à parte, **sem dependências npm** (Bun serve a API
e uma página HTML única). Lê o PostgreSQL diretamente e chama a API de apostas só para reconciliação e métricas.

```bash
docker compose --profile backoffice up --build -d   # opt-in: não sobe com `docker compose up` padrão
                                                     # (ou: bun run backoffice:up; para derrubar: bun run compose:down)
open http://localhost:4000            # ou: bun run backoffice:start (fora do Docker; veja .env.example)
```

| Função | Como |
|---|---|
| Totais por status | `GET /api/summary` |
| Listar e filtrar transações (`status`, `kind`, `providerId`, `walletId`, `limit`, `offset`) | `GET /api/transactions` |
| **Reprocessar agora** uma transação `PENDING_REFERENCE` | `POST /api/transactions/{id}/retry` |
| Reconciliar uma carteira (somente leitura) | `POST /api/wallets/{id}/reconciliation` (repassa à API) |
| Conflitos de lock por carteira, somando as instâncias | `GET /api/sre/lock-conflicts` (lê `/metrics`) |

* **"Reprocessar" não movimenta dinheiro.** Apenas marca a transação como devida agora; o worker de
  `PENDING_REFERENCE` a executa pelo mesmo caso de uso de uma requisição nova (idempotência, orçamento de tentativas e
  TTL continuam valendo). Transações terminais respondem `409`, pois o banco as protege contra alteração.
* **Acesso e senha:** o painel **não tem login de usuário**; o compose publica a porta só em `127.0.0.1` e
  `BACKOFFICE_TOKEN` (opcional) exige `Authorization: Bearer <token>` em `/api/*`. Sem ele, a API do painel fica aberta:
  só para desenvolvimento. Motivos e riscos em [`backoffice.md` §2](./backoffice.md#2-por-que-não-tem-senha-e-o-que-existe-no-lugar).
* **Testes:** `bun run test:backoffice` (unitários + integração contra o PostgreSQL de teste, com a API simulada).
  Ficam **fora** do `bun run test:all` e o serviço é opt-in no compose: o enunciado não pede back office, então ele não
  pode afetar a stack e a suíte padrão (ver o estado de verificação em `backoffice.md`).
* **Limites do MVP:** paginação por `offset`, sem login de usuários, sem atualização automática da tela, e o painel
  conecta com o role da aplicação (`wagering_app`).

## Roadmap v2

O que fica para a v2 (sharding SQL por carteira, *group commit* para carteira quente, particionamento e retenção, CDC no
outbox, autenticação real, auditoria de operador, observabilidade agregada, back office v2 e priorização) está em
[`ARCHITECTURE.md` §17](./ARCHITECTURE.md#17-roadmap-v2-escala-sharding-e-evolução-da-arquitetura).

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `bun: command not found` | Bun não instalado ou fora do `PATH` | Seguir [Requisitos](#requisitos) e abrir um novo terminal |
| `dependency failed to start: container wagering-localstack-1 is unhealthy` | `init-queues.sh` sem permissão de execução: filas não criadas | `chmod +x infra/localstack/init-queues.sh && docker compose down -v && docker compose up --build -d` |
| `docker: permission denied ... docker.sock` | Usuário fora do grupo `docker` | `sudo usermod -aG docker $USER` e reabrir o terminal |
| `Refusing to reset database "..."` ao rodar testes | `TEST_DATABASE_URL` aponta para um banco que não termina em `_test` | Usar `.../wagering_test` (padrão) ou, sabendo o que faz, `ALLOW_TEST_DB_RESET=1` |
| `database "wagering_test" does not exist` | Banco de teste não criado | `docker compose exec postgres createdb -U wagering wagering_test` |
| Painel em `localhost:4000` responde 401 | `BACKOFFICE_TOKEN` definido | Informar o token no campo do topo da página |
| E2E mostra todos os testes como pulados | `E2E_BASE_URLS` ausente | Definir a variável, como na seção [Testes](#testes) |
| Dúvida sobre o estado das filas | | `docker compose exec localstack awslocal sqs list-queues` e `docker compose logs localstack` |

## API

| Método e caminho | Descrição | Sucesso |
|---|---|---|
| `POST /wallets` | cria carteira (`playerId`, `initialBalance`) | `201` |
| `GET /wallets/{id}` | saldo e versão | `200` |
| `GET /wallets/{id}/ledger?limit=&cursor=` | ledger paginado por cursor opaco | `200` |
| `POST /wagering/transactions` | submete uma transação (header `Idempotency-Key`) | `200` · `202` · `422` |
| `GET /wagering/transactions/{id}` | transação por id interno | `200` |
| `GET /providers/{providerId}/wagering/transactions/{externalId}` | por id do provedor | `200` |
| `POST /wallets/{id}/reconciliation` | compara saldo com o ledger (somente leitura) | `200` |
| `GET /health/live` · `GET /health/ready` · `GET /metrics` | liveness · readiness · Prometheus | `200` |

Status: `200` aplicada (inclui replay) · `202` `PENDING_REFERENCE` (aguardando a referência; consulte, não reenvie) ·
`400` payload inválido · `404` inexistente · `409` conflito de idempotência · `422` rejeição de negócio (com `failureCode`)
· `503` + `Retry-After` falha transitória (reenviar a **mesma** requisição é seguro). Dinheiro é sempre **string decimal**
(`"25.00"`), nunca número.

```bash
# criar carteira
curl -s localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"11111111-1111-4111-8111-111111111111","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# apostar (use o id devolvido acima em walletId)
curl -s localhost:3002/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-0001' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-0001",
       "playerId":"11111111-1111-4111-8111-111111111111","walletId":"<WALLET_ID>",
       "roundId":"round-1","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"30.00","currency":"BRL"}}'
```

Reenviar o comando acima (em qualquer instância) devolve o mesmo resultado com `"idempotentReplay": true` e **não**
debita de novo. Com o mesmo `Idempotency-Key` e outro valor, a resposta é `409`.

### Mensagem SQS (`wager-transactions.fifo`)

`MessageGroupId = walletId`. Corpo:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "idempotencyKey": "provider-a:bet-0001", "providerId": "provider-a", "externalTransactionId": "bet-0001",
            "playerId": "…", "walletId": "…", "roundId": "round-1", "gameId": "fortune-chimp",
            "kind": "BET", "money": { "amount": "30.00", "currency": "BRL" } } }
```

Mensagens inválidas (JSON quebrado, `OPENING`, carteira inexistente, conflito de idempotência) vão **direto para a DLQ**
com o atributo `reason`; falhas transitórias são reentregues com backoff; após 5 tentativas vão para a DLQ.

## Estrutura

```
src/domain/          regras puras: Money, Wallet, WagerTransaction, ledger, settle(), eventos (sem framework/ORM)
src/application/     caso de uso único (HTTP+SQS), portas, parsers, workers (consumidor, outbox, referência)
src/infrastructure/  SQL dos repositórios, MikroORM (UoW), migrator, SQS, logs JSON, métricas Prometheus
src/interfaces/http/ controllers NestJS finos, mapeamento HTTP, AuthGuard no-op, health
migrations/sql/      NNNN_nome.up.sql / .down.sql (reversíveis)
backoffice/          painel operacional e de SRE (serviço Bun separado; ver backoffice.md)
infra/               init do LocalStack (filas) e do PostgreSQL (role de aplicação)
test/                unit · integration · concurrency · e2e · helpers
docs/load-test/      relatórios do teste de carga
```

## Configuração

Todas as variáveis estão documentadas em [`.env.example`](./.env.example) e são validadas na partida: a aplicação falha
rápido listando **todos** os problemas de uma vez. Só `DATABASE_URL` é obrigatória.

| Grupo | Variáveis (padrão) |
|---|---|
| HTTP | `PORT` (3000), `LOG_LEVEL` (info) |
| PostgreSQL | `DATABASE_URL` (obrigatória), `MIGRATION_DATABASE_URL`, `DB_POOL_MIN` (2), `DB_POOL_MAX` (20), `DB_LOCK_TIMEOUT_MS` (5000), `DB_STATEMENT_TIMEOUT_MS` (30000), `MIGRATIONS_DIR` |
| AWS / SQS | `AWS_REGION` (us-east-1), `SQS_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SQS_QUEUE_TRANSACTIONS`, `SQS_QUEUE_TRANSACTIONS_DLQ`, `SQS_QUEUE_EVENTS` |
| Papéis da instância | `ROLE_CONSUMER`, `ROLE_OUTBOX_PUBLISHER`, `ROLE_PENDING_REFERENCE` (todos `true`) |
| Consumidor | `CONSUMER_MAX_RECEIVE_COUNT` (5, deve ser < 10), `CONSUMER_POLLERS` (2), `CONSUMER_BATCH_SIZE` (10), `CONSUMER_WAIT_SECONDS` (20), `SHUTDOWN_TIMEOUT_MS` (25000) |
| Referência pendente | `REFERENCE_MAX_ATTEMPTS` (10), `REFERENCE_TTL_MS` (900000), `REFERENCE_BASE_DELAY_MS` (2000), `REFERENCE_MAX_DELAY_MS` (120000) |
| Testes e carga | `TEST_DATABASE_URL`, `ALLOW_TEST_DB_RESET`, `E2E_BASE_URLS`, `DURATION_S`, `CONCURRENCY`, `WALLETS`, `HOT_RATIO`, `DUP_RATIO`, `OUT`, `LOAD_TEST_ALLOW_RESET` |
