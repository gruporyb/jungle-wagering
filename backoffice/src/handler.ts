import { timingSafeEqual } from 'node:crypto';
import { lockConflicts } from './prometheus';
import { BadRequestError, STATUSES, buildListQuery, parseFilters, parseUuid } from './query';

/** The only thing the back office needs from the database driver (Bun's SQL satisfies it). */
export interface Db {
  unsafe(text: string, values?: any[]): PromiseLike<unknown>;
}
export type FetchFn = (url: string, init?: { method?: string }) => Promise<Response>;

export interface BackofficeDeps {
  db: Db;
  /** Base URLs of the wagering API instances (reconciliation goes to the first, metrics to all). */
  apiBaseUrls: string[];
  html: string;
  /** When set, every /api/* call needs `Authorization: Bearer <token>`. */
  token?: string;
  fetchFn?: FetchFn;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

function authorised(req: Request, token: string | undefined): boolean {
  if (!token) return true;
  const given = Buffer.from((req.headers.get('authorization') ?? '').replace(/^Bearer /i, ''));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const rows = (result: unknown): Record<string, any>[] => result as Record<string, any>[];

function toTransaction(row: Record<string, any>) {
  return {
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    failureCode: row.failure_code,
    observedBalance: row.observed_balance,
    referenceExternalTransactionId: row.reference_external_transaction_id,
    referenceAttempts: row.reference_attempts,
    referenceNextAttemptAt: row.reference_next_attempt_at,
    referenceDeadlineAt: row.reference_deadline_at,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

export function createHandler(deps: BackofficeDeps): (req: Request) => Promise<Response> {
  const fetchFn: FetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));

  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === '/health') return json(200, { status: 'ok' });
      if (path === '/' && req.method === 'GET') {
        return new Response(deps.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (!path.startsWith('/api/')) return json(404, { error: 'not found' });
      if (!authorised(req, deps.token)) return json(401, { error: 'unauthorized' });

      if (path === '/api/summary' && req.method === 'GET') {
        const found = rows(await deps.db.unsafe('SELECT status, count(*)::int AS count FROM wager_transactions GROUP BY status'));
        const byStatus: Record<string, number> = Object.fromEntries(STATUSES.map((status) => [status, 0]));
        for (const row of found) byStatus[row.status as string] = Number(row.count);
        return json(200, { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus });
      }

      if (path === '/api/transactions' && req.method === 'GET') {
        const filters = parseFilters(url.searchParams);
        const { text, values } = buildListQuery(filters);
        const found = rows(await deps.db.unsafe(text, values));
        return json(200, {
          items: found.slice(0, filters.limit).map(toTransaction),
          limit: filters.limit,
          offset: filters.offset,
          hasMore: found.length > filters.limit,
        });
      }

      // Manual reprocessing: make a parked transaction due NOW. The regular worker then runs it through the very
      // same settlement as a fresh request (retry budget, TTL and idempotency all still apply); no money moves here.
      const retry = /^\/api\/transactions\/([^/]+)\/retry$/.exec(path);
      if (retry && req.method === 'POST') {
        const id = parseUuid(retry[1] as string, 'transactionId');
        const updated = rows(
          await deps.db.unsafe(
            `UPDATE wager_transactions SET reference_next_attempt_at = now()
              WHERE id = $1::uuid AND status = 'PENDING_REFERENCE'
          RETURNING id, status, reference_attempts, reference_next_attempt_at`,
            [id],
          ),
        );
        if (updated[0]) {
          return json(200, { id, status: updated[0].status, referenceAttempts: updated[0].reference_attempts, referenceNextAttemptAt: updated[0].reference_next_attempt_at });
        }
        const existing = rows(await deps.db.unsafe('SELECT status FROM wager_transactions WHERE id = $1::uuid', [id]));
        if (!existing[0]) return json(404, { error: 'transaction not found' });
        return json(409, { error: `only PENDING_REFERENCE transactions can be retried (this one is ${existing[0].status})` });
      }

      const reconcile = /^\/api\/wallets\/([^/]+)\/reconciliation$/.exec(path);
      if (reconcile && req.method === 'POST') {
        const walletId = parseUuid(reconcile[1] as string, 'walletId');
        const base = deps.apiBaseUrls[0];
        if (!base) return json(503, { error: 'no API instance configured' });
        let upstream: Response;
        try {
          upstream = await fetchFn(`${base}/wallets/${walletId}/reconciliation`, { method: 'POST' });
        } catch {
          return json(502, { error: 'wagering API unreachable' });
        }
        return json(upstream.status, await upstream.json().catch(() => ({ error: 'invalid response from the wagering API' })));
      }

      if (path === '/api/sre/lock-conflicts' && req.method === 'GET') {
        const instances: { url: string; waited?: number; timeout?: number; error?: string }[] = [];
        for (const base of deps.apiBaseUrls) {
          try {
            const response = await fetchFn(`${base}/metrics`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            instances.push({ url: base, ...lockConflicts(await response.text()) });
          } catch (error) {
            instances.push({ url: base, error: error instanceof Error ? error.message : 'unreachable' });
          }
        }
        const total = { waited: 0, timeout: 0 };
        for (const item of instances) {
          total.waited += item.waited ?? 0;
          total.timeout += item.timeout ?? 0;
        }
        return json(200, { total, instances });
      }

      return json(404, { error: 'not found' });
    } catch (error) {
      if (error instanceof BadRequestError) return json(400, { error: error.message });
      console.error(JSON.stringify({ level: 'error', msg: 'backoffice request failed', path, error: error instanceof Error ? error.message : String(error) }));
      return json(500, { error: 'internal error' });
    }
  };
}
