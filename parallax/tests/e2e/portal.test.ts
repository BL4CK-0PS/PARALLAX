import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { DemoServer } from '../../demo-app/server/server.ts';
import { PROMPT_INJECTION_PAYLOAD } from '../../demo-app/failures/payloads.ts';
import { PortalAgent } from '../../src/capture/portalAgent.ts';
import { GhostProber } from '../../src/ghost/prober.ts';
import { loadPersonas } from '../../ui/runController.ts';
import { makeRig, nextApproval } from './helpers.ts';
import type { Rig } from './helpers.ts';

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}/`;
const server = new DemoServer(PORT);
const personas = loadPersonas();
let rig: Rig;
let agent: PortalAgent;

const page = () => rig.capture.pageForExecutor();
const api = async (path: string) => (await fetch(new URL(path, BASE))).json() as Promise<Record<string, unknown>>;

async function fresh(runId: string): Promise<void> {
  if (rig) { await rig.capture.close(); fs.rmSync(rig.dir, { recursive: true, force: true }); }
  server.reset();
  rig = await makeRig(BASE, runId);
  agent = new PortalAgent({ executor: rig.executor, capture: rig.capture, sink: rig.recorder });
  assert.strictEqual((await agent.open(BASE)).status, 'EXECUTED');
}

before(async () => { await server.start(); });
after(async () => { await rig.capture.close(); fs.rmSync(rig.dir, { recursive: true, force: true }); await server.stop(); });

describe('Synthetic portal (real browser, real backend)', () => {
  test('step 1 validation blocks bad input client-side without calling the backend', async () => {
    await fresh('run_portal_v');
    const r = await agent.fillStep1({ ...personas.standardApplicant, email: 'not-an-email', studentId: 'bad' });
    assert.strictEqual(r.stepAfter, 1);
    assert.strictEqual(await page().getAttribute('#student-email', 'aria-invalid'), 'true');
    assert.match((await page().textContent('#err-student-id')) ?? '', /CS26-0912/);
    assert.ok(!rig.recorder.events().some((e) => e.type === 'NETWORK_REQUEST' && String(e.payload.url).includes('/api/apply/step1')));
  });

  test('backend independently rejects missing step 1 fields', async () => {
    const res = await fetch(new URL('/api/apply/step1', BASE), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(res.status, 400);
  });

  test('step 2: course selection works and the scholarship checkbox reveals a required document field', async () => {
    await fresh('run_portal_s2');
    assert.strictEqual((await agent.fillStep1(personas.scholarApplicant)).stepAfter, 2);
    assert.strictEqual(await page().isVisible('#statement_of_purpose'), false);
    const o = await agent.fillStep2(personas.scholarApplicant, { includeDocument: false });
    assert.strictEqual(o, null);
    assert.strictEqual(await page().inputValue('#course'), 'MS AI');
    assert.strictEqual(await page().isVisible('#statement_of_purpose'), true);
    assert.strictEqual(await page().evaluate(() => (document.getElementById('statement_of_purpose') as HTMLTextAreaElement).required), true);
  });

  test('missing supporting document is rejected by the backend (Failure B) and evidenced', async () => {
    const r = await agent.continueToReview();
    assert.strictEqual(r.stepAfter, 2);
    assert.ok(r.errorShown);
    await rig.capture.flush();
    const f = rig.recorder.events().find((e) => e.type === 'FAILURE_DETECTED' && e.payload.path === '/api/apply/step2');
    assert.ok(f);
    assert.strictEqual(f.payload.status, 400);
    assert.match(String(f.payload.error), /statementOfPurpose/);
  });

  test('GHOST probes on this real failure are read-only (backend and DOM unchanged)', async () => {
    await rig.capture.flush();
    const failure = rig.recorder.events().find((e) => e.type === 'FAILURE_DETECTED' && e.payload.path === '/api/apply/step2')!;
    const domBefore = await page().content();
    const appsBefore = await api('/api/admin/applications');
    const eventsBefore = rig.recorder.events().length;
    const d = await new GhostProber().diagnose({
      runId: rig.recorder.runId, failureEvent: failure, sessionStatusUrl: new URL('/api/session', BASE).toString(), guard: rig.guard, page: page(),
      sink: { runId: rig.recorder.runId, record: (t, a, p) => rig.recorder.record(t, a, p) }
    });
    assert.strictEqual(d.hypotheses[1].status, 'CONFIRMED');
    assert.strictEqual(d.hypotheses[0].status, 'REFUTED');
    assert.strictEqual(await page().content(), domBefore);
    assert.deepStrictEqual(await api('/api/admin/applications'), appsBefore);
    const newEvents = rig.recorder.events().slice(eventsBefore);
    assert.ok(!newEvents.some((e) => e.type === 'NETWORK_REQUEST' || e.type === 'ACTION_DISPATCHED'), 'probes caused no browser traffic or actions');
    assert.strictEqual(newEvents.filter((e) => e.type === 'PROBE_EXECUTED').length, 2);
  });

  test('a valid document passes backend validation', async () => {
    assert.strictEqual((await rig.executor.execute({ id: 'doc', type: 'TYPE', target: 'textarea#statement_of_purpose', value: personas.scholarApplicant.supportingDocument, humanLabel: 'doc' })).status, 'EXECUTED');
    const r = await agent.continueToReview();
    assert.strictEqual(r.stepAfter, 3);
  });

  test('the injection payload is concealed until the reveal toggle, and stays page data', async () => {
    // Back to step 2 to inspect the spoiler.
    await rig.executor.execute({ id: 'back', type: 'CLICK', target: '#btn-back-3', humanLabel: 'back' });
    const color = await page().$eval('#draft-comment-text', (el) => getComputedStyle(el).color);
    assert.strictEqual(color, 'rgba(0, 0, 0, 0)');
    assert.strictEqual((await page().textContent('#draft-comment-text'))?.trim(), PROMPT_INJECTION_PAYLOAD);
    await agent.revealHiddenText();
    assert.notStrictEqual(await page().$eval('#draft-comment-text', (el) => getComputedStyle(el).color), 'rgba(0, 0, 0, 0)');
    assert.strictEqual(await page().getAttribute('#reveal-hidden', 'aria-pressed'), 'true');
    assert.strictEqual((await agent.continueToReview()).stepAfter, 3);
  });

  test('final submission requires approval and returns the real backend application ID', async () => {
    assert.strictEqual((await agent.attest()).outcome.status, 'EXECUTED');
    const pending = agent.submitApplication();
    const id = await nextApproval(rig.gate);
    assert.deepStrictEqual((await api('/api/admin/applications')).applications, [], 'nothing filed while awaiting approval');
    rig.gate.resolve(id, true, 'tester');
    const r = await pending;
    assert.strictEqual(r.outcome.status, 'EXECUTED');
    const shown = await agent.applicationIdShown();
    const apps = (await api('/api/admin/applications')).applications as Array<{ id: string; studentId: string; meritScholarship: boolean }>;
    assert.strictEqual(apps.length, 1);
    assert.strictEqual(apps[0].id, shown);
    assert.strictEqual(apps[0].studentId, personas.scholarApplicant.studentId);
    assert.strictEqual(apps[0].meritScholarship, true);
  });

  test('backend refuses to fabricate an application that was never filed', async () => {
    const res = await fetch(new URL('/api/apply/submit', BASE), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"studentId":"NO00-0000"}' });
    assert.strictEqual(res.status, 409);
  });

  test('draft state survives a page refresh', async () => {
    await fresh('run_portal_refresh');
    await rig.executor.execute({ id: 't', type: 'TYPE', target: '#student-name', value: 'Refresh Test', humanLabel: 'name' });
    await rig.executor.execute({ id: 'r', type: 'NAVIGATE', target: 'browser', value: BASE, humanLabel: 'reload' });
    assert.strictEqual(await page().inputValue('#student-name'), 'Refresh Test');
  });
});
