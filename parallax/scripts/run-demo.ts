import * as readline from 'node:readline/promises';
import { DemoServer } from '../demo-app/server/server.ts';
import { RunController, SCENARIOS } from '../ui/runController.ts';
import type { ScenarioId } from '../ui/runController.ts';

/**
 * Terminal demo: runs one real scenario in a real Chromium browser.
 *   npm run demo:run -- [scenario] [--auto]
 * Approvals are asked on the terminal. --auto approves submits and denies the spoofed Pay
 * click (for unattended runs); it decides through the same approval gate as a human.
 */
const args = process.argv.slice(2);
const scenario = (args.find((a) => !a.startsWith('--')) ?? 'full-demo') as ScenarioId;
const auto = args.includes('--auto');
if (!SCENARIOS.includes(scenario)) {
  console.error(`Unknown scenario '${scenario}'. Choose one of: ${SCENARIOS.join(', ')}`);
  process.exit(2);
}

const port = Number(process.env.PARALLAX_PORTAL_PORT ?? 3000);
const server = new DemoServer(port);
await server.start();
const rl = auto ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
const controller = new RunController({
  portalUrl: `http://127.0.0.1:${port}/`,
  headless: process.env.PARALLAX_HEADED !== '1',
  approvalPolicy: auto ? (req) => (req.target.includes('fee-action') ? 'DENY' : 'APPROVE') : undefined
});

const asked = new Set<string>();
let printed = 0;
controller.onUpdate(() => {
  const s = controller.liveState();
  for (const t of s.view.timeline.slice(printed)) {
    const mark = { NORMAL: ' ', FAILURE: '✖', GUARD_BLOCKED: '⛔', AWAITING_APPROVAL: '⏸' }[t.category];
    console.log(`${mark} ${new Date(t.timestamp).toISOString().slice(11, 23)} ${t.type.padEnd(22)} ${t.summary.slice(0, 140)}`);
  }
  printed = s.view.timeline.length;
  if (!rl) return;
  for (const a of s.pendingApprovals) {
    if (asked.has(a.id)) continue;
    asked.add(a.id);
    void (async () => {
      console.log(`\n  APPROVAL NEEDED: ${a.actionType} ${a.target}`);
      console.log(`  Agent label (untrusted): "${a.agentLabel}"`);
      console.log(`  Element actually reads:  "${a.dom?.text ?? a.dom?.ariaLabel ?? '(no text)'}"`);
      console.log(`  Guard: ${a.guardReason}`);
      let answer = '';
      try {
        answer = (await rl.question('  Approve? [y/N] ')).trim().toLowerCase();
      } catch {
        // stdin closed or not interactive: fail closed (deny). Use --auto for unattended runs.
        console.log('\n  No interactive input available — denying (run with --auto for unattended demos).');
      }
      controller.resolveApproval(a.id, answer === 'y' || answer === 'yes', 'terminal-operator');
    })();
  }
});

console.log(`PARALLAX demo: scenario '${scenario}' against http://127.0.0.1:${port}/ (real Chromium)\n`);
controller.start(scenario);
await controller.waitForIdle();
const final = controller.liveState();
console.log(`\nRESULT: ${final.status} — ${final.outcomeSummary ?? final.error ?? ''}`);
console.log(`Run ID: ${final.runId}  events: ${final.view.eventCount}  hash chain: ${final.view.chainValid ? 'valid' : 'INVALID'}`);
rl?.close();
await server.stop();
process.exit(final.status === 'VERIFIED' || final.status === 'COMPLETED' ? 0 : 1);
