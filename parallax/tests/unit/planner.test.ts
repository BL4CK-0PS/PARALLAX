import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { RecoveryPlanner } from '../../src/planner/recovery.ts';
import type { Hypothesis } from '../../src/core/types.ts';

describe('RecoveryPlanner & Candidate Multi-Attribute Ranking', () => {
  const planner = new RecoveryPlanner();
  const runId = 'test_run_planner';

  test('ranks re-authentication above blind speculative retries for SESSION_EXPIRY', () => {
    const sessionHypothesis: Hypothesis = {
      id: 'hyp_test_session',
      runId,
      claim: 'Session expired before submit',
      category: 'SESSION_EXPIRY',
      supportingEvidence: ['401 Unauthorized received'],
      contradictoryEvidence: [],
      confidenceScore: 0.85,
      status: 'CONFIRMED'
    };

    const plan = planner.planRecovery(runId, sessionHypothesis);

    assert.strictEqual(plan.selectedCandidate.strategyName, 'Re-authenticate Session and Resubmit');
    assert.strictEqual(plan.actions.length, 2);
    assert.strictEqual(plan.actions[0].type, 'REAUTHENTICATE');
    assert.strictEqual(plan.actions[1].type, 'SUBMIT');

    // Verify alternatives exist and have lower composite utility scores
    assert.ok(plan.alternativeCandidates.length >= 2);
    const blindRetry = plan.alternativeCandidates.find((c) =>
      c.strategyName.includes('Immediate Resubmit')
    );
    assert.ok(blindRetry);
    assert.ok(plan.selectedCandidate.compositeUtilityScore > blindRetry.compositeUtilityScore);
  });

  test('ranks fulfilling required dynamic document above forfeiting scholarship', () => {
    const depHypothesis: Hypothesis = {
      id: 'hyp_test_dep',
      runId,
      claim: 'Conditional document missing for scholarship',
      category: 'HIDDEN_DEPENDENCY',
      supportingEvidence: ['Merit scholarship checked without statement of purpose'],
      contradictoryEvidence: [],
      confidenceScore: 0.9,
      status: 'CONFIRMED'
    };

    const plan = planner.planRecovery(runId, depHypothesis);
    assert.strictEqual(plan.selectedCandidate.strategyName, 'Satisfy Missing Dynamic Requirement');
    assert.strictEqual(plan.actions[0].type, 'TYPE');
    assert.strictEqual(plan.actions[1].type, 'SUBMIT');

    const forfeitCandidate = plan.alternativeCandidates.find((c) => c.strategyName.includes('Forfeit'));
    assert.ok(forfeitCandidate);
    assert.ok(plan.selectedCandidate.compositeUtilityScore > forfeitCandidate.compositeUtilityScore);
  });

  test('enforces Human Approval requirement on plans with state-changing actions', () => {
    const sessionHypothesis: Hypothesis = {
      id: 'hyp_test_session',
      runId,
      claim: 'Session expired',
      category: 'SESSION_EXPIRY',
      supportingEvidence: [],
      contradictoryEvidence: [],
      confidenceScore: 0.8,
      status: 'CONFIRMED'
    };

    const plan = planner.planRecovery(runId, sessionHypothesis);
    assert.strictEqual(plan.selectedCandidate.requiresHumanApproval, true);
  });
});
