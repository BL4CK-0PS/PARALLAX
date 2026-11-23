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
      humanLabel: 'Click About Page',
      dom: { tagName: 'a', text: 'About the programme', href: 'http://localhost:3000/about' }
    };

    const decision = guard.evaluateAction(readAction);
    assert.strictEqual(decision.status, 'ALLOW');
    assert.strictEqual(decision.riskLevel, 'LOW');
  });

  test('gates a Pay button even when the agent labels it as harmless', () => {
    const spoofed: Action = {
      id: 'act_spoof',
      type: 'CLICK',
      target: '#btn-7',
      isStateChanging: false,
      humanLabel: 'View fee details',
      dom: { tagName: 'button', text: 'Pay ₹5,000 now' }
    };

    const decision = guard.evaluateAction(spoofed);
    assert.strictEqual(decision.status, 'REQUIRE_APPROVAL');
    assert.match(decision.reason, /Pay ₹5,000 now/);
  });

  test('ignores a scary agent label when the DOM shows a harmless element', () => {
    const decision = guard.evaluateAction({
      id: 'act_label', type: 'CLICK', target: '#faq', isStateChanging: false,
      humanLabel: 'Confirm payment', dom: { tagName: 'button', text: 'Show FAQ' }
    });
    assert.strictEqual(decision.status, 'ALLOW');
  });

  test('fails closed on a click with no DOM facts', () => {
    const decision = guard.evaluateAction({
      id: 'act_blind', type: 'CLICK', target: '#btn-9', isStateChanging: false, humanLabel: 'Next'
    });
    assert.strictEqual(decision.status, 'REQUIRE_APPROVAL');
    assert.match(decision.reason, /fail-closed/);
  });

  test('blocks typing into a password box hidden behind an opaque selector', () => {
    const decision = guard.evaluateAction({
      id: 'act_pw', type: 'TYPE', target: '#field-3', value: 'hunter2', isStateChanging: false,
      humanLabel: 'Fill comments', dom: { tagName: 'input', inputType: 'password' }
    });
    assert.strictEqual(decision.status, 'BLOCK');
    assert.strictEqual(decision.violatedRule, 'RULE_SECRET_FIELD_BAN');
  });

  test('blocks typing into an OTP box identified only by autocomplete', () => {
    const decision = guard.evaluateAction({
      id: 'act_otp', type: 'TYPE', target: '#code', value: '482913', isStateChanging: false,
      humanLabel: 'Enter code', dom: { tagName: 'input', inputType: 'text', autocomplete: 'one-time-code' }
    });
    assert.strictEqual(decision.status, 'BLOCK');
  });

  test('rejects non-web URL schemes explicitly', () => {
    for (const url of ['javascript:fetch("//evil.com")', 'data:text/html,<script>x</script>', 'file:///etc/passwd']) {
      const res = guard.evaluateNetworkRequest(url);
      assert.strictEqual(res.allowed, false, url);
      assert.match(res.reason, /scheme/);
    }
  });

  test('blocks a click on a link that leaves the allowlist', () => {
    const decision = guard.evaluateAction({
      id: 'act_link', type: 'CLICK', target: 'a#help', isStateChanging: false,
      humanLabel: 'Open help', dom: { tagName: 'a', text: 'Help', href: 'https://evil.attacker.com/x?c=abc' }
    });
    assert.strictEqual(decision.status, 'BLOCK');
    assert.strictEqual(decision.violatedRule, 'RULE_NETWORK_ALLOWLIST');
  });

  test('blocks a form whose action posts to an attacker host', () => {
    const decision = guard.evaluateAction({
      id: 'act_form', type: 'SUBMIT', target: 'form#apply', isStateChanging: true,
      humanLabel: 'Submit', dom: { tagName: 'form', formAction: 'https://webhook.site/abc' }
    });
    assert.strictEqual(decision.status, 'BLOCK');
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
