import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventRecord } from '../src/core/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class CommandCenterUI {
  private server?: http.Server;
  private events: EventRecord[] = [];
  private pendingApproval?: { id: string; action: string; target: string; runId: string };
  public port: number;

  constructor(port = 5173) {
    this.port = port;
  }

  public pushEvent(evt: EventRecord): void {
    this.events.push(evt);
    if (evt.type === 'APPROVAL_REQUESTED') {
      this.pendingApproval = {
        id: evt.id,
        action: String(evt.payload.humanLabel || 'Unknown Action'),
        target: String(evt.payload.target || 'DOM Selector'),
        runId: evt.runId
      };
    }
  }

  public clear(): void {
    this.events = [];
    this.pendingApproval = undefined;
  }

  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const parsed = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (parsed.pathname === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ events: this.events, pendingApproval: this.pendingApproval }));
          return;
        }

        if (parsed.pathname === '/api/approve' && req.method === 'POST') {
          this.pendingApproval = undefined;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ approved: true }));
          return;
        }

        const htmlPath = path.join(__dirname, 'index.html');
        if (fs.existsSync(htmlPath)) {
          const content = fs.readFileSync(htmlPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('UI Not Found');
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const ui = new CommandCenterUI(5173);
  ui.start().then(() => {
    console.log(`[PARALLAX] Command Center UI running on http://127.0.0.1:5173`);
  });
}
