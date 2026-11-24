import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Action, PolicyDecision } from '../../src/core/types.ts';
import { DeterministicPolicyGuard } from '../../src/policy/guard.ts';
import { ApprovalGate } from '../../src/capture/approval.ts';
import { BrowserCapture } from '../../src/capture/browser.ts';
import { GuardedExecutor } from '../../src/capture/executor.ts';
import { RunRecorder } from '../../src/capture/recorder.ts';

/** P1's real guard, recording exactly what it was asked to evaluate. */
export class SpyGuard extends DeterministicPolicyGuard {
  public calls: Action[] = [];
  public override evaluateAction(action: Action, runId?: string): PolicyDecision {
    this.calls.push(structuredClone(action));
    return super.evaluateAction(action, runId);
  }
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Serves fixed routes on 127.0.0.1 (allowlisted) for capture tests. */
export async function serveFixtures(port: number, routes: Record<string, { type: string; status?: number; body: string }>): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url ?? '/', 'http://x').pathname];
    if (!route) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('nf'); return; }
    res.writeHead(route.status ?? 200, { 'Content-Type': route.type });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  return server;
}

export async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export interface Rig { guard: SpyGuard; gate: ApprovalGate; recorder: RunRecorder; capture: BrowserCapture; executor: GuardedExecutor; dir: string }

export async function makeRig(appOrigin: string, runId: string): Promise<Rig> {
  const dir = tmpDir('parallax-e2e-');
  const guard = new SpyGuard();
  const gate = new ApprovalGate(60_000);
  const recorder = new RunRecorder(runId, dir);
  const capture = new BrowserCapture({ guard, sink: recorder, appOrigin });
  await capture.launch();
  const executor = new GuardedExecutor({ capture, guard, gate, sink: recorder });
  return { guard, gate, recorder, capture, executor, dir };
}

/** Resolves when the gate has a pending request (event-driven, bounded). */
export function nextApproval(gate: ApprovalGate, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const existing = gate.list()[0];
    if (existing) { resolve(existing.id); return; }
    const timer = setTimeout(() => { off(); reject(new Error('no approval requested')); }, timeoutMs);
    const off = gate.onChange(() => {
      const p = gate.list()[0];
      if (p) { clearTimeout(timer); off(); resolve(p.id); }
    });
  });
}
