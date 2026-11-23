import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ApplicationRecord {
  id: string;
  studentId: string;
  name: string;
  course: string;
  meritScholarship: boolean;
  statementOfPurpose?: string;
  status: 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';
  timestamp: number;
}

export class DemoServer {
  private server?: http.Server;
  private isSessionActive = true;
  private pendingApplications: Map<string, Partial<ApplicationRecord>> = new Map();
  private acceptedApplications: ApplicationRecord[] = [];
  public port: number;

  constructor(port = 3000) {
    this.port = port;
  }

  public setSessionActive(active: boolean): void {
    this.isSessionActive = active;
  }

  public reset(): void {
    this.isSessionActive = true;
    this.pendingApplications.clear();
    this.acceptedApplications = [];
  }

  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
        const pathname = parsedUrl.pathname;

        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // --- API ROUTES ---

        // 1. Session Status
        if (pathname === '/api/session' && req.method === 'GET') {
          if (!this.isSessionActive) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ active: false, error: 'Session expired' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ active: true, user: 'student_applicant', token: 'SES_ACTIVE_98234' }));
          return;
        }

        // 2. Injected Failure Trigger: Expire Session
        if (pathname === '/api/session/expire') {
          this.isSessionActive = false;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ active: false, message: 'Session manually expired for testing' }));
          return;
        }

        // 3. Recovery Trigger: Refresh Session
        if (pathname === '/api/session/refresh') {
          this.isSessionActive = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ active: true, token: 'SES_RENEWED_10928' }));
          return;
        }

        // 4. Step 1: Personal Information
        if (pathname === '/api/apply/step1' && req.method === 'POST') {
          this.parseJsonBody(req, (data) => {
            const studentId = String(data.studentId || 'CS26-0912');
            this.pendingApplications.set(studentId, {
              studentId,
              name: String(data.name || 'Alex Chen'),
              status: 'SUBMITTED',
              timestamp: Date.now()
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, step: 1, studentId }));
          });
          return;
        }

        // 5. Step 2: Academic & Scholarship Details
        if (pathname === '/api/apply/step2' && req.method === 'POST') {
          this.parseJsonBody(req, (data) => {
            const studentId = String(data.studentId || 'CS26-0912');
            const app = this.pendingApplications.get(studentId) || { studentId };

            const isMerit = data.meritScholarship === true || data.meritScholarship === 'true';
            const sop = String(data.statementOfPurpose || '').trim();

            // Injectable Failure: Hidden Field Dependency
            if (isMerit && !sop) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  success: false,
                  error: 'Validation Error: Merit scholarship requires statementOfPurpose to be uploaded.'
                })
              );
              return;
            }

            app.course = String(data.course || 'M.Tech CSE');
            app.meritScholarship = isMerit;
            app.statementOfPurpose = sop;
            this.pendingApplications.set(studentId, app);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, step: 2, studentId }));
          });
          return;
        }

        // 6. Step 3: Final Submit Application
        if (pathname === '/api/apply/submit' && req.method === 'POST') {
          if (!this.isSessionActive) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: false,
                error: '401 Unauthorized: Session has expired. Please re-authenticate before submission.'
              })
            );
            return;
          }

          this.parseJsonBody(req, (data) => {
            const studentId = String(data.studentId || 'CS26-0912');
            const pending = this.pendingApplications.get(studentId) || {
              studentId,
              name: 'Alex Chen',
              course: 'M.Tech CSE',
              meritScholarship: false
            };

            const record: ApplicationRecord = {
              id: `APP-2026-${Math.floor(1000 + Math.random() * 9000)}`,
              studentId,
              name: pending.name || 'Alex Chen',
              course: pending.course || 'M.Tech CSE',
              meritScholarship: !!pending.meritScholarship,
              statementOfPurpose: pending.statementOfPurpose,
              status: 'ACCEPTED',
              timestamp: Date.now()
            };

            this.acceptedApplications.push(record);
            this.pendingApplications.delete(studentId);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: true,
                applicationId: record.id,
                studentId: record.studentId,
                status: record.status
              })
            );
          });
          return;
        }

        // 7. Verification API: Admin Check
        if (pathname === '/api/admin/applications' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ applications: this.acceptedApplications }));
          return;
        }

        // --- STATIC PAGE SERVING ---
        const pagePath = path.join(__dirname, '../pages/index.html');
        if (fs.existsSync(pagePath)) {
          const content = fs.readFileSync(pagePath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Page Not Found');
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

  private parseJsonBody(req: http.IncomingMessage, callback: (data: Record<string, unknown>) => void): void {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        callback(parsed);
      } catch {
        callback({});
      }
    });
  }
}

// Standalone execution
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const server = new DemoServer(3000);
  server.start().then(() => {
    console.log(`[PARALLAX] Synthetic University Portal running on http://127.0.0.1:3000`);
  });
}
