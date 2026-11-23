import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import { DemoServer } from '../../demo-app/server/server.ts';

describe('Deterministic DemoServer State Machine & Failure Injection', () => {
  const server = new DemoServer(3099);

  before(async () => {
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  test('serves active session by default', async () => {
    const res = await fetch('http://127.0.0.1:3099/api/session');
    assert.strictEqual(res.status, 200);
    const data = await res.json() as any;
    assert.strictEqual(data.active, true);
    assert.strictEqual(data.token, 'SES_ACTIVE_98234');
  });

  test('failure injection: SESSION_EXPIRY forces 401 Unauthorized', async () => {
    // Inject failure
    await fetch('http://127.0.0.1:3099/api/failure/inject?mode=SESSION_EXPIRY');

    const res = await fetch('http://127.0.0.1:3099/api/session');
    assert.strictEqual(res.status, 401);

    // Submission should also fail with 401
    const subRes = await fetch('http://127.0.0.1:3099/api/apply/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: 'TEST-001' })
    });
    assert.strictEqual(subRes.status, 401);

    // Refresh session restores active state
    const refRes = await fetch('http://127.0.0.1:3099/api/session/refresh');
    assert.strictEqual(refRes.status, 200);

    const checkRes = await fetch('http://127.0.0.1:3099/api/session');
    assert.strictEqual(checkRes.status, 200);
  });

  test('failure injection: HIDDEN_DEPENDENCY rejects scholarship without statement of purpose', async () => {
    server.reset();

    // Step 1: Personal info
    const step1 = await fetch('http://127.0.0.1:3099/api/apply/step1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: 'TEST-002', name: 'Jordan Lee' })
    });
    assert.strictEqual(step1.status, 200);

    // Step 2 without SOP -> Rejection 400
    const step2Fail = await fetch('http://127.0.0.1:3099/api/apply/step2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'TEST-002',
        course: 'M.Tech CSE',
        meritScholarship: true,
        statementOfPurpose: ''
      })
    });
    assert.strictEqual(step2Fail.status, 400);

    // Step 2 with SOP -> Success 200
    const step2Pass = await fetch('http://127.0.0.1:3099/api/apply/step2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'TEST-002',
        course: 'M.Tech CSE',
        meritScholarship: true,
        statementOfPurpose: 'Research in formal verification and agent runtime security.'
      })
    });
    assert.strictEqual(step2Pass.status, 200);

    // Step 3 submit -> Success 200
    const submitRes = await fetch('http://127.0.0.1:3099/api/apply/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: 'TEST-002' })
    });
    assert.strictEqual(submitRes.status, 200);
    const subData = await submitRes.json() as any;
    assert.strictEqual(subData.status, 'ACCEPTED');

    // Admin endpoint verifies persistence
    const adminRes = await fetch('http://127.0.0.1:3099/api/admin/applications');
    const adminData = await adminRes.json() as any;
    assert.ok(adminData.applications.some((a: any) => a.studentId === 'TEST-002'));
  });
});
