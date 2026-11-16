import { describe, expect, test } from 'bun:test';
import { assertDisposableDatabase } from '../helpers/db';

const check = (url: string, env: Record<string, string | undefined> = {}) => () => assertDisposableDatabase(url, env);

describe('disposable test database guard', () => {
  test('accepts databases whose name ends in _test (credentials and query string are irrelevant)', () => {
    expect(check('postgres://wagering:wagering@127.0.0.1:5432/wagering_test')).not.toThrow();
    expect(check('postgres://u:p%40ss@db:5432/anything_test?sslmode=disable')).not.toThrow();
  });

  test('refuses the application database and anything else, with an actionable message', () => {
    expect(check('postgres://wagering_app:wagering_app@localhost:5432/wagering')).toThrow(/Refusing to reset database "wagering"/);
    expect(check('postgres://u:p@h:5432/wagering_test_backup')).toThrow(/TEST_DATABASE_URL/);
    expect(check('postgres://u:p@h:5432/production')).toThrow();
  });

  test('can be overridden explicitly, and only with the exact value 1', () => {
    expect(check('postgres://u:p@h:5432/wagering', { ALLOW_TEST_DB_RESET: '1' })).not.toThrow();
    expect(check('postgres://u:p@h:5432/wagering', { LOAD_TEST_ALLOW_RESET: '1' })).not.toThrow();
    expect(check('postgres://u:p@h:5432/wagering', { ALLOW_TEST_DB_RESET: 'true' })).toThrow();
  });
});
