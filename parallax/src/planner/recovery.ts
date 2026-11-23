import type { Action, Hypothesis, RecoveryPlan } from '../core/types.ts';

export class RecoveryPlanner {
  /**
   * Generates a ranked, bounded recovery plan for a confirmed failure hypothesis.
   */
  public planRecovery(runId: string, hypothesis: Hypothesis): RecoveryPlan {
    const actions: Action[] = [];

    switch (hypothesis.category) {
      case 'SESSION_EXPIRY':
        actions.push({
          id: `act_rec_${Date.now()}_1`,
          type: 'REAUTHENTICATE',
          target: '/api/session/refresh',
          isStateChanging: false,
          humanLabel: 'Refresh Authentication Session'
        });
        actions.push({
          id: `act_rec_${Date.now()}_2`,
          type: 'SUBMIT',
          target: 'button#submit-application',
          isStateChanging: true,
          humanLabel: 'Resubmit University Application'
        });
        return {
          id: `plan_${Date.now()}`,
          runId,
          hypothesisId: hypothesis.id,
          strategyName: 'Re-authenticate and Resubmit',
          actions,
          predictedOutcome: 'Restores valid session token and safely resubmits pending application.',
          riskAssessment: 'LOW'
        };

      case 'HIDDEN_DEPENDENCY':
        actions.push({
          id: `act_rec_${Date.now()}_1`,
          type: 'TYPE',
          target: 'textarea#statement_of_purpose',
          value: 'Candidate Statement: Dedicated computer science researcher focused on browser agent reliability.',
          isStateChanging: false,
          humanLabel: 'Fill Required Statement of Purpose'
        });
        actions.push({
          id: `act_rec_${Date.now()}_2`,
          type: 'SUBMIT',
          target: 'button#submit-application',
          isStateChanging: true,
          humanLabel: 'Submit Completed Application'
        });
        return {
          id: `plan_${Date.now()}`,
          runId,
          hypothesisId: hypothesis.id,
          strategyName: 'Satisfy Missing Dynamic Requirement',
          actions,
          predictedOutcome: 'Supplies missing conditional document and progresses to submission.',
          riskAssessment: 'LOW'
        };

      case 'PROMPT_INJECTION':
      default:
        // Do not execute untrusted commands; reset to last good state
        actions.push({
          id: `act_rec_${Date.now()}_1`,
          type: 'NAVIGATE',
          target: '/portal/step1',
          value: 'http://127.0.0.1:3000',
          isStateChanging: false,
          humanLabel: 'Fallback: Reset to Safe Base State'
        });
        return {
          id: `plan_${Date.now()}`,
          runId,
          hypothesisId: hypothesis.id,
          strategyName: 'Abort Malicious Context & Reset',
          actions,
          predictedOutcome: 'Isolates prompt injection and resets workflow to trusted boundary.',
          riskAssessment: 'LOW'
        };
    }
  }
}
