import { createHash } from 'node:crypto';
import type { StateSnapshot } from '../core/types.ts';

/** JSON with sorted object keys, so equal states always hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** SHA-256 over the canonical, already-redacted snapshot. */
export function hashSnapshot(snapshot: StateSnapshot): string {
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}
