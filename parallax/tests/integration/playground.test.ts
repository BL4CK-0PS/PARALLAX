import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import { CommandCenterUI } from '../../ui/server.ts';
import { evaluatePlaygroundInput } from '../../ui/playground.ts';

describe('Attack playground: input handling', () => {
  test('blocks a userinfo-trick URL', () => {
    const v = evaluatePlaygroundInput({ url: 'http://127.0.0.1@evil.attacker.com/' });
    assert.ok(v.ok);
    assert.strictEqual(v.ok && v.outcome, 'BLOCKED');
  });

  test('gates a disguised Pay button from its page text, not the agent label', () => {
    const v = evaluatePlaygroundInput({
      action: { type: 'CLICK', humanLabel: 'View fee details', dom: { tagName: 'button', text: 'Pay ₹5,000 now' } }
    });
    assert.strictEqual(v.ok && v.outcome, 'NEEDS_APPROVAL');
  });

  test('lets a harmless button through', () => {
    const v = evaluatePlaygroundInput({
      action: { type: 'CLICK', humanLabel: 'Pay now', dom: { tagName: 'button', text: 'Show FAQ' } }
    });
    assert.strictEqual(v.ok && v.outcome, 'EXECUTED');
  });

  test('ignores a visitor trying to self-declare an action as safe', () => {
    const v = evaluatePlaygroundInput({
      action: { type: 'TYPE', isStateChanging: false, dom: { tagName: 'input', inputType: 'password' } }
    });
    assert.strictEqual(v.ok && v.outcome, 'BLOCKED');
  });

  test('rejects malformed input instead of guessing', () => {
    assert.strictEqual(evaluatePlaygroundInput(null).ok, false);
    assert.strictEqual(evaluatePlaygroundInput({}).ok, false);
    assert.strictEqual(evaluatePlaygroundInput({ action: { type: 'EXEC_SHELL' } }).ok, false);
  });
});

describe('Attack playground: HTTP routes', () => {
  const ui = new CommandCenterUI(5199);
  const base = 'http://127.0.0.1:5199';
  before(async () => { await ui.start(); });
  after(async () => { await ui.stop(); });

  test('GET /api/eval returns the before/after report', async () => {
    const res = await fetch(`${base}/api/eval`, { signal: AbortSignal.timeout(3000) });
    assert.strictEqual(res.status, 200);
    const data = (await res.json()) as any;
    assert.strictEqual(data.attacks.executedAfter, 0);
    assert.strictEqual(data.attacks.executedBefore, data.attacks.total);
  });

  test('POST /api/guard/check evaluates a URL', async () => {
    const res = await fetch(`${base}/api/guard/check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://webhook.site/x' }), signal: AbortSignal.timeout(3000)
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(((await res.json()) as any).outcome, 'BLOCKED');
  });

  test('POST /api/guard/check rejects invalid JSON with 400', async () => {
    const res = await fetch(`${base}/api/guard/check`, {
      method: 'POST', body: '{not json', signal: AbortSignal.timeout(3000)
    });
    assert.strictEqual(res.status, 400);
  });

  test('GET /playground serves the page', async () => {
    const res = await fetch(`${base}/playground`, { signal: AbortSignal.timeout(3000) });
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /Attack playground/);
  });
});
