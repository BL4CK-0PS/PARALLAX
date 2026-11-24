import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { CommandCenterUI } from '../../ui/server.ts';
import { tmpDir } from './helpers.ts';

const UI_PORT = 5196;
const PORTAL_PORT = 3196;
const URL_ = `http://127.0.0.1:${UI_PORT}/`;
const dir = tmpDir('parallax-ui-');
const benchPath = path.join(dir, 'before-after.json');
const BENCH = { attacks: { total: 17, executedBefore: 17, executedAfter: 1, blockedAfter: 12, gatedAfter: 4 }, benign: { total: 6, executedAfter: 5, gatedAfter: 1, blockedAfter: 0 }, results: [] };
const ui = new CommandCenterUI(UI_PORT, { portalUrl: `http://127.0.0.1:${PORTAL_PORT}/`, dataDir: dir, benchmarkPath: benchPath });
let browser: Browser;
let page: Page;
type State = { status: string; view: { events: Array<{ id: string; type: string; payload: Record<string, unknown> }>; hypotheses: Array<{ hypothesis: { status: string; confidenceScore: number } }> } };
const state = async (): Promise<State> => (await (await fetch(`${URL_}api/state`)).json()) as State;
const waitStatus = (statuses: string[]) => page.waitForFunction((s) => s.includes(document.getElementById('status-pill')!.textContent ?? ''), statuses, { timeout: 60_000 });

async function startRun(scenario: string): Promise<void> {
  await page.selectOption('#scenario', scenario);
  await page.click('#start');
}
async function decide(button: 'Approve' | 'Deny'): Promise<void> {
  const card = page.locator('.approval').first();
  await card.waitFor({ timeout: 30_000 });
  await card.getByRole('button', { name: new RegExp(button) }).click();
  await card.waitFor({ state: 'detached', timeout: 30_000 });
}

before(async () => {
  fs.writeFileSync(benchPath, JSON.stringify(BENCH));
  await ui.startWithDemoServer(PORTAL_PORT);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto(URL_);
});
after(async () => {
  await browser.close();
  await ui.stop().catch(() => undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Command Center dashboard (real browser against real backend)', () => {
  test('benchmark panel shows the numbers from the file, not constants', async () => {
    await page.locator('[data-bench="available"]').waitFor();
    assert.strictEqual(await page.textContent('[data-bench-after="Blocked outright"]'), '12');
    assert.strictEqual(await page.textContent('[data-bench-after="Paused for approval"]'), '4');
    assert.match((await page.textContent('#bench')) ?? '', /of 17/);
  });

  test('Approve button drives the real approval gate and the run completes verified', async () => {
    await startRun('normal');
    const card = page.locator('.approval').first();
    await card.waitFor({ timeout: 30_000 });
    assert.match(await card.innerText(), /Submit application/);
    assert.strictEqual(await card.locator('img').count(), 1, 'element screenshot shown');
    await decide('Approve');
    await waitStatus(['VERIFIED']);
    const s = await state();
    const granted = s.view.events.find((e) => e.type === 'APPROVAL_GRANTED');
    assert.strictEqual(granted?.payload.operator, 'command-center-operator');
    assert.ok(s.view.events.some((e) => e.type === 'ACTION_DISPATCHED' && e.payload.actionType === 'SUBMIT'));
  });

  test('timeline renders the actual events and selection opens evidence', async () => {
    const s = await state();
    await page.waitForFunction((n) => document.querySelectorAll('#timeline li[data-event-id]').length === n, s.view.events.length);
    const ids = await page.$$eval('#timeline li[data-event-id]', (els) => els.map((e) => e.getAttribute('data-event-id')));
    assert.deepStrictEqual(ids, s.view.events.map((e) => e.id));
    const target = s.view.events.find((e) => e.type === 'APPROVAL_REQUESTED')!;
    await page.click(`#timeline li[data-event-id="${target.id}"]`);
    const inspector = (await page.textContent('#inspector')) ?? '';
    assert.ok(inspector.includes(target.id));
    assert.ok(inspector.includes('RULE_HUMAN_APPROVAL_GATE'));
    assert.strictEqual(await page.getAttribute(`#timeline li[data-event-id="${target.id}"]`, 'data-category'), 'AWAITING_APPROVAL');
  });

  test('Deny button cancels execution', async () => {
    await startRun('normal');
    await decide('Deny');
    await waitStatus(['COMPLETED', 'FAILED']);
    const s = await state();
    assert.strictEqual(s.status, 'COMPLETED');
    assert.ok(s.view.events.some((e) => e.type === 'APPROVAL_DENIED' && e.payload.operator === 'command-center-operator'));
    assert.ok(!s.view.events.some((e) => e.type === 'ACTION_DISPATCHED' && e.payload.actionType === 'SUBMIT'));
  });

  test('hypotheses render with the statuses and confidences computed by GHOST', async () => {
    await startRun('session-expiry');
    await decide('Approve');
    await decide('Approve');
    await waitStatus(['VERIFIED']);
    const s = await state();
    await page.waitForFunction(() => document.querySelectorAll('.hyp').length === 2);
    const shown = await page.$$eval('.hyp', (els) => els.map((e) => [e.getAttribute('data-hypothesis-status'), e.querySelector('[data-confidence]')?.getAttribute('data-confidence')]));
    assert.deepStrictEqual(shown, s.view.hypotheses.map((h) => [h.hypothesis.status, String(h.hypothesis.confidenceScore)]));
    assert.match((await page.textContent('#recon')) ?? '', /last good state: evt_/);
    await page.click('#timeline li[data-category="FAILURE"]');
    assert.match((await page.textContent('#inspector')) ?? '', /HTTP_ERROR/);
  });

  test('replay of a persisted run loads from the run list', async () => {
    const s = await state() as State & { runId: string };
    const runId = (await (await fetch(`${URL_}api/state`)).json() as { runId: string }).runId;
    await page.waitForFunction((id) => [...document.querySelectorAll('#runs option')].some((o) => (o as HTMLOptionElement).value === id), runId, { timeout: 10_000 });
    await page.selectOption('#runs', runId);
    await page.waitForFunction(() => document.getElementById('status-pill')!.textContent === 'REPLAY');
    assert.strictEqual(await page.locator('#timeline li[data-event-id]').count(), s.view.events.length);
    await page.click('#replay');
    await page.locator('#timeline li.future').first().waitFor();
    await page.click('#replay-stop');
    await page.selectOption('#runs', 'live');
  });

  test('a quiet run waiting for a human is not reported as disconnected', async () => {
    await startRun('normal');
    await page.locator('.approval').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(13_000); // longer than the 10 s staleness window, with no state changes
    assert.strictEqual(await page.textContent('#conn'), 'live (SSE)');
    assert.doesNotMatch((await page.textContent('#banner')) ?? '', /stale/i);
    await decide('Deny');
    await waitStatus(['COMPLETED', 'VERIFIED', 'FAILED']);
  });

  test('missing benchmark file renders an explicit unavailable state', async () => {
    fs.renameSync(benchPath, `${benchPath}.bak`);
    await page.reload();
    await page.locator('[data-bench="unavailable"]').waitFor();
    assert.match((await page.textContent('#bench')) ?? '', /File not found/);
  });

  test('disconnected backend is shown, not silently ignored', async () => {
    await ui.stop();
    await page.waitForFunction(() => /reconnecting|disconnected/.test(document.getElementById('conn')!.textContent ?? ''), undefined, { timeout: 15_000 });
    await page.waitForFunction(() => document.getElementById('banner')!.textContent !== '', undefined, { timeout: 15_000 });
    assert.match((await page.textContent('#banner')) ?? '', /error|stale/i);
  });
});
