import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { GhostProber, scoreHypothesis, EVIDENCE_WEIGHTS, UNOBSERVED_MASS, MAX_PROBES } from '../../src/ghost/prober.ts';
import type { ReadOnlyPage, ProbeSink } from '../../src/ghost/prober.ts';
import { minimizeFailure } from '../../src/ghost/minimize.ts';
import { DeterministicPolicyGuard } from '../../src/policy/guard.ts';
import type { EventRecord } from '../../src/core/types.ts';

const failure = (status: number, error: string): EventRecord => ({
  id: 'evt_fail', runId: 'r1', timestamp: 1, type: 'FAILURE_DETECTED', actor: 'TARGET_APP',
  payload: { kind: 'HTTP_ERROR', status, error, method: 'POST', path: '/api/x' }, hash: 'h'
});

function fakeFetch(status: number, body: unknown, calls: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}
function fakePage(observed: Record<string, unknown> | Error): ReadOnlyPage {
  return { evaluate: async () => { if (observed instanceof Error) throw observed; return observed as never; } };
}
function sink(): ProbeSink & { events: Array<{ type: string; payload: Record<string, unknown> }> } {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let n = 0;
  return {
    runId: 'r1', events,
    record: (type, actor, payload) => { events.push({ type, payload }); n += 1; return { id: `e${n}`, runId: 'r1', timestamp: n, type, actor, payload, hash: 'x' }; }
  };
}
const guard = new DeterministicPolicyGuard();
const SESSION_URL = 'http://127.0.0.1:3000/api/session';

describe('GHOST scoring rules', () => {
  test('confidence follows S/(S+C+U) exactly', () => {
    const sup = [{ kind: 'EXPERIMENT' as const, weight: EVIDENCE_WEIGHTS.EXPERIMENT, description: '' }, { kind: 'STATUS_CODE' as const, weight: EVIDENCE_WEIGHTS.STATUS_CODE, description: '' }];
    const r = scoreHypothesis(sup, [], true);
    assert.strictEqual(r.confidence, Math.round((0.85 / (0.85 + UNOBSERVED_MASS)) * 100) / 100);
    assert.strictEqual(r.status, 'CONFIRMED');
  });
  test('no evidence gives zero confidence; unprobed hypotheses stay PROPOSED', () => {
    assert.deepStrictEqual(scoreHypothesis([], [], false), { confidence: 0, status: 'PROPOSED' });
  });
  test('an experiment alone (no independent observation) cannot confirm', () => {
    const r = scoreHypothesis([{ kind: 'EXPERIMENT', weight: 0.6, description: '' }], [], true);
    assert.strictEqual(r.status, 'INCONCLUSIVE');
  });
});

describe('GHOST hypothesis discrimination', () => {
  test('distinguishes session expiry: H1 CONFIRMED, H2 REFUTED, via read-only GET only', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const s = sink();
    const d = await new GhostProber().diagnose({
      runId: 'r1', failureEvent: failure(401, '401 Unauthorized: Session has expired.'), sessionStatusUrl: SESSION_URL, guard,
      fetchImpl: fakeFetch(401, { active: false, error: 'Session expired' }, calls), page: fakePage({ missingRequired: [] }), sink: s
    });
    const [h1, h2] = d.hypotheses;
    assert.strictEqual(h1.status, 'CONFIRMED');
    assert.strictEqual(h2.status, 'REFUTED');
    assert.strictEqual(h1.confidenceScore, 0.8); // S = 0.6 + 0.25 + 0.15 = 1.0 → 1.0/1.25
    assert.strictEqual(d.leadingHypothesisId, h1.id);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].init?.method, 'GET');
    assert.strictEqual(calls[0].init?.body, undefined);
    assert.strictEqual(s.events.filter((e) => e.type === 'PROBE_EXECUTED').length, 2);
    assert.strictEqual(s.events.filter((e) => e.type === 'HYPOTHESIS_FORMULATED').length, 2);
    assert.ok(!JSON.stringify(s.events).includes('SES_'), 'probe must not keep tokens');
  });

  test('distinguishes missing dynamic requirement: H2 CONFIRMED, H1 REFUTED', async () => {
    const d = await new GhostProber().diagnose({
      runId: 'r1', failureEvent: failure(400, 'Validation Error: Merit scholarship requires statementOfPurpose to be uploaded.'),
      sessionStatusUrl: SESSION_URL, guard, fetchImpl: fakeFetch(200, { active: true, token: 'SES_ACTIVE_1' }, []),
      page: fakePage({ missingRequired: [{ field: 'statement_of_purpose', revealedBy: 'merit-scholarship', controllerChecked: true }] })
    });
    const [h1, h2] = d.hypotheses;
    assert.strictEqual(h1.status, 'REFUTED');
    assert.strictEqual(h1.confidenceScore, 0);
    assert.strictEqual(h2.status, 'CONFIRMED');
    assert.ok(h2.supportingEvidence.some((e) => e.includes('statement_of_purpose')));
    assert.ok(!JSON.stringify(d).includes('SES_ACTIVE_1'));
  });

  test('stays INCONCLUSIVE when probes fail, and recommends nothing', async () => {
    const failingFetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const d = await new GhostProber().diagnose({
      runId: 'r1', failureEvent: failure(500, 'Internal error'), sessionStatusUrl: SESSION_URL, guard,
      fetchImpl: failingFetch, page: fakePage(new Error('page closed'))
    });
    assert.ok(d.hypotheses.every((h) => h.status === 'INCONCLUSIVE'));
    assert.ok(d.hypotheses.every((h) => h.confidenceScore === 0));
    assert.strictEqual(d.conclusive, false);
    assert.strictEqual(d.leadingHypothesisId, null);
  });

  test('refuses to probe an off-allowlist session URL', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const d = await new GhostProber().diagnose({
      runId: 'r1', failureEvent: failure(401, 'expired'), sessionStatusUrl: 'http://evil.attacker.com/api/session', guard,
      fetchImpl: fakeFetch(401, {}, calls), page: fakePage({ missingRequired: [] })
    });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(d.probes[0].outcome, 'SKIPPED_POLICY');
    assert.notStrictEqual(d.hypotheses[0].status, 'CONFIRMED');
  });

  test('probe count is bounded by the budget', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const d = await new GhostProber().diagnose({
      runId: 'r1', failureEvent: failure(401, 'expired'), sessionStatusUrl: SESSION_URL, guard, maxProbes: 1,
      fetchImpl: fakeFetch(401, { active: false }, calls), page: fakePage({ missingRequired: [] })
    });
    assert.strictEqual(d.probes.filter((p) => p.outcome !== 'SKIPPED_BUDGET').length, 1);
    assert.ok(MAX_PROBES >= 2);
  });

  test('observation-only formulation has no hardcoded confidence and is PROPOSED', () => {
    const hs = new GhostProber().formulateHypotheses('r1', '401 Unauthorized: Session has expired', undefined, undefined, 401);
    assert.ok(hs.every((h) => h.status === 'PROPOSED'));
    assert.strictEqual(hs[0].confidenceScore, Math.round((0.4 / (0.4 + 0.25)) * 100) / 100);
    assert.strictEqual(hs[1].confidenceScore, 0);
  });
});

describe('Failure minimisation (ddmin)', () => {
  test('finds the minimal failing delta within the trial budget', async () => {
    const baseline = { a: 0, b: 0, c: 0, d: 0 };
    const failing = { a: 1, b: 1, c: 1, d: 1 };
    const r = await minimizeFailure(baseline, failing, async (x) => x.c === 1, 16);
    assert.deepStrictEqual(r.minimalDelta, { c: 1 });
    assert.ok(r.trials <= 16);
  });
  test('never exceeds maxTrials and reports exhaustion', async () => {
    let calls = 0;
    const r = await minimizeFailure({ a: 0, b: 0, c: 0, d: 0 }, { a: 1, b: 1, c: 1, d: 1 }, async (x) => { calls += 1; return x.a === 1 && x.d === 1; }, 2);
    assert.ok(calls <= 2);
    assert.strictEqual(r.exhaustedBudget, true);
  });
  test('reports non-reproduction instead of inventing a minimal input', async () => {
    const r = await minimizeFailure({ a: 0 }, { a: 1 }, async () => false, 5);
    assert.strictEqual(r.reproducedOriginal, false);
    assert.strictEqual(r.minimalInput, null);
  });
});
