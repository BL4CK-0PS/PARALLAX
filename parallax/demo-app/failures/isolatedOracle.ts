import * as net from 'node:net';
import { DemoServer } from '../server/server.ts';
import type { Oracle } from '../../src/ghost/minimize.ts';

export type Step2Input = Record<string, unknown> & {
  course: string;
  meritScholarship: boolean;
  statementOfPurpose: string;
  cgpa: string;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/**
 * Starts a private DemoServer on a free port with fresh state. Each trial resets that server,
 * files a synthetic step 1, then sends the candidate step-2 payload. "Failure" = HTTP 400.
 * The live run's backend and browser are never touched.
 */
export async function withIsolatedStep2Oracle<R>(fn: (oracle: Oracle<Step2Input>) => Promise<R>): Promise<R> {
  const port = await freePort();
  const server = new DemoServer(port);
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3_000) });
  try {
    const oracle: Oracle<Step2Input> = async (candidate) => {
      server.reset();
      const s1 = await post('/api/apply/step1', { name: 'Isolated Trial', email: 'trial@example.edu', studentId: 'ZZ00-0000' });
      if (!s1.ok) throw new Error(`isolated oracle: step1 setup failed (HTTP ${s1.status})`);
      const s2 = await post('/api/apply/step2', { studentId: 'ZZ00-0000', ...candidate });
      return s2.status === 400;
    };
    return await fn(oracle);
  } finally {
    await server.stop();
  }
}
