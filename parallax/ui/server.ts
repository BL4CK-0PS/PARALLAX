import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoServer } from '../demo-app/server/server.ts';
import { ChronosTimeline } from '../src/chronos/timeline.ts';
import { redactDeep } from '../src/capture/redact.ts';
import { handlePlaygroundRoute } from './playground.ts';
import { RunController, SCENARIOS } from './runController.ts';
import type { RunControllerOptions, ScenarioId } from './runController.ts';
import { buildRunView } from './runView.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAX_BODY_BYTES = 8 * 1024;

export interface CommandCenterOptions {
  portalUrl?: string;
  dataDir?: string;
  benchmarkPath?: string;
  headless?: boolean;
  slowMoMs?: number;
  approvalPolicy?: RunControllerOptions['approvalPolicy'];
}

export type BenchmarkResult =
  | { available: true; source: string; modifiedAt: number; report: Record<string, unknown> }
  | { available: false; source: string; reason: string };

/** Reads and validates data/eval/before-after.json. Never substitutes numbers. */
export function readBenchmark(filePath: string): BenchmarkResult {
  const source = path.relative(ROOT, filePath) || filePath;
  if (!fs.existsSync(filePath)) return { available: false, source, reason: 'File not found. Run `npm run eval` to generate it.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { available: false, source, reason: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const isCounts = (v: unknown, keys: string[]): boolean =>
    typeof v === 'object' && v !== null && keys.every((k) => Number.isInteger((v as Record<string, unknown>)[k]) && ((v as Record<string, number>)[k] >= 0));
  const r = parsed as Record<string, unknown>;
  if (
    typeof parsed !== 'object' || parsed === null ||
    !isCounts(r.attacks, ['total', 'executedBefore', 'executedAfter', 'blockedAfter', 'gatedAfter']) ||
    !isCounts(r.benign, ['total', 'executedAfter', 'gatedAfter', 'blockedAfter']) ||
    !Array.isArray(r.results)
  ) {
    return { available: false, source, reason: 'File does not match the before/after report schema.' };
  }
  return { available: true, source, modifiedAt: fs.statSync(filePath).mtimeMs, report: r };
}

/**
 * Command Center HTTP server. Serves the dashboard, the live run state (JSON + SSE),
 * approval decisions, persisted-run replay, the benchmark file and the guard playground.
 */
export class CommandCenterUI {
  public port: number;
  public readonly controller: RunController;
  private readonly options: Required<Pick<CommandCenterOptions, 'portalUrl' | 'dataDir' | 'benchmarkPath'>>;
  private server?: http.Server;
  private demoServer?: DemoServer;
  private sseClients = new Set<http.ServerResponse>();
  private seq = 0;
  private broadcastTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;

  constructor(port = 5173, options: CommandCenterOptions = {}) {
    this.port = port;
    this.options = {
      portalUrl: options.portalUrl ?? 'http://127.0.0.1:3000/',
      dataDir: options.dataDir ?? path.join(ROOT, 'data', 'runs'),
      benchmarkPath: options.benchmarkPath ?? path.join(ROOT, 'data', 'eval', 'before-after.json')
    };
    this.controller = new RunController({
      portalUrl: this.options.portalUrl,
      dataDir: this.options.dataDir,
      headless: options.headless ?? process.env.PARALLAX_HEADED !== '1',
      slowMoMs: options.slowMoMs ?? (process.env.PARALLAX_SLOWMO ? Number(process.env.PARALLAX_SLOWMO) : undefined),
      approvalPolicy: options.approvalPolicy
    });
    this.controller.onUpdate(() => this.scheduleBroadcast());
  }

  public async startWithDemoServer(demoPort = 3000): Promise<void> {
    this.demoServer = new DemoServer(demoPort);
    await this.demoServer.start();
    console.log(`✔ [PARALLAX] Target Admissions Portal active on http://127.0.0.1:${demoPort}`);
    await this.start();
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((err: unknown) => {
          console.error('[PARALLAX] request failed:', err);
          if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
          else res.end();
        });
      });
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.heartbeat = setInterval(() => {
          // A named event (not an SSE comment) so the page can tell "quiet" from "dead";
          // must stay well under the page's 10 s staleness window.
          for (const c of this.sseClients) c.write(`event: ping\ndata: ${JSON.stringify({ seq: this.seq })}\n\n`);
        }, 4_000);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    for (const c of this.sseClients) c.end();
    this.sseClients.clear();
    await this.controller.abort();
    await this.controller.waitForIdle();
    if (this.demoServer) await this.demoServer.stop();
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
  }

  /** Coalesces bursts of events into one SSE notification per 100 ms. */
  private scheduleBroadcast(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      this.seq += 1;
      for (const c of this.sseClients) c.write(`event: update\ndata: ${JSON.stringify({ seq: this.seq })}\n\n`);
    }, 100);
  }

  /** State-changing requests must come from this origin with a JSON body (blocks CSRF). */
  private sameOriginJson(req: http.IncomingMessage): string | null {
    const allowed = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.includes(origin)) return `Origin ${origin} not allowed.`;
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return `Cross-site request refused (${String(site)}).`;
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return 'Content-Type must be application/json.';
    return null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const p = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8'));
      return;
    }

    if (p === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, { seq: this.seq, serverTime: Date.now(), scenarios: SCENARIOS, ...redactDeep(this.controller.liveState()) });
      return;
    }

    if (p === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: update\ndata: ${JSON.stringify({ seq: this.seq })}\n\n`);
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    if (p === '/api/screenshot' && req.method === 'GET') {
      const shot = this.controller.latestScreenshot();
      if (!shot) { sendJson(res, 404, { error: 'No screenshot captured yet.' }); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(shot);
      return;
    }

    if (p === '/api/benchmark' && req.method === 'GET') {
      sendJson(res, 200, readBenchmark(this.options.benchmarkPath));
      return;
    }

    if (p === '/api/portal/health' && req.method === 'GET') {
      try {
        const r = await fetch(new URL('/api/admin/applications', this.options.portalUrl), { signal: AbortSignal.timeout(2_000) });
        sendJson(res, 200, { reachable: r.ok, status: r.status, portalUrl: this.options.portalUrl });
      } catch (err) {
        sendJson(res, 200, { reachable: false, error: err instanceof Error ? err.message : String(err), portalUrl: this.options.portalUrl });
      }
      return;
    }

    if (p === '/api/runs' && req.method === 'GET') {
      const dir = this.options.dataDir;
      const runs = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ runId: f.slice(0, -6), modifiedAt: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 50)
        : [];
      sendJson(res, 200, { runs });
      return;
    }

    const runMatch = /^\/api\/runs\/([A-Za-z0-9_-]{1,80})$/.exec(p);
    if (runMatch && req.method === 'GET') {
      const file = path.join(this.options.dataDir, `${runMatch[1]}.jsonl`);
      const read = new ChronosTimeline().readRunFile(file, runMatch[1]);
      if (read.events.length === 0) { sendJson(res, 404, { error: 'Run not found or empty.', rejected: read.rejected }); return; }
      sendJson(res, 200, { runId: runMatch[1], rejected: read.rejected, view: buildRunView(read.events, read.chainValid) });
      return;
    }

    if (p === '/api/runs' && req.method === 'POST') {
      const refused = this.sameOriginJson(req);
      if (refused) { sendJson(res, 403, { error: refused }); return; }
      const body = await readJson(req);
      if (!body.ok) { sendJson(res, 400, { error: body.error }); return; }
      const scenario = (body.value as { scenario?: unknown }).scenario;
      if (typeof scenario !== 'string' || !(SCENARIOS as readonly string[]).includes(scenario)) {
        sendJson(res, 400, { error: `scenario must be one of ${SCENARIOS.join(', ')}` });
        return;
      }
      if (this.controller.isBusy()) { sendJson(res, 409, { error: 'A run is already in progress.' }); return; }
      const runId = this.controller.start(scenario as ScenarioId);
      sendJson(res, 202, { runId, scenario });
      return;
    }

    if (p === '/api/runs/abort' && req.method === 'POST') {
      const refused = this.sameOriginJson(req);
      if (refused) { sendJson(res, 403, { error: refused }); return; }
      await this.controller.abort();
      sendJson(res, 200, { aborted: true });
      return;
    }

    const approvalMatch = /^\/api\/approvals\/(apr_[A-Za-z0-9_]{1,60})$/.exec(p);
    if (approvalMatch && req.method === 'POST') {
      const refused = this.sameOriginJson(req);
      if (refused) { sendJson(res, 403, { error: refused }); return; }
      const body = await readJson(req);
      if (!body.ok) { sendJson(res, 400, { error: body.error }); return; }
      const { decision, notes } = body.value as { decision?: unknown; notes?: unknown };
      if (decision !== 'APPROVE' && decision !== 'DENY') { sendJson(res, 400, { error: 'decision must be APPROVE or DENY' }); return; }
      const ok = this.controller.resolveApproval(
        approvalMatch[1], decision === 'APPROVE', 'command-center-operator',
        typeof notes === 'string' ? notes.slice(0, 200) : undefined
      );
      if (!ok) { sendJson(res, 404, { error: 'No pending approval with this id (already decided or expired).' }); return; }
      sendJson(res, 200, { id: approvalMatch[1], decision });
      return;
    }

    if (handlePlaygroundRoute(req, res, p)) return;

    sendJson(res, 404, { error: 'Not found' });
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJson(req: http.IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { resolve({ ok: false, error: 'Body too large.' }); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        if (typeof v !== 'object' || v === null || Array.isArray(v)) resolve({ ok: false, error: 'Body must be a JSON object.' });
        else resolve({ ok: true, value: v as Record<string, unknown> });
      } catch {
        resolve({ ok: false, error: 'Body must be valid JSON.' });
      }
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

if (process.argv[1] && process.argv[1].endsWith(path.join('ui', 'server.ts'))) {
  const ui = new CommandCenterUI(5173);
  ui.startWithDemoServer(3000).then(() => {
    console.log('✔ [PARALLAX] Command Center active on http://127.0.0.1:5173');
  }).catch((err: unknown) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
}
