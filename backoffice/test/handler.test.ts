import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { createHandler, type FetchFn } from '../src/handler';
import { connect, resetDatabase } from '../../test/helpers/db';
import { TestClock, balanceOf, createStack, ledgerCount, openWallet, submit, type Stack } from '../../test/helpers/fixtures';

/** Real PostgreSQL (same disposable test database as the other suites); the wagering API is faked. */
const TOKEN = 's3cret';
const API = ['http://api-1', 'http://api-2'];

let sql: SQL;
let stack: Stack;
let calls: { url: string; method?: string }[];
let upstream: (url: string) => Response | Promise<Response>;

const handler = () =>
  createHandler({
    db: sql,
    apiBaseUrls: API,
    html: '<html>backoffice</html>',
    token: TOKEN,
    fetchFn: (async (url, init) => {
      calls.push({ url, method: init?.method });
      return upstream(url);
    }) as FetchFn,
  });

const call = async (path: string, init: { method?: string; auth?: string | null } = {}) => {
  const headers: Record<string, string> = init.auth === null ? {} : { authorization: `Bearer ${init.auth ?? TOKEN}` };
  const response = await handler()(new Request(`http://backoffice${path}`, { method: init.method ?? 'GET', headers }));
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
};

/** A wallet with a processed BET (30), a rejected BET (insufficient funds) and a REFUND parked waiting for its BET. */
async function seed() {
  const wallet = await openWallet(stack, '100.00');
  const processed = await submit(stack, wallet, 'BET', '30.00');
  const rejected = await submit(stack, wallet, 'BET', '500.00');
  const parked = await submit(stack, wallet, 'REFUND', '10.00', { externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-late' });
  return { wallet, processed, rejected, parked };
}

beforeAll(() => {
  sql = connect(10);
});
afterAll(async () => {
  await sql.close();
});
beforeEach(async () => {
  await resetDatabase(sql);
  // one hour ahead of the database clock: whatever the back office makes due (now()) is due for the worker too
  stack = createStack(sql, { clock: new TestClock(new Date(Date.now() + 3_600_000)) });
  calls = [];
  upstream = () => Response.json({});
});

describe('access', () => {
  test('/health and the page are open; /api needs the bearer token', async () => {
    const open = handler();
    expect((await open(new Request('http://backoffice/health'))).status).toBe(200);
    const page = await open(new Request('http://backoffice/'));
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('backoffice');

    expect((await call('/api/summary', { auth: null })).status).toBe(401);
    expect((await call('/api/summary', { auth: 'wrong' })).status).toBe(401);
    expect((await call('/api/summary')).status).toBe(200);
  });

  test('without a configured token the API is open (local development)', async () => {
    const open = createHandler({ db: sql, apiBaseUrls: API, html: '' });
    expect((await open(new Request('http://backoffice/api/summary'))).status).toBe(200);
  });

  test('unknown routes are 404', async () => {
    expect((await call('/api/nope')).status).toBe(404);
    expect((await call('/elsewhere')).status).toBe(404);
  });
});

describe('summary and listing', () => {
  test('counts every status, including the ones with zero transactions', async () => {
    await seed();
    const { status, body } = await call('/api/summary');
    expect(status).toBe(200);
    // OPENING + the processed BET are PROCESSED
    expect(body.byStatus).toEqual({ PENDING: 0, PENDING_REFERENCE: 1, PROCESSED: 2, REJECTED: 1, FAILED: 0 });
    expect(body.total).toBe(4);
  });

  test('filters by status, kind, wallet and provider', async () => {
    const { wallet, rejected } = await seed();
    const other = await openWallet(stack, '50.00');
    await submit(stack, other, 'BET', '5.00', { providerId: 'provider-b' });

    const byStatus = await call('/api/transactions?status=REJECTED');
    expect(byStatus.body.items).toHaveLength(1);
    expect(byStatus.body.items[0]).toMatchObject({ externalTransactionId: rejected.command.externalTransactionId, status: 'REJECTED', amount: '500.00', kind: 'BET' });
    expect(byStatus.body.items[0].failureCode).toBeTruthy();

    expect((await call('/api/transactions?kind=REFUND')).body.items).toHaveLength(1);
    expect((await call(`/api/transactions?walletId=${wallet.id}`)).body.items).toHaveLength(4);
    expect((await call('/api/transactions?providerId=provider-b')).body.items).toHaveLength(1);
    expect((await call(`/api/transactions?walletId=${other.id}&status=REJECTED`)).body.items).toHaveLength(0);
  });

  test('pages in a stable order with no gaps or overlap, and reports hasMore', async () => {
    await seed();
    const first = await call('/api/transactions?limit=3');
    const second = await call('/api/transactions?limit=3&offset=3');
    expect(first.body.items).toHaveLength(3);
    expect(first.body.hasMore).toBe(true);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.hasMore).toBe(false);
    const ids = [...first.body.items, ...second.body.items].map((item: any) => item.id);
    expect(new Set(ids).size).toBe(4);
  });

  test('invalid filters are 400 and injection attempts never reach the database', async () => {
    expect((await call('/api/transactions?status=APPLIED')).status).toBe(400);
    expect((await call(`/api/transactions?status=${encodeURIComponent("PROCESSED' OR '1'='1")}`)).status).toBe(400);
    expect((await call('/api/transactions?limit=1000')).status).toBe(400);
    expect((await call('/api/transactions?walletId=abc')).status).toBe(400);
    const hostile = await call(`/api/transactions?providerId=${encodeURIComponent("x'; DROP TABLE wager_transactions; --")}`);
    expect(hostile.status).toBe(200);
    expect(hostile.body.items).toHaveLength(0);
    expect((await call('/api/summary')).status).toBe(200); // the table is still there
  });
});

describe('manual reprocessing (retry now)', () => {
  test('makes a parked transaction due, and the worker (not the back office) applies it once its BET exists', async () => {
    const { wallet, parked } = await seed(); // balance 70.00 after the processed BET of 30.00
    expect(parked.result.status).toBe('PENDING_REFERENCE');
    const parkedId = (await call('/api/transactions?status=PENDING_REFERENCE')).body.items[0].id as string;

    await submit(stack, wallet, 'BET', '10.00', { externalTransactionId: 'bet-late' }); // 60.00
    expect(await stack.pendingWorker.drainOnce()).toBe(0); // backoff: not due yet

    const retried = await call(`/api/transactions/${parkedId}/retry`, { method: 'POST' });
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('PENDING_REFERENCE');
    const due = (await sql.unsafe('SELECT reference_next_attempt_at <= now() AS due FROM wager_transactions WHERE id = $1', [parkedId])) as any[];
    expect(due[0].due).toBe(true);

    expect(await stack.pendingWorker.drainOnce()).toBe(1);
    expect((await call('/api/transactions?kind=REFUND')).body.items[0].status).toBe('PROCESSED');
    expect(await balanceOf(sql, wallet.id)).toBe('70.00'); // 60.00 + the 10.00 REFUND
    expect(await ledgerCount(sql, wallet.id)).toBe(4); // opening, BET 30, BET 10, REFUND
  });

  test('the retry itself never touches balance or ledger', async () => {
    const { wallet } = await seed();
    const parkedId = (await call('/api/transactions?status=PENDING_REFERENCE')).body.items[0].id as string;
    const before = { balance: await balanceOf(sql, wallet.id), ledger: await ledgerCount(sql, wallet.id) };
    expect((await call(`/api/transactions/${parkedId}/retry`, { method: 'POST' })).status).toBe(200);
    expect(await balanceOf(sql, wallet.id)).toBe(before.balance);
    expect(await ledgerCount(sql, wallet.id)).toBe(before.ledger);
  });

  test('terminal transactions are 409 (and stay untouched), unknown ones 404, malformed ids 400', async () => {
    await seed();
    const processed = (await call('/api/transactions?status=PROCESSED&kind=BET')).body.items[0];
    const conflict = await call(`/api/transactions/${processed.id}/retry`, { method: 'POST' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toContain('PROCESSED');
    expect((await call('/api/transactions/22222222-2222-4222-8222-222222222222/retry', { method: 'POST' })).status).toBe(404);
    expect((await call('/api/transactions/nope/retry', { method: 'POST' })).status).toBe(400);
    expect((await call(`/api/transactions/${processed.id}/retry`)).status).toBe(404); // GET is not a route
  });

  test('requires the token', async () => {
    expect((await call('/api/transactions/22222222-2222-4222-8222-222222222222/retry', { method: 'POST', auth: null })).status).toBe(401);
  });
});

describe('wallet reconciliation (proxy to the API)', () => {
  test('forwards a POST to the first API instance and relays status and body', async () => {
    const wallet = '11111111-1111-4111-8111-111111111111';
    upstream = () => Response.json({ walletId: wallet, consistent: true, difference: '0.00' }, { status: 200 });
    const { status, body } = await call(`/api/wallets/${wallet}/reconciliation`, { method: 'POST' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ consistent: true, difference: '0.00' });
    expect(calls).toEqual([{ url: `http://api-1/wallets/${wallet}/reconciliation`, method: 'POST' }]);
  });

  test('relays a 404 from the API, answers 502 when it is down, 400 for a malformed id', async () => {
    const wallet = '11111111-1111-4111-8111-111111111111';
    upstream = () => Response.json({ error: 'wallet not found' }, { status: 404 });
    expect((await call(`/api/wallets/${wallet}/reconciliation`, { method: 'POST' })).status).toBe(404);

    upstream = () => {
      throw new Error('ECONNREFUSED');
    };
    expect((await call(`/api/wallets/${wallet}/reconciliation`, { method: 'POST' })).status).toBe(502);

    calls = [];
    expect((await call('/api/wallets/xyz/reconciliation', { method: 'POST' })).status).toBe(400);
    expect(calls).toHaveLength(0); // a bad id never reaches the API
  });
});

describe('SRE: wallet lock conflicts', () => {
  const metrics = (waited: number, timeout: number) =>
    new Response(`wallet_lock_conflicts_total{outcome="waited"} ${waited}\nwallet_lock_conflicts_total{outcome="timeout"} ${timeout}\n`);

  test('sums the instances and reports the ones that cannot be read', async () => {
    upstream = (url) => (url.startsWith('http://api-1') ? metrics(5, 1) : new Response('boom', { status: 500 }));
    const { status, body } = await call('/api/sre/lock-conflicts');
    expect(status).toBe(200);
    expect(body.total).toEqual({ waited: 5, timeout: 1 });
    expect(body.instances[0]).toEqual({ url: 'http://api-1', waited: 5, timeout: 1 });
    expect(body.instances[1]).toMatchObject({ url: 'http://api-2', error: 'HTTP 500' });
  });

  test('adds up every instance', async () => {
    upstream = (url) => (url.startsWith('http://api-1') ? metrics(5, 1) : metrics(7, 2));
    expect((await call('/api/sre/lock-conflicts')).body.total).toEqual({ waited: 12, timeout: 3 });
  });
});
