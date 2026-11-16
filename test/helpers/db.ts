import { SQL } from 'bun';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Integration tests run against a REAL PostgreSQL (docker compose provides one; so does any local server).
 *
 * They read TEST_DATABASE_URL and NEVER DATABASE_URL: Bun loads `.env` automatically (even in `bun test`) and `.env`
 * holds the APPLICATION's URL, while these tests DROP and recreate the schema of whatever database they point at.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@127.0.0.1:5432/wagering_test';

/** Refuses to reset a database whose name does not end in `_test` (escape hatch: ALLOW_TEST_DB_RESET=1). */
export function assertDisposableDatabase(
  url: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (name.endsWith('_test')) return;
  if (env.ALLOW_TEST_DB_RESET === '1' || env.LOAD_TEST_ALLOW_RESET === '1') return;
  throw new Error(
    `Refusing to reset database "${name}": tests and the load test DROP its schema. Point TEST_DATABASE_URL at a ` +
      'disposable database whose name ends in "_test" (e.g. wagering_test), or set ALLOW_TEST_DB_RESET=1 if you are sure.',
  );
}

const MIGRATIONS_DIR = join(import.meta.dir, '../../migrations/sql');

export function connect(max = 20): SQL {
  return new SQL({ url: TEST_DATABASE_URL, max });
}

export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.up.sql'))
    .map((file) => file.replace('.up.sql', ''))
    .sort();
}

/** Applies the versioned SQL migrations (the same files `bun run migration:up` applies), up or down. */
export async function migrate(sql: SQL, direction: 'up' | 'down'): Promise<void> {
  const names = migrationNames();
  const ordered = direction === 'up' ? names : [...names].reverse();
  for (const name of ordered) {
    await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, `${name}.${direction}.sql`), 'utf8'));
  }
}

export async function resetDatabase(sql: SQL): Promise<void> {
  assertDisposableDatabase(TEST_DATABASE_URL);
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(sql, 'up');
}
