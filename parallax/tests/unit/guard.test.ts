import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { DeterministicPolicyGuard } from '../../src/policy/guard.ts';
import type { Action } from '../../src/core/types.ts';

describe('DeterministicPolicyGuard', () => {
  const guard = new DeterministicPolicyGuard({
    allowedHosts: ['localhost', '127.0.0.1', 'demo-university.edu']
  });

  test('allows network requests to approved hosts', () => {
    assert.strictEqual(guard.evaluateNetworkRequest('http://localhost:3000/api/session').allowed, true);
    assert.strictEqual(guard.evaluateNetworkRequest('http://127.0.0.1:3000/api/apply/step1').allowed, true);
    assert.strictEqual(guard.evaluateNetworkRequest('https://demo-university.edu/admissions').allowed, true);
    assert.strictEqual(guard.evaluateNetworkRequest('https://sub.demo-university.edu/api').allowed, true);
  });

  test('blocks network requests to unapproved or malicious hosts', () => {
    const res1 = guard.evaluateNetworkRequest('http://evil.attacker.com/steal');
    assert.strictEqual(res1.allowed, false);
    assert.match(res1.reason, /blocked by strict allowlist/);

    const res2 = guard.evaluateNetworkRequest('https://webhook.site/12345');
    assert.strictEqual(res2.allowed, false);
  });

  test('blocks typing into secret or credential fields', () => {
    const passwordAction: Action = {
      id: 'act_1',
      type: 'TYPE',
      target: 'input[name="password"]',
      value: 'SuperSecret123!',
      isStateChanging: false,
      humanLabel: 'Enter Password'
    };

    const decision = guard.evaluateAction(passwordAction);
    assert.strictEqual(decision.status, 'BLOCK');
    assert.strictEqual(decision.violatedRule, 'RULE_SECRET_FIELD_BAN');
    assert.strictEqual(decision.riskLevel, 'CRITICAL');
  });

  test('requires human approval for state-changing actions', () => {
    const submitAction: Action = {
      id: 'act_2',
      type: 'SUBMIT',
      target: 'button#submit-application',
      isStateChanging: true,
      humanLabel: 'Final Submit Application'
    };

    const decision = guard.evaluateAction(submitAction);
    assert.strictEqual(decision.status, 'REQUIRE_APPROVAL');
    assert.strictEqual(decision.violatedRule, 'RULE_HUMAN_APPROVAL_GATE');
    assert.strictEqual(decision.riskLevel, 'HIGH');
  });

  test('allows safe read-only actions without human gate', () => {
    const readAction: Action = {
      id: 'act_3',
      type: 'CLICK',
      target: 'a.nav-link',
      isStateChanging: false,
      humanLabel: 'Click About Page'
    };

    const decision = guard.evaluateAction(readAction);
    assert.strictEqual(decision.status, 'ALLOW');
    assert.strictEqual(decision.riskLevel, 'LOW');
  });

  test('scrubs credentials from LLM context objects', () => {
    const payload = {
      username: 'alex_chen',
      password: 'plaintext_password_123',
      nested: {
        session_token: 'xyz987',
        studentId: 'CS26-0912'
      }
    };

    const scrubbed = guard.scrubSecrets(payload) as any;
    assert.strictEqual(scrubbed.username, 'alex_chen');
    assert.strictEqual(scrubbed.password, '[REDACTED_SECRET]');
    assert.strictEqual(scrubbed.nested.session_token, '[REDACTED_SECRET]');
    assert.strictEqual(scrubbed.nested.studentId, 'CS26-0912');
  });
});
