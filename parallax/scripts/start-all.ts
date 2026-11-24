import { CommandCenterUI } from '../ui/server.ts';

async function main() {
  console.clear();
  console.log('======================================================================');
  console.log('  PARALLAX // AUTONOMOUS DIGITAL REALITY INTELLIGENCE PLATFORM');
  console.log('  Team: BL4CK_0P$ | Track 2: Beyond the Browser | wHACKiest 2026');
  console.log('======================================================================\n');

  const ui = new CommandCenterUI(5173);
  await ui.startWithDemoServer(3000);

  console.log('\n----------------------------------------------------------------------');
  console.log('  HOW TO VIEW AND DEMO:');
  console.log('----------------------------------------------------------------------');
  console.log('  1. Target Admissions Portal : http://localhost:3000');
  console.log('  2. Reality Command Center   : http://localhost:5173');
  console.log('----------------------------------------------------------------------');
  console.log('  ▶ Open http://localhost:5173, pick a scenario (full-demo) and press "Start run".');
  console.log('  ▶ A real Chromium (headless; PARALLAX_HEADED=1 to watch it) drives the portal.');
  console.log('  ▶ Deny the spoofed Pay click, approve the final submit, watch GHOST/CHRONOS diagnose');
  console.log('    the injected session expiry, approve the resubmission, then press Replay.');
  console.log('----------------------------------------------------------------------\n');
  console.log('  Press Ctrl+C to stop the servers at any time.\n');

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
