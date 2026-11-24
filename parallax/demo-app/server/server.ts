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

export type FailureInjectionMode = 'NONE' | 'SESSION_EXPIRY' | 'HIDDEN_DEPENDENCY' | 'CSRF_MISMATCH';

export class DemoServer {
  private server?: http.Server;
  private isSessionActive = true;
  private activeFailureMode: FailureInjectionMode = 'NONE';
  private pendingApplications: Map<string, Partial<ApplicationRecord>> = new Map();
  private acceptedApplications: ApplicationRecord[] = [];
  public port: number;

  constructor(port = 3000) {
    this.port = port;
  }

  public setSessionActive(active: boolean): void {
    this.isSessionActive = active;
  }

  public setFailureMode(mode: FailureInjectionMode): void {
    this.activeFailureMode = mode;
    if (mode === 'SESSION_EXPIRY') {
      this.isSessionActive = false;
    }
  }

  public reset(): void {
    this.isSessionActive = true;
    this.activeFailureMode = 'NONE';
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
          if (!this.isSessionActive || this.activeFailureMode === 'SESSION_EXPIRY') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ active: false, error: 'Session expired' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ active: true, user: 'student_applicant', token: 'SES_ACTIVE_98234' }));
          return;
        }

        // 2. Failure Injection Controller
        if (pathname === '/api/failure/inject') {
          const mode = (parsedUrl.searchParams.get('mode') || 'SESSION_EXPIRY').toUpperCase() as FailureInjectionMode;
          this.setFailureMode(mode);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, activeFailureMode: this.activeFailureMode }));
          return;
        }

        if (pathname === '/api/failure/clear') {
          this.setFailureMode('NONE');
          this.isSessionActive = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, activeFailureMode: 'NONE' }));
          return;
        }

        // 3. Recovery Trigger: Refresh Session
        if (pathname === '/api/session/refresh') {
          this.isSessionActive = true;
          this.activeFailureMode = 'NONE';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ active: true, token: 'SES_RENEWED_10928' }));
          return;
        }

        // 4. Step 1: Personal Information
        if (pathname === '/api/apply/step1' && req.method === 'POST') {
          this.parseJsonBody(req, (data) => {
            // Reject incomplete input instead of inventing a default applicant.
            const studentId = typeof data.studentId === 'string' ? data.studentId.trim() : '';
            const name = typeof data.name === 'string' ? data.name.trim() : '';
            const email = typeof data.email === 'string' ? data.email.trim() : '';
            const missing = [!name && 'name', !studentId && 'studentId'].filter(Boolean);
            if (missing.length > 0 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  success: false,
                  error: missing.length > 0
                    ? `Validation Error: missing required field(s): ${missing.join(', ')}.`
                    : 'Validation Error: email address is not valid.'
                })
              );
              return;
            }
            this.pendingApplications.set(studentId, {
              studentId,
              name,
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
            if ((isMerit && !sop) || this.activeFailureMode === 'HIDDEN_DEPENDENCY') {
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
          if (!this.isSessionActive || this.activeFailureMode === 'SESSION_EXPIRY') {
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
            const studentId = typeof data.studentId === 'string' ? data.studentId.trim() : '';
            const pending = this.pendingApplications.get(studentId);
            // Never fabricate an application: steps 1 and 2 must have been accepted first.
            if (!pending || !pending.name || !pending.course) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  success: false,
                  error: 'Conflict: no completed application (steps 1 and 2) found for this student ID.'
                })
              );
              return;
            }

            const record: ApplicationRecord = {
              id: `APP-2026-${Math.floor(1000 + Math.random() * 9000)}`,
              studentId,
              name: pending.name,
              course: pending.course,
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

        if (pathname === '/api/admin/reset' && req.method === 'POST') {
          this.reset();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Server state reset.' }));
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
// Only when this exact file is the entry point (ui/server.ts also ends in 'server.ts').
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const server = new DemoServer(3000);
  server.start().then(() => {
    console.log(`[PARALLAX] Synthetic University Portal running on http://127.0.0.1:3000`);
  });
}
