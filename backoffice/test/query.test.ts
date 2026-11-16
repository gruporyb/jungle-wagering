import { describe, expect, test } from 'bun:test';
import { BadRequestError, buildListQuery, parseFilters } from '../src/query';

const parse = (qs: string) => parseFilters(new URLSearchParams(qs));
const WALLET = '11111111-1111-4111-8111-111111111111';

describe('parseFilters', () => {
  test('defaults to 50 items from offset 0 and no filter', () => {
    expect(parse('')).toEqual({ status: undefined, kind: undefined, limit: 50, offset: 0 });
  });

  test('accepts valid filters and normalises the wallet id to lower case', () => {
    const filters = parse(`status=PENDING_REFERENCE&kind=REFUND&providerId=provider-a&walletId=${WALLET.toUpperCase()}&limit=10&offset=20`);
    expect(filters).toEqual({ status: 'PENDING_REFERENCE', kind: 'REFUND', providerId: 'provider-a', walletId: WALLET, limit: 10, offset: 20 });
  });

  test.each([
    'status=APPLIED',
    "status=PROCESSED' OR '1'='1",
    'kind=CHARGEBACK',
    'walletId=not-a-uuid',
    'limit=0',
    'limit=201',
    'limit=abc',
    'limit=1e2',
    'offset=-1',
    `providerId=${'x'.repeat(129)}`,
  ])('rejects %s', (qs) => {
    expect(() => parse(qs)).toThrow(BadRequestError);
  });
});

describe('buildListQuery', () => {
  test('no filter: only paging parameters, newest first, one extra row to detect the next page', () => {
    const { text, values } = buildListQuery(parse('limit=10&offset=5'));
    expect(text).not.toContain('WHERE');
    expect(text).toContain('ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2');
    expect(values).toEqual([11, 5]);
  });

  test('every filter becomes a numbered parameter, in order, and no value is ever concatenated into the SQL', () => {
    const { text, values } = buildListQuery(parse(`status=REJECTED&kind=BET&providerId=provider-a&walletId=${WALLET}&limit=2`));
    expect(text).toContain('WHERE status = $1 AND kind = $2 AND provider_id = $3 AND wallet_id = $4::uuid');
    expect(text).toContain('LIMIT $5 OFFSET $6');
    expect(values).toEqual(['REJECTED', 'BET', 'provider-a', WALLET, 3, 0]);
    expect(text).not.toContain('provider-a');
  });

  test('a hostile providerId stays a bound value', () => {
    const hostile = "x'; DROP TABLE wager_transactions; --";
    const { text, values } = buildListQuery(parse(`providerId=${encodeURIComponent(hostile)}`));
    expect(text).not.toContain('DROP');
    expect(values[0]).toBe(hostile);
  });
});
