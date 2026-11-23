import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { InvariantEngine } from '../../src/policy/invariants.ts';
import type { Action } from '../../src/core/types.ts';

describe('PARALLAX Invariant Engine (Zero-Bypass Verification)', () => {
  const allowed = ['localhost', '127.0.0.1', 'demo-university.edu'];

  test('INV-1: Network Boundary Isolation rejects unlisted external domains', () => {
    const valid = InvariantEngine.checkNetworkBoundary('http://demo-university.edu/api/apply', allowed);
    assert.strictEqual(valid.satisfied, true);
    assert.strictEqual(valid.riskLevel, 'LOW');

    const blocked = InvariantEngine.checkNetworkBoundary('http://evil.c2-server.org/data', allowed);
    assert.strictEqual(blocked.satisfied, false);
    assert.strictEqual(blocked.riskLevel, 'CRITICAL');
    assert.match(blocked.violationReason || '', /violates network boundary/);
  });

  test('INV-2: Credential Isolation blocks actions targeting password or secret fields', () => {
    const safeAction = InvariantEngine.checkCredentialIsolation('input#student-name', 'Alex Chen');
    assert.strictEqual(safeAction.satisfied, true);

    const secretAction = InvariantEngine.checkCredentialIsolation('input[type="password"]', 'my_secret');
    assert.strictEqual(secretAction.satisfied, false);
    assert.strictEqual(secretAction.riskLevel, 'CRITICAL');
  });

  test('INV-3: State Mutation Gate halts unconfirmed state changes', () => {
    const submitAction: Action = {
      id: 'act_sub',
      type: 'SUBMIT',
      target: 'button#submit',
      isStateChanging: true,
      humanLabel: 'Submit Application'
    };

    // Unconfirmed -> Fails closed
    const unconfirmed = InvariantEngine.checkStateMutation(submitAction, false);
    assert.strictEqual(unconfirmed.satisfied, false);
    assert.strictEqual(unconfirmed.riskLevel, 'HIGH');

    // Confirmed -> Satisfied
    const confirmed = InvariantEngine.checkStateMutation(submitAction, true);
    assert.strictEqual(confirmed.satisfied, true);
  });

  test('INV-4: Uncertainty Bound halts recovery when hypothesis confidence is low', () => {
    const lowConf = InvariantEngine.checkRecoveryReadiness(0.4, 0.7);
    assert.strictEqual(lowConf.satisfied, false);
    assert.strictEqual(lowConf.riskLevel, 'MEDIUM');

    const highConf = InvariantEngine.checkRecoveryReadiness(0.85, 0.7);
    assert.strictEqual(highConf.satisfied, true);
  });
});
