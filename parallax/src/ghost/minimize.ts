/**
 * Bounded failure minimisation (delta debugging, ddmin).
 *
 * Given a known-passing baseline input and a failing input, finds a minimal subset of the
 * field differences that still reproduces the failure. Trials run against an oracle supplied
 * by the caller, which must use an isolated synthetic environment (never the live run's
 * backend or browser). The number of oracle calls is hard-capped.
 */
export type Oracle<T> = (candidate: T) => Promise<boolean>; // true = failure reproduced

export interface MinimizationResult<T> {
  reproducedOriginal: boolean;
  minimalDelta: Partial<T>;
  minimalInput: T | null;
  trials: number;
  maxTrials: number;
  exhaustedBudget: boolean;
  log: Array<{ trial: number; delta: string[]; failed: boolean }>;
}

export async function minimizeFailure<T extends Record<string, unknown>>(
  baseline: T,
  failing: T,
  oracle: Oracle<T>,
  maxTrials = 16
): Promise<MinimizationResult<T>> {
  const log: MinimizationResult<T>['log'] = [];
  let trials = 0;
  const cache = new Map<string, boolean>();

  const deltaKeys = Object.keys(failing).filter((k) => JSON.stringify(failing[k]) !== JSON.stringify(baseline[k])).sort();
  const build = (keys: string[]): T => {
    const out: Record<string, unknown> = { ...baseline };
    for (const k of keys) out[k] = failing[k];
    return out as T;
  };
  const test = async (keys: string[]): Promise<boolean | null> => {
    const id = keys.join('|');
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    if (trials >= maxTrials) return null;
    trials += 1;
    const failed = await oracle(build(keys));
    cache.set(id, failed);
    log.push({ trial: trials, delta: keys, failed });
    return failed;
  };

  const original = await test(deltaKeys);
  if (original !== true) {
    return { reproducedOriginal: false, minimalDelta: {}, minimalInput: null, trials, maxTrials, exhaustedBudget: original === null, log };
  }

  let current = deltaKeys;
  let n = 2;
  let exhausted = false;
  while (current.length >= 2) {
    const size = Math.ceil(current.length / n);
    const chunks: string[][] = [];
    for (let i = 0; i < current.length; i += size) chunks.push(current.slice(i, i + size));
    let reduced = false;
    for (const chunk of chunks) {
      const r = await test(chunk);
      if (r === null) { exhausted = true; break; }
      if (r) { current = chunk; n = 2; reduced = true; break; }
    }
    if (exhausted) break;
    if (!reduced) {
      for (const chunk of chunks) {
        const complement = current.filter((k) => !chunk.includes(k));
        if (complement.length === 0) continue;
        const r = await test(complement);
        if (r === null) { exhausted = true; break; }
        if (r) { current = complement; n = Math.max(n - 1, 2); reduced = true; break; }
      }
    }
    if (exhausted) break;
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }

  const minimalDelta: Partial<T> = {};
  for (const k of current) (minimalDelta as Record<string, unknown>)[k] = failing[k];
  return { reproducedOriginal: true, minimalDelta, minimalInput: build(current), trials, maxTrials, exhaustedBudget: exhausted, log };
}
