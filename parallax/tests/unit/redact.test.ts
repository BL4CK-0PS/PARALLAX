import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { redactDeep, redactText, redactUrl, REDACTED } from '../../src/capture/redact.ts';
import { normalizeDomFacts, fingerprintDomFacts } from '../../src/capture/domFacts.ts';
import { sanitizeAriaSnapshot } from '../../src/capture/browser.ts';

describe('Redaction (capture-time and display-time)', () => {
  test('redacts sensitive keys but keeps similarly named benign keys', () => {
    const out = redactDeep({ password: 'hunter2', authorization: 'Bearer x', cookie: 'a=b', otp: '123456', sessionId: 'abc', passed: true, checks: [{ passed: false }], description: 'ok' });
    assert.strictEqual(out.password, REDACTED);
    assert.strictEqual(out.authorization, REDACTED);
    assert.strictEqual(out.cookie, REDACTED);
    assert.strictEqual(out.otp, REDACTED);
    assert.strictEqual(out.sessionId, REDACTED);
    assert.strictEqual(out.passed, true);
    assert.deepStrictEqual(out.checks, [{ passed: false }]);
    assert.strictEqual(out.description, 'ok');
  });

  test('strips credential query parameters and userinfo from URLs', () => {
    const u = redactUrl('http://user:pw@evil.attacker.com/steal?cookie=SES_ACTIVE_98234&page=2');
    assert.ok(!u.includes('SES_ACTIVE_98234'));
    assert.ok(!u.includes('pw@'));
    assert.ok(u.includes('page=2'));
  });

  test('masks session tokens and bearer credentials inside free text', () => {
    const t = redactText('token SES_RENEWED_10928 and Authorization: Bearer abc.def.ghi');
    assert.ok(!t.includes('SES_RENEWED_10928'));
    assert.ok(!t.includes('abc.def.ghi'));
  });

  test('is idempotent, so state hashes survive a second redaction pass', () => {
    const once = redactDeep({ url: 'http://127.0.0.1:3000', nested: { text: 'SES_ACTIVE_1 at http://x.test/?token=1' } });
    assert.deepStrictEqual(redactDeep(once), once);
  });

  test('keeps shared references (only true cycles are cut)', () => {
    const shared = { claim: 'H1' };
    const out = redactDeep({ a: shared, b: [shared] });
    assert.deepStrictEqual(out, { a: { claim: 'H1' }, b: [{ claim: 'H1' }] });
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    assert.strictEqual((redactDeep(cyclic) as Record<string, unknown>).self, '[CYCLE]');
  });

  test('does not truncate or rewrite element screenshots', () => {
    const img = 'data:image/png;base64,' + 'A'.repeat(10_000);
    assert.strictEqual(redactDeep({ elementScreenshot: img }).elementScreenshot, img);
  });

  test('removes typed values of secret textboxes from AI aria snapshots', () => {
    const s = sanitizeAriaSnapshot('- textbox "Password" [ref=e4]: hunter2\n- textbox "Full name" [ref=e5]: Alex\n- textbox "PIN" [ref=e6]: 9999', ['PIN']);
    assert.ok(!s.includes('hunter2'));
    assert.ok(!s.includes('9999'));
    assert.ok(s.includes('Alex'));
  });
});

describe('DomFacts normalisation', () => {
  test('normalises whitespace, drops empty and non-string facts, lowercases tag', () => {
    const f = normalizeDomFacts({ tagName: 'BUTTON', text: '  Pay\n  ₹1,500  ', ariaLabel: '', name: null, value: 42 });
    assert.deepStrictEqual(f, { tagName: 'button', text: 'Pay ₹1,500' });
  });

  test('fails closed on unusable input', () => {
    assert.throws(() => normalizeDomFacts(null));
    assert.throws(() => normalizeDomFacts({ text: 'no tag' }));
  });

  test('fingerprint changes when any fact changes', () => {
    assert.notStrictEqual(fingerprintDomFacts({ tagName: 'button', text: 'View' }), fingerprintDomFacts({ tagName: 'button', text: 'Pay' }));
    assert.strictEqual(fingerprintDomFacts({ tagName: 'a', href: 'x' }), fingerprintDomFacts({ href: 'x', tagName: 'a' }));
  });
});
