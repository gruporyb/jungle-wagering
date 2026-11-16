/** Pure helpers: validate the list filters and build a fully parameterised SQL (user input never reaches the text). */
export const STATUSES = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] as const;
export const KINDS = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

export class BadRequestError extends Error {}

export interface Filters {
  status?: string;
  kind?: string;
  providerId?: string;
  walletId?: string;
  limit: number;
  offset: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuid(value: string, field: string): string {
  if (!UUID.test(value)) throw new BadRequestError(`${field} must be a UUID`);
  return value.toLowerCase();
}

function boundedInt(raw: string | null, field: string, fallback: number, min: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new BadRequestError(`${field} must be an integer between ${min} and ${max}`);
  }
  return Number(raw);
}

function oneOf<T extends readonly string[]>(raw: string | null, allowed: T, field: string): T[number] | undefined {
  if (raw === null || raw === '') return undefined;
  if (!(allowed as readonly string[]).includes(raw)) throw new BadRequestError(`${field} must be one of ${allowed.join(', ')}`);
  return raw;
}

export function parseFilters(params: URLSearchParams): Filters {
  const providerId = params.get('providerId') ?? '';
  if (providerId.length > 128) throw new BadRequestError('providerId is too long');
  const walletId = params.get('walletId');
  return {
    status: oneOf(params.get('status'), STATUSES, 'status'),
    kind: oneOf(params.get('kind'), KINDS, 'kind'),
    ...(providerId ? { providerId } : {}),
    ...(walletId ? { walletId: parseUuid(walletId, 'walletId') } : {}),
    limit: boundedInt(params.get('limit'), 'limit', 50, 1, 200),
    offset: boundedInt(params.get('offset'), 'offset', 0, 0, 100_000),
  };
}

const COLUMNS = `id, provider_id, external_transaction_id, wallet_id, player_id, round_id, game_id, kind,
  amount::text AS amount, currency, status, failure_code, observed_balance::text AS observed_balance,
  reference_external_transaction_id, reference_attempts, reference_next_attempt_at, reference_deadline_at,
  created_at, processed_at`;

/** Fetches ONE extra row so the caller can tell whether another page exists. */
export function buildListQuery(filters: Filters): { text: string; values: unknown[] } {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };
  if (filters.status) add('status = ?', filters.status);
  if (filters.kind) add('kind = ?', filters.kind);
  if (filters.providerId) add('provider_id = ?', filters.providerId);
  if (filters.walletId) add('wallet_id = ?::uuid', filters.walletId);
  values.push(filters.limit + 1);
  const limitRef = `$${values.length}`;
  values.push(filters.offset);
  const offsetRef = `$${values.length}`;
  const text =
    `SELECT ${COLUMNS} FROM wager_transactions` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY created_at DESC, id DESC LIMIT ${limitRef} OFFSET ${offsetRef}`;
  return { text, values };
}
