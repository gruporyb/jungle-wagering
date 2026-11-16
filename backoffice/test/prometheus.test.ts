import { describe, expect, test } from 'bun:test';
import { lockConflicts, samplesOf } from '../src/prometheus';

const TEXT = `# HELP wallet_lock_conflicts_total Wallet row-lock conflicts.
# TYPE wallet_lock_conflicts_total counter
wallet_lock_conflicts_total{outcome="waited"} 12
wallet_lock_conflicts_total{outcome="timeout"} 3
wallet_lock_conflicts_total_other{outcome="waited"} 999
wager_retries_total{reason="deadlock"} 7
`;

describe('prometheus text parsing', () => {
  test('reads the samples of exactly one metric (no prefix matches)', () => {
    expect(samplesOf(TEXT, 'wallet_lock_conflicts_total')).toEqual([
      { labels: { outcome: 'waited' }, value: 12 },
      { labels: { outcome: 'timeout' }, value: 3 },
    ]);
  });

  test('lockConflicts splits waited from timeout', () => {
    expect(lockConflicts(TEXT)).toEqual({ waited: 12, timeout: 3 });
  });

  test('a metric that has not been emitted yet counts as zero', () => {
    expect(lockConflicts('wager_retries_total{reason="queue"} 1\n')).toEqual({ waited: 0, timeout: 0 });
    expect(lockConflicts('')).toEqual({ waited: 0, timeout: 0 });
  });

  test('ignores malformed values and unescapes label values', () => {
    expect(samplesOf('m{a="x\\"y"} 5\nm{a="b"} nope\n', 'm')).toEqual([{ labels: { a: 'x"y' }, value: 5 }]);
  });
});
