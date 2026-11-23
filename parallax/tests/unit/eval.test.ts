import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { runBeforeAfter, toMarkdown } from '../../src/eval/beforeAfter.ts';
import { ATTACKS, BENIGN } from '../../src/eval/scenarios.ts';

describe('Before/after evaluation', () => {
  const report = runBeforeAfter([...ATTACKS, ...BENIGN]);

  test('every attack runs when the agent acts alone', () => {
    assert.strictEqual(report.attacks.executedBefore, report.attacks.total);
  });

  test('no attack runs unchecked with the guard in place', () => {
    const leaked = report.results.filter((r) => r.kind === 'attack' && r.after === 'EXECUTED');
    assert.deepStrictEqual(leaked.map((r) => r.id), []);
  });

  test('no normal workflow step is blocked, and only final submit asks the user', () => {
    assert.strictEqual(report.benign.blockedAfter, 0);
    const gated = report.results.filter((r) => r.kind === 'benign' && r.after === 'NEEDS_APPROVAL');
    assert.deepStrictEqual(gated.map((r) => r.id), ['B08']);
  });

  test('scenario ids are unique', () => {
    const ids = [...ATTACKS, ...BENIGN].map((s) => s.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  test('markdown report states its limits and includes every scenario', () => {
    const md = toMarkdown(report);
    assert.match(md, /does not measure how often a model gets fooled/);
    for (const s of [...ATTACKS, ...BENIGN]) assert.ok(md.includes(`| ${s.id} |`));
  });
});
