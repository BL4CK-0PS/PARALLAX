import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CommandCenterUI, readBenchmark } from '../../ui/server.ts';
import { RunRecorder } from '../../src/capture/recorder.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallax-cc-'));
const benchPath = path.join(dir, 'before-after.json');
const PORT = 5197;
const base = `http://127.0.0.1:${PORT}`;
const ui = new CommandCenterUI(PORT, { portalUrl: 'http://127.0.0.1:3197/', dataDir: dir, benchmarkPath: benchPath });

before(async () => { await ui.start(); });
after(async () => { await ui.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('Benchmark file (Panel F source)', () => {
  test('missing file is reported as unavailable, never substituted', () => {
    const r = readBenchmark(path.join(dir, 'absent.json'));
    assert.strictEqual(r.available, false);
  });
  test('invalid JSON and wrong schema are unavailable', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
    assert.strictEqual(readBenchmark(path.join(dir, 'bad.json')).available, false);
    fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({ attacks: { total: '14' }, benign: {}, results: [] }));
    assert.strictEqual(readBenchmark(path.join(dir, 'schema.json')).available, false);
  });
  test('serves exactly the numbers in the file', async () => {
    const report = { attacks: { total: 9, executedBefore: 9, executedAfter: 2, blockedAfter: 5, gatedAfter: 2 }, benign: { total: 4, executedAfter: 3, gatedAfter: 1, blockedAfter: 0 }, results: [] };
    fs.writeFileSync(benchPath, JSON.stringify(report));
    const body = (await (await fetch(`${base}/api/benchmark`)).json()) as { available: boolean; report: typeof report };
    assert.strictEqual(body.available, true);
    assert.deepStrictEqual(body.report, report);
  });
});

describe('Command Center API security and state', () => {
  test('state endpoint returns IDLE with an empty view before any run', async () => {
    const s = (await (await fetch(`${base}/api/state`)).json()) as { status: string; view: { events: unknown[] }; pendingApprovals: unknown[] };
    assert.strictEqual(s.status, 'IDLE');
    assert.deepStrictEqual(s.view.events, []);
    assert.deepStrictEqual(s.pendingApprovals, []);
  });
  test('cross-origin approval is refused (CSRF)', async () => {
    const r = await fetch(`${base}/api/approvals/apr_1_1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.attacker.com' }, body: '{"decision":"APPROVE"}' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  });
  test('form-encoded (simple CORS) approval is refused', async () => {
    const r = await fetch(`${base}/api/approvals/apr_1_1`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'decision=APPROVE' });
    assert.strictEqual(r.status, 403);
  });
  test('unknown approval id is 404 and bad decision is 400', async () => {
    const h = { 'Content-Type': 'application/json' };
    assert.strictEqual((await fetch(`${base}/api/approvals/apr_404_1`, { method: 'POST', headers: h, body: '{"decision":"APPROVE"}' })).status, 404);
    assert.strictEqual((await fetch(`${base}/api/approvals/apr_404_1`, { method: 'POST', headers: h, body: '{"decision":"MAYBE"}' })).status, 400);
  });
  test('unknown scenario is rejected', async () => {
    const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"scenario":"rm -rf"}' });
    assert.strictEqual(r.status, 400);
  });
  test('persisted run replay goes through CHRONOS with chain verification', async () => {
    const rec = new RunRecorder('run_replay_api', dir);
    rec.record('BROWSER_NAVIGATED', 'BROWSER', { url: 'http://127.0.0.1:3197/' });
    rec.record('FAILURE_DETECTED', 'TARGET_APP', { kind: 'HTTP_ERROR', status: 401, error: 'Session expired' });
    const list = (await (await fetch(`${base}/api/runs`)).json()) as { runs: Array<{ runId: string }> };
    assert.ok(list.runs.some((r) => r.runId === 'run_replay_api'));
    const body = (await (await fetch(`${base}/api/runs/run_replay_api`)).json()) as { view: { eventCount: number; chainValid: boolean; timeline: Array<{ category: string }> } };
    assert.strictEqual(body.view.eventCount, 2);
    assert.strictEqual(body.view.chainValid, true);
    assert.strictEqual(body.view.timeline[1].category, 'FAILURE');
    assert.strictEqual((await fetch(`${base}/api/runs/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  });
});
