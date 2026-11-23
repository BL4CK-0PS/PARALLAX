import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTACKS, BENIGN } from '../src/eval/scenarios.ts';
import { runBeforeAfter, toMarkdown } from '../src/eval/beforeAfter.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const report = runBeforeAfter([...ATTACKS, ...BENIGN]);

const mdPath = join(root, 'docs', 'submission', 'BEFORE_AFTER.md');
const jsonPath = join(root, 'data', 'eval', 'before-after.json');
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(mdPath, toMarkdown(report));
writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const { attacks: a, benign: b } = report;
console.log(`Harmful actions that ran:   agent alone ${a.executedBefore}/${a.total}  ->  with PARALLAX ${a.executedAfter}/${a.total}`);
console.log(`  blocked ${a.blockedAfter}, paused for approval ${a.gatedAfter}`);
console.log(`Normal steps: ${b.executedAfter}/${b.total} ran freely, ${b.gatedAfter} asked the user, ${b.blockedAfter} wrongly blocked`);
console.log(`Report: ${mdPath}`);

if (a.executedAfter > 0 || b.blockedAfter > 0) process.exitCode = 1;
