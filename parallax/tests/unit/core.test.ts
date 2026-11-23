import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { AuditEventStore } from '../../src/core/store.ts';
import { ChronosTimeline } from '../../src/chronos/timeline.ts';
import type { StateSnapshot } from '../../src/core/types.ts';

describe('AuditEventStore & Cryptographic Chain', () => {
  test('creates a verifiable hash chain across events', () => {
    const store = new AuditEventStore();
    const runId = 'test_run_1';

    const e1 = store.append(runId, 'DOM_OBSERVED', 'BROWSER', { url: 'http://localhost:3000' });
    const e2 = store.append(runId, 'ACTION_PROPOSED', 'AGENT', { target: '#submit' });
    const e3 = store.append(runId, 'APPROVAL_REQUESTED', 'GUARD', { action: 'submit' });

    assert.strictEqual(e1.previousHash, undefined);
    assert.strictEqual(e2.previousHash, e1.hash);
    assert.strictEqual(e3.previousHash, e2.hash);

    assert.strictEqual(store.verifyIntegrity(runId), true);
  });
});

describe('ChronosTimeline & State Diffing', () => {
  test('identifies last-good state before a failure', () => {
    const chronos = new ChronosTimeline();
    const runId = 'test_run_2';

    const s1: StateSnapshot = {
      step: 1,
      url: 'http://localhost:3000/step1',
      title: 'Step 1',
      formInputs: { name: 'Alex' },
      timestamp: 1000,
      isHealthy: true
    };

    const s2: StateSnapshot = {
      step: 2,
      url: 'http://localhost:3000/step2',
      title: 'Step 2',
      formInputs: { name: 'Alex', scholarship: 'true' },
      timestamp: 2000,
      isHealthy: true
    };

    const s3: StateSnapshot = {
      step: 3,
      url: 'http://localhost:3000/step2',
      title: 'Step 2 - Failed',
      formInputs: { name: 'Alex', scholarship: 'true' },
      timestamp: 3000,
      isHealthy: false // Failure occurred
    };

    chronos.recordSnapshot(runId, s1);
    chronos.recordSnapshot(runId, s2);
    chronos.recordSnapshot(runId, s3);

    const lastGood = chronos.getLastGoodState(runId);
    assert.ok(lastGood);
    assert.strictEqual(lastGood.step, 2);
    assert.strictEqual(lastGood.isHealthy, true);

    const diff = chronos.diff(s1, s2);
    assert.strictEqual(diff.urlChanged, true);
    assert.strictEqual(diff.inputsModified['scholarship']?.to, 'true');
  });
});
