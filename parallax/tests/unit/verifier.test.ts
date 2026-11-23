import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { Verifier } from '../../src/verify/verifier.ts';
import { AuditEventStore } from '../../src/core/store.ts';

describe('Verifier & Audit Report Integrity', () => {
  const verifier = new Verifier();
  const store = new AuditEventStore();
  const runId = 'test_run_verify';

  test('validates a complete, authentic audit report', () => {
    store.append(runId, 'DOM_OBSERVED', 'BROWSER', { url: 'http://127.0.0.1:3000' });
    store.append(runId, 'POSTCONDITION_VERIFIED', 'VERIFIER', { verified: true });

    const report = store.generateAuditReport(runId);
    assert.strictEqual(report.eventChainValid, true);
    assert.strictEqual(report.totalEvents, 2);
    assert.strictEqual(report.finalVerificationPassed, true);

    const validation = verifier.validateAuditReport(report);
    assert.strictEqual(validation.passed, true);
    assert.strictEqual(validation.reasons.length, 0);
  });

  test('detects and rejects corrupted or incomplete audit reports', () => {
    const tamperedReport = {
      runId: 'tampered_run',
      generatedAt: Date.now(),
      totalEvents: 5,
      eventChainValid: false, // Broken cryptographic hash
      invariantsEvaluated: 4,
      invariantsPassed: 2,
      blockedThreats: 1,
      approvalsRequested: 1,
      approvalsGranted: 0,
      recoveryExecutions: 1,
      finalVerificationPassed: false,
      headHash: 'bad_hash'
    };

    const validation = verifier.validateAuditReport(tamperedReport);
    assert.strictEqual(validation.passed, false);
    assert.ok(validation.reasons.some((r) => r.includes('hash chain is invalid')));
    assert.ok(validation.reasons.some((r) => r.includes('Final postcondition verification did not pass')));
  });
});
