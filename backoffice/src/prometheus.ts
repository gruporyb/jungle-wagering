export interface Sample {
  labels: Record<string, string>;
  value: number;
}

/** Reads every sample of one metric from the Prometheus text format (no external dependency). */
export function samplesOf(text: string, name: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(name) || line.startsWith('#')) continue;
    const match = /^([A-Za-z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line.trim());
    if (!match || match[1] !== name) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    for (const [, key, raw] of (match[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
      labels[key as string] = (raw as string).replace(/\\(.)/g, '$1');
    }
    samples.push({ labels, value });
  }
  return samples;
}

/** wallet_lock_conflicts_total split by outcome (`waited` = got the lock after waiting, `timeout` = gave up). */
export function lockConflicts(text: string): { waited: number; timeout: number } {
  const result = { waited: 0, timeout: 0 };
  for (const { labels, value } of samplesOf(text, 'wallet_lock_conflicts_total')) {
    if (labels.outcome === 'waited') result.waited += value;
    else if (labels.outcome === 'timeout') result.timeout += value;
  }
  return result;
}
