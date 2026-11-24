import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuditEventStore } from '../core/store.ts';
import type { EventRecord, EventType, StateDiff, StateSnapshot } from '../core/types.ts';
import { redactDeep, redactText } from '../capture/redact.ts';
import { hashSnapshot } from './stateHash.ts';

/** Timeline colour classes used by the Command Center. */
export type TimelineCategory = 'NORMAL' | 'FAILURE' | 'GUARD_BLOCKED' | 'AWAITING_APPROVAL';

export interface TimelineEntry {
  index: number;
  id: string;
  runId: string;
  timestamp: number;
  type: EventType;
  actor: string;
  category: TimelineCategory;
  summary: string;
  hasEvidence: boolean;
  hash: string;
  previousHash?: string;
  stateHash?: string;
  source?: string;
}

export interface IngestResult {
  events: EventRecord[];
  rejected: Array<{ index: number; reason: string }>;
}

export interface SnapshotRecord {
  eventId: string;
  runId: string;
  timestamp: number;
  order: number;
  label: string;
  snapshot: StateSnapshot;
  recordedStateHash: string | null;
  hashValid: boolean;
  source: string;
}

export type LastGoodResult =
  | { status: 'FOUND'; record: SnapshotRecord; reasoning: string[] }
  | { status: 'UNAVAILABLE'; reason: string; reasoning: string[] };

export type AuthState = 'AUTHENTICATED' | 'UNAUTHENTICATED' | 'UNKNOWN';

/** Extends (does not redefine) the shared StateDiff contract with forensic fields. */
export interface ForensicStateDiff extends StateDiff {
  fromEventId: string;
  toEventId: string;
  titleChanged: boolean;
  fromTitle: string;
  toTitle: string;
  aria: { added: string[]; removed: string[]; truncated: boolean };
  networkFailures: Array<{ eventId: string; kind: string; method?: string; url?: string; status?: number; error?: string }>;
  validationErrors: Array<{ eventId: string; status?: number; message: string }>;
  blockedRequests: Array<{ eventId: string; host?: string; reason?: string }>;
  authState: { before: AuthState; after: AuthState; evidence: string[] };
}

export interface Reconstruction {
  runId: string;
  failure: { eventId: string; timestamp: number; summary: string } | null;
  lastGood: LastGoodResult;
  failedState: SnapshotRecord | null;
  diff: ForensicStateDiff | null;
  /** Facts directly observed in recorded events. */
  observations: string[];
  /** Explanations that are not themselves observations. Phrased as associations only. */
  inferences: string[];
}

const EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  'DOM_OBSERVED', 'ACTION_PROPOSED', 'ACTION_DISPATCHED', 'ACTION_EXECUTION_FAILED', 'NETWORK_REQUEST',
  'NETWORK_BLOCKED', 'NETWORK_RESPONSE', 'FAILURE_DETECTED', 'HYPOTHESIS_FORMULATED', 'PROBE_EXECUTED',
  'RECOVERY_PROPOSED', 'APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'APPROVAL_DENIED', 'POSTCONDITION_VERIFIED',
  'POSTCONDITION_FAILED', 'ACTION_BLOCKED', 'BROWSER_NAVIGATED', 'BROWSER_CONSOLE', 'FAULT_INJECTED'
]);
const ACTORS: ReadonlySet<string> = new Set(['AGENT', 'GUARD', 'HUMAN', 'BROWSER', 'TARGET_APP', 'VERIFIER']);
const MAX_ARIA_DIFF_LINES = 40;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * CHRONOS: temporal reconstruction over Person 1's event store.
 *
 * Reads events (live store or persisted JSONL), validates them, orders them, identifies the
 * last good state before a failure and diffs it against the failed state.
 */
export class ChronosTimeline {
  // ------------------------------------------------------------------ legacy in-memory API
  private snapshots: Map<string, StateSnapshot[]> = new Map();

  public recordSnapshot(runId: string, snapshot: StateSnapshot): void {
    const list = this.snapshots.get(runId) ?? [];
    list.push(snapshot);
    this.snapshots.set(runId, list);
  }

  public getSnapshots(runId: string): StateSnapshot[] {
    return this.snapshots.get(runId) ?? [];
  }

  /** Legacy: latest healthy manually-recorded snapshot. Event-based runs use lastGoodState(). */
  public getLastGoodState(runId: string): StateSnapshot | undefined {
    const list = this.getSnapshots(runId);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].isHealthy) return list[i];
    }
    return undefined;
  }

  /** Base StateDiff between two snapshots. Input values are redacted before comparison output. */
  public diff(before: StateSnapshot, after: StateSnapshot): StateDiff {
    const a = redactDeep(before.formInputs ?? {});
    const b = redactDeep(after.formInputs ?? {});
    const inputsModified: Record<string, { from: string; to: string }> = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const fromVal = a[key] ?? '';
      const toVal = b[key] ?? '';
      if (fromVal !== toVal) inputsModified[key] = { from: fromVal, to: toVal };
    }
    return {
      stepFrom: before.step,
      stepTo: after.step,
      urlChanged: before.url !== after.url,
      fromUrl: before.url,
      toUrl: after.url,
      inputsModified,
      sessionStatusChanged: before.activeSessionId !== after.activeSessionId,
      healthChanged: before.isHealthy !== after.isHealthy
    };
  }

  // ------------------------------------------------------------------ ingestion

  /** Structural validation. Returns the reason a record is rejected, or null if valid. */
  public static validateEvent(raw: unknown): string | null {
    if (typeof raw !== 'object' || raw === null) return 'not an object';
    const e = raw as Record<string, unknown>;
    if (!str(e.id)) return 'missing id';
    if (!str(e.runId)) return 'missing runId';
    if (num(e.timestamp) === undefined) return 'missing or non-numeric timestamp';
    if (!str(e.type) || !EVENT_TYPES.has(e.type as string)) return `unknown event type '${String(e.type)}'`;
    if (!str(e.actor) || !ACTORS.has(e.actor as string)) return `unknown actor '${String(e.actor)}'`;
    if (typeof e.payload !== 'object' || e.payload === null || Array.isArray(e.payload)) return 'payload is not an object';
    if (!str(e.hash)) return 'missing hash';
    if (e.previousHash !== undefined && !str(e.previousHash)) return 'previousHash is not a string';
    return null;
  }

  /**
   * Validates and orders events. Order is by timestamp; ties (same millisecond) keep the
   * original append order, which is the store's causal order. Duplicate ids are rejected.
   */
  public ingest(raw: unknown[], runId?: string): IngestResult {
    const rejected: IngestResult['rejected'] = [];
    const seen = new Set<string>();
    const valid: Array<{ e: EventRecord; i: number }> = [];
    raw.forEach((item, index) => {
      const reason = ChronosTimeline.validateEvent(item);
      if (reason) { rejected.push({ index, reason }); return; }
      const e = item as EventRecord;
      if (runId !== undefined && e.runId !== runId) return;
      if (seen.has(e.id)) { rejected.push({ index, reason: `duplicate event id ${e.id}` }); return; }
      seen.add(e.id);
      valid.push({ e, i: index });
    });
    valid.sort((x, y) => x.e.timestamp - y.e.timestamp || x.i - y.i);
    return { events: valid.map((v) => v.e), rejected };
  }

  public fromStore(store: AuditEventStore, runId: string): IngestResult {
    return this.ingest(store.getEvents(runId), runId);
  }

  /** Reads a persisted run (data/runs/<runId>.jsonl). Malformed lines are reported, not fatal. */
  public readRunFile(filePath: string, runId?: string): IngestResult & { chainValid: boolean | null } {
    if (!fs.existsSync(filePath)) return { events: [], rejected: [{ index: -1, reason: `file not found: ${filePath}` }], chainValid: null };
    const parsed: unknown[] = [];
    const lineOf: number[] = [];
    const rejected: IngestResult['rejected'] = [];
    fs.readFileSync(filePath, 'utf-8').split('\n').forEach((line, lineNo) => {
      if (!line.trim()) return;
      try {
        parsed.push(JSON.parse(line));
        lineOf.push(lineNo);
      } catch {
        rejected.push({ index: lineNo, reason: 'invalid JSON line' });
      }
    });
    const result = this.ingest(parsed, runId);
    for (const r of result.rejected) rejected.push({ index: lineOf[r.index] ?? r.index, reason: r.reason });

    // Chain integrity via Person 1's own verifier, only when every line is well-formed.
    let chainValid: boolean | null = null;
    if (result.events.length > 0 && rejected.length === 0) {
      const store = new AuditEventStore(path.dirname(filePath));
      store.loadFromFile(filePath);
      chainValid = store.verifyIntegrity(result.events[0].runId);
    }
    return { events: result.events, rejected: rejected.sort((a, b) => a.index - b.index), chainValid };
  }

  // ------------------------------------------------------------------ snapshots & last-good

  public extractSnapshots(events: EventRecord[]): SnapshotRecord[] {
    const out: SnapshotRecord[] = [];
    events.forEach((e, order) => {
      if (e.type !== 'DOM_OBSERVED' || e.payload.kind !== 'STATE_SNAPSHOT') return;
      const snap = e.payload.snapshot;
      if (!isSnapshot(snap)) return;
      const recorded = str(e.payload.stateHash) ?? null;
      out.push({
        eventId: e.id,
        runId: e.runId,
        timestamp: e.timestamp,
        order,
        label: str(e.payload.label) ?? '',
        snapshot: snap,
        recordedStateHash: recorded,
        hashValid: recorded !== null && hashSnapshot(snap) === recorded,
        source: str(e.payload.source) ?? 'unknown'
      });
    });
    return out;
  }

  /** The failure to reconstruct: the given id, else the most recent FAILURE_DETECTED. */
  public findFailure(events: EventRecord[], failureEventId?: string): EventRecord | undefined {
    if (failureEventId) return events.find((e) => e.id === failureEventId && e.type === 'FAILURE_DETECTED');
    for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'FAILURE_DETECTED') return events[i];
    return undefined;
  }

  /**
   * Last-good-state algorithm (deterministic):
   *   Walk events in order up to the failure. Track an "open failure" flag: set by any
   *   FAILURE_DETECTED, cleared only by a later 2xx response to the same method+path, or by a
   *   POSTCONDITION_VERIFIED event. A snapshot qualifies as GOOD iff
   *     (a) its recorded state hash matches a recomputation of its content,
   *     (b) the capture layer marked it healthy (no failure observed since the prior snapshot),
   *     (c) its last observed app HTTP status was < 400 (or none yet), and
   *     (d) no failure was open when it was taken.
   *   The answer is the latest qualifying snapshot strictly before the failure, or UNAVAILABLE.
   */
  public lastGoodState(events: EventRecord[], failure: EventRecord): LastGoodResult {
    const reasoning: string[] = [];
    const failureIndex = events.findIndex((e) => e.id === failure.id);
    if (failureIndex < 0) return { status: 'UNAVAILABLE', reason: 'Failure event is not part of this run.', reasoning };

    const snapshots = new Map(this.extractSnapshots(events).map((s) => [s.eventId, s]));
    let open: { key: string; id: string } | null = null;
    let best: SnapshotRecord | null = null;

    for (let i = 0; i < failureIndex; i++) {
      const e = events[i];
      if (e.type === 'FAILURE_DETECTED') {
        open = { key: requestKey(e.payload), id: e.id };
      } else if (e.type === 'NETWORK_RESPONSE' && open) {
        const status = num(e.payload.status);
        if (status !== undefined && status < 400 && requestKey(e.payload) === open.key) {
          reasoning.push(`Earlier failure ${open.id} considered resolved by 2xx response ${e.id} to the same endpoint.`);
          open = null;
        }
      } else if (e.type === 'POSTCONDITION_VERIFIED') {
        open = null;
      }
      const snap = snapshots.get(e.id);
      if (!snap) continue;
      const problems: string[] = [];
      if (!snap.hashValid) problems.push('state hash missing or does not match content');
      if (!snap.snapshot.isHealthy) problems.push('capture marked it unhealthy');
      if ((snap.snapshot.lastHttpStatusCode ?? 0) >= 400) problems.push(`last app status ${snap.snapshot.lastHttpStatusCode}`);
      if (open) problems.push(`failure ${open.id} still unresolved`);
      if (problems.length === 0) best = snap;
      else reasoning.push(`Snapshot ${snap.eventId} ("${snap.label}") rejected: ${problems.join('; ')}.`);
    }

    if (!best) {
      return { status: 'UNAVAILABLE', reason: 'No snapshot before the failure satisfies the validity rules.', reasoning };
    }
    reasoning.push(`Selected ${best.eventId} ("${best.label}"): latest valid snapshot recorded before failure ${failure.id}.`);
    return { status: 'FOUND', record: best, reasoning };
  }

  /** First snapshot recorded after the failure (the observed failed state). */
  public failedStateAfter(events: EventRecord[], failure: EventRecord): SnapshotRecord | null {
    const idx = events.findIndex((e) => e.id === failure.id);
    return this.extractSnapshots(events).find((s) => s.order > idx) ?? null;
  }

  public forensicDiff(events: EventRecord[], good: SnapshotRecord, failed: SnapshotRecord): ForensicStateDiff {
    const base = this.diff(good.snapshot, failed.snapshot);
    const between = events.slice(good.order + 1, failed.order);
    const ariaA = normalizeAria(good.snapshot.ariaSnapshot);
    const ariaB = normalizeAria(failed.snapshot.ariaSnapshot);
    const setA = new Set(ariaA);
    const setB = new Set(ariaB);
    const added = ariaB.filter((l) => !setA.has(l));
    const removed = ariaA.filter((l) => !setB.has(l));

    const networkFailures: ForensicStateDiff['networkFailures'] = [];
    const validationErrors: ForensicStateDiff['validationErrors'] = [];
    const blockedRequests: ForensicStateDiff['blockedRequests'] = [];
    for (const e of between) {
      if (e.type === 'FAILURE_DETECTED') {
        const status = num(e.payload.status);
        networkFailures.push({ eventId: e.id, kind: str(e.payload.kind) ?? 'UNKNOWN', method: str(e.payload.method), url: str(e.payload.url), status, error: str(e.payload.error) });
        if ((status === 400 || status === 422) && str(e.payload.error)) {
          validationErrors.push({ eventId: e.id, status, message: redactText(String(e.payload.error)) });
        }
      } else if (e.type === 'NETWORK_BLOCKED') {
        blockedRequests.push({ eventId: e.id, host: str(e.payload.host), reason: str(e.payload.reason) });
      }
    }

    return redactDeep({
      ...base,
      fromEventId: good.eventId,
      toEventId: failed.eventId,
      titleChanged: good.snapshot.title !== failed.snapshot.title,
      fromTitle: good.snapshot.title,
      toTitle: failed.snapshot.title,
      aria: {
        added: added.slice(0, MAX_ARIA_DIFF_LINES),
        removed: removed.slice(0, MAX_ARIA_DIFF_LINES),
        truncated: added.length > MAX_ARIA_DIFF_LINES || removed.length > MAX_ARIA_DIFF_LINES
      },
      networkFailures,
      validationErrors,
      blockedRequests,
      authState: authStates(events, good.order, failed.order)
    });
  }

  /** Full reconstruction for one failure, separating observations from inferences. */
  public reconstruct(events: EventRecord[], failureEventId?: string): Reconstruction {
    const runId = events[0]?.runId ?? 'unknown';
    const failure = this.findFailure(events, failureEventId);
    if (!failure) {
      return { runId, failure: null, lastGood: { status: 'UNAVAILABLE', reason: 'No FAILURE_DETECTED event in this run.', reasoning: [] }, failedState: null, diff: null, observations: [], inferences: [] };
    }
    const lastGood = this.lastGoodState(events, failure);
    const failedState = this.failedStateAfter(events, failure);
    const diff = lastGood.status === 'FOUND' && failedState ? this.forensicDiff(events, lastGood.record, failedState) : null;

    const observations: string[] = [];
    const inferences: string[] = [];
    const fs = describeFailure(failure);
    observations.push(`Observed failure ${failure.id}: ${fs}.`);
    if (lastGood.status === 'FOUND') {
      observations.push(`Last valid state ${lastGood.record.eventId} ("${lastGood.record.label}") at step ${lastGood.record.snapshot.step} was observed before the failure.`);
    }
    if (diff) {
      if (diff.urlChanged) observations.push(`URL changed from ${diff.fromUrl} to ${diff.toUrl}.`);
      if (diff.stepFrom !== diff.stepTo) observations.push(`Workflow step changed from ${diff.stepFrom} to ${diff.stepTo}.`);
      for (const [k, v] of Object.entries(diff.inputsModified)) observations.push(`Field '${k}' changed from '${v.from}' to '${v.to}'.`);
      for (const v of diff.validationErrors) observations.push(`Backend validation error observed (${v.status}): ${v.message}`);
      if (diff.authState.before !== diff.authState.after) observations.push(`Authentication state observed ${diff.authState.before} → ${diff.authState.after}.`);
      for (const k of Object.keys(diff.inputsModified)) {
        inferences.push(`The change to '${k}' is associated with the failure (temporal association only, not established cause).`);
      }
      if (diff.authState.after === 'UNAUTHENTICATED') inferences.push('An authentication-class response is associated with the failure; supports the session-expiry hypothesis.');
      if (diff.validationErrors.length > 0) inferences.push('A validation-class response is associated with the failure; supports the missing-requirement hypothesis.');
    }
    return {
      runId,
      failure: { eventId: failure.id, timestamp: failure.timestamp, summary: fs },
      lastGood,
      failedState,
      diff,
      observations: observations.map(redactText),
      inferences: inferences.map(redactText)
    };
  }

  // ------------------------------------------------------------------ presentation

  public static categorize(e: EventRecord): TimelineCategory {
    if (e.type === 'NETWORK_BLOCKED' || e.type === 'ACTION_BLOCKED' || e.type === 'APPROVAL_DENIED') return 'GUARD_BLOCKED';
    if (e.type === 'APPROVAL_REQUESTED') return 'AWAITING_APPROVAL';
    if (e.type === 'FAILURE_DETECTED' || e.type === 'ACTION_EXECUTION_FAILED' || e.type === 'POSTCONDITION_FAILED') return 'FAILURE';
    if (e.type === 'BROWSER_CONSOLE' && e.payload.level === 'pageerror') return 'FAILURE';
    return 'NORMAL';
  }

  public toTimeline(events: EventRecord[]): TimelineEntry[] {
    return events.map((e, index) => ({
      index,
      id: e.id,
      runId: e.runId,
      timestamp: e.timestamp,
      type: e.type,
      actor: e.actor,
      category: ChronosTimeline.categorize(e),
      summary: redactText(summarize(e)),
      hasEvidence: Object.keys(e.payload).length > 0,
      hash: e.hash,
      previousHash: e.previousHash,
      stateHash: str(e.payload.stateHash),
      source: str(e.payload.source)
    }));
  }

  /** Legacy formatter (kept for existing callers); now redacted and summary-based. */
  public formatTimeline(events: EventRecord[]): Array<{ time: string; actor: string; type: string; summary: string; isAlert: boolean }> {
    return this.toTimeline(events).map((t) => ({
      time: new Date(t.timestamp).toISOString().split('T')[1].replace('Z', ''),
      actor: t.actor,
      type: t.type,
      summary: t.summary,
      isAlert: t.category !== 'NORMAL'
    }));
  }
}

function isSnapshot(v: unknown): v is StateSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.url === 'string' && typeof s.title === 'string' && typeof s.step === 'number' &&
    typeof s.timestamp === 'number' && typeof s.isHealthy === 'boolean' && typeof s.formInputs === 'object' && s.formInputs !== null;
}

function requestKey(payload: Record<string, unknown>): string {
  const url = str(payload.url);
  let path = str(payload.path) ?? '';
  if (!path && url) {
    try { path = new URL(url).pathname; } catch { path = url; }
  }
  return `${str(payload.method) ?? '?'} ${path}`;
}

/** Strips volatile [ref=eN] markers so diffs show content changes, not renumbering. */
function normalizeAria(text: string | undefined): string[] {
  if (!text) return [];
  return text.split('\n').map((l) => l.replace(/\s*\[ref=e\d+\]/g, '').trimEnd()).filter((l) => l.trim().length > 0);
}

/** Auth state from responses that actually check the session (session endpoint and submit). */
function authStates(events: EventRecord[], goodOrder: number, failedOrder: number): ForensicStateDiff['authState'] {
  const evidence: string[] = [];
  const stateAt = (upTo: number): AuthState => {
    let state: AuthState = 'UNKNOWN';
    for (let i = 0; i <= upTo && i < events.length; i++) {
      const e = events[i];
      if (e.type !== 'NETWORK_RESPONSE') continue;
      const key = requestKey(e.payload);
      if (!/\/api\/session$|\/api\/apply\/submit$/.test(key)) continue;
      const status = num(e.payload.status);
      if (status === 401 || status === 403) state = 'UNAUTHENTICATED';
      else if (status !== undefined && status < 400) state = 'AUTHENTICATED';
      else continue;
      if (i > goodOrder || upTo === goodOrder) evidence.push(`${e.id}: ${key} → ${status}`);
    }
    return state;
  };
  const before = stateAt(goodOrder);
  const after = stateAt(failedOrder);
  return { before, after, evidence: [...new Set(evidence)].slice(-6) };
}

function describeFailure(e: EventRecord): string {
  const kind = str(e.payload.kind) ?? 'FAILURE';
  const status = num(e.payload.status);
  const method = str(e.payload.method);
  const path = str(e.payload.path) ?? str(e.payload.url);
  const err = str(e.payload.error);
  return [kind, method && path ? `${method} ${path}` : path, status !== undefined ? `HTTP ${status}` : undefined, err ? `"${err.slice(0, 160)}"` : undefined]
    .filter(Boolean)
    .join(' ');
}

function summarize(e: EventRecord): string {
  const p = e.payload;
  const action = `${str(p.actionType) ?? ''} ${str(p.target) ?? ''}`.trim();
  switch (e.type) {
    case 'DOM_OBSERVED':
      if (p.kind === 'STATE_SNAPSHOT') return `State snapshot "${str(p.label) ?? ''}" (healthy=${String((p.snapshot as { isHealthy?: unknown } | undefined)?.isHealthy)})`;
      if (p.kind === 'UNTRUSTED_CONTENT') return `Untrusted content recorded as data${p.instructionLike ? ' (instruction-like text)' : ''}: ${str(p.text)?.slice(0, 80) ?? ''}`;
      return `DOM observed (${str(p.kind) ?? 'unspecified'})`;
    case 'ACTION_PROPOSED':
      if (p.kind === 'POLICY_DECISION') return `Guard ${str(p.guardStatus)}${p.phase === 'POST_APPROVAL_REVALIDATION' ? ' (post-approval revalidation)' : ''}: ${action}`;
      if (p.kind === 'RECOVERY_ACTION_DEFERRED') return `Recovery action deferred: ${str(p.target) ?? ''} — ${str(p.reason) ?? ''}`;
      return `Proposed ${action} — agent label "${str(p.agentLabel) ?? ''}"`;
    case 'ACTION_DISPATCHED':
      return `Executed ${action}${p.approvedBy ? ` (approved by ${str(p.approvedBy)})` : ''}`;
    case 'ACTION_EXECUTION_FAILED':
      return `Not executed (${str(p.status) ?? 'FAILED'}): ${str(p.reason) ?? ''}`;
    case 'ACTION_BLOCKED':
      return `Guard BLOCK ${action}: ${str(p.reason) ?? ''}`;
    case 'NETWORK_BLOCKED':
      return `Blocked ${str(p.layer) === 'ACTION_POLICY' ? 'action' : 'request'} → ${str(p.host) ?? str(p.url) ?? action}: ${str(p.reason) ?? ''}`;
    case 'NETWORK_REQUEST':
      return `${str(p.method) ?? ''} ${str(p.url) ?? ''} (${str(p.resourceType) ?? ''})`;
    case 'NETWORK_RESPONSE':
      return `${num(p.status) ?? '?'} ← ${str(p.method) ?? ''} ${str(p.url) ?? ''}`;
    case 'FAILURE_DETECTED':
      return describeFailure(e);
    case 'BROWSER_NAVIGATED':
      return `Navigated to ${str(p.url) ?? ''}`;
    case 'BROWSER_CONSOLE':
      return `Console ${str(p.level) ?? ''}: ${str(p.text)?.slice(0, 100) ?? ''}`;
    case 'APPROVAL_REQUESTED':
      return `Awaiting human approval: ${action} — ${str(p.reason) ?? ''}`;
    case 'APPROVAL_GRANTED':
      return `Approved by ${str(p.operator) ?? 'operator'}`;
    case 'APPROVAL_DENIED':
      return `Denied by ${str(p.operator) ?? 'operator'}${p.notes ? `: ${str(p.notes)}` : ''}`;
    case 'PROBE_EXECUTED':
      return `Probe ${str(p.name) ?? ''} (${str(p.method) ?? ''}, read-only): ${str(p.outcome) ?? ''}`;
    case 'HYPOTHESIS_FORMULATED': {
      const h = p.hypothesis as { claim?: unknown; status?: unknown; confidenceScore?: unknown } | undefined;
      return `${str(h?.claim) ?? 'Hypothesis'} → ${str(h?.status) ?? '?'} (confidence ${num(h?.confidenceScore) ?? '?'})`;
    }
    case 'RECOVERY_PROPOSED':
      return `Recovery candidate: ${str(p.strategyName) ?? str(p.strategy) ?? ''}`;
    case 'POSTCONDITION_VERIFIED':
      return 'Postconditions verified against backend state';
    case 'POSTCONDITION_FAILED':
      return `Postcondition check failed${p.reason ? `: ${str(p.reason)}` : ''}`;
    case 'FAULT_INJECTED':
      return `Harness injected fault: ${str(p.scenario) ?? ''}`;
    default:
      return e.type;
  }
}
