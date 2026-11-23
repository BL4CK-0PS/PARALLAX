import type { Action, Hypothesis, RecoveryCandidate, RecoveryPlan } from '../core/types.ts';

export class RecoveryPlanner {
  /**
   * Generates alternative recovery candidates, ranks them using multi-attribute utility,
   * and selects the optimal bounded recovery plan.
   */
  public planRecovery(runId: string, hypothesis: Hypothesis): RecoveryPlan {
    const candidates: RecoveryCandidate[] = [];

    switch (hypothesis.category) {
      case 'SESSION_EXPIRY': {
        // Candidate 1 (Optimal): Refresh session then submit
        candidates.push({
          id: `cand_${Date.now()}_1`,
          strategyName: 'Re-authenticate Session and Resubmit',
          actions: [
            {
              id: `act_rec_${Date.now()}_1`,
              type: 'REAUTHENTICATE',
              target: '/api/session/refresh',
              isStateChanging: false,
              humanLabel: 'Refresh Authentication Session'
            },
            {
              id: `act_rec_${Date.now()}_2`,
              type: 'SUBMIT',
              target: 'button#submit-application',
              isStateChanging: true,
              humanLabel: 'Resubmit University Application'
            }
          ],
          expectedBenefitScore: 0.95,
          riskScore: 0.1,
          compositeUtilityScore: 0.92,
          requiresHumanApproval: true,
          predictedOutcome: 'Restores valid session token and safely resubmits pending application.'
        });

        // Candidate 2 (Sub-optimal): Immediate retry without refreshing
        candidates.push({
          id: `cand_${Date.now()}_2`,
          strategyName: 'Immediate Resubmit Without Re-auth (Speculative)',
          actions: [
            {
              id: `act_rec_${Date.now()}_3`,
              type: 'SUBMIT',
              target: 'button#submit-application',
              isStateChanging: true,
              humanLabel: 'Blind Resubmit'
            }
          ],
          expectedBenefitScore: 0.15,
          riskScore: 0.8,
          compositeUtilityScore: 0.08,
          requiresHumanApproval: true,
          predictedOutcome: 'Likely triggers repeated 401 Unauthorized rejection.'
        });

        // Candidate 3: Full workflow restart
        candidates.push({
          id: `cand_${Date.now()}_3`,
          strategyName: 'Restart Application from Step 1',
          actions: [
            {
              id: `act_rec_${Date.now()}_4`,
              type: 'NAVIGATE',
              target: '/portal/step1',
              value: 'http://127.0.0.1:3000',
              isStateChanging: false,
              humanLabel: 'Navigate to Start'
            }
          ],
          expectedBenefitScore: 0.6,
          riskScore: 0.4,
          compositeUtilityScore: 0.45,
          requiresHumanApproval: false,
          predictedOutcome: 'Discards filled data and resets to beginning.'
        });
        break;
      }

      case 'HIDDEN_DEPENDENCY': {
        // Candidate 1: Fill missing requirement and submit
        candidates.push({
          id: `cand_${Date.now()}_1`,
          strategyName: 'Satisfy Missing Dynamic Requirement',
          actions: [
            {
              id: `act_rec_${Date.now()}_1`,
              type: 'TYPE',
              target: 'textarea#statement_of_purpose',
              value: 'Candidate Statement: Dedicated computer science researcher focused on browser agent reliability.',
              isStateChanging: false,
              humanLabel: 'Fill Required Statement of Purpose'
            },
            {
              id: `act_rec_${Date.now()}_2`,
              type: 'SUBMIT',
              target: 'button#submit-application',
              isStateChanging: true,
              humanLabel: 'Submit Completed Application'
            }
          ],
          expectedBenefitScore: 0.92,
          riskScore: 0.15,
          compositeUtilityScore: 0.88,
          requiresHumanApproval: true,
          predictedOutcome: 'Supplies missing conditional document and progresses to submission.'
        });

        // Candidate 2: Deselect merit scholarship to bypass requirement
        candidates.push({
          id: `cand_${Date.now()}_2`,
          strategyName: 'Deselect Conditional Option (Waiver Forfeit)',
          actions: [
            {
              id: `act_rec_${Date.now()}_3`,
              type: 'CLICK',
              target: 'input#merit-scholarship',
              isStateChanging: false,
              humanLabel: 'Uncheck Merit Scholarship'
            },
            {
              id: `act_rec_${Date.now()}_4`,
              type: 'SUBMIT',
              target: 'button#submit-application',
              isStateChanging: true,
              humanLabel: 'Submit Without Scholarship'
            }
          ],
          expectedBenefitScore: 0.5,
          riskScore: 0.6,
          compositeUtilityScore: 0.35,
          requiresHumanApproval: true,
          predictedOutcome: 'Bypasses requirement but forfeits tuition scholarship.'
        });
        break;
      }

      case 'PROMPT_INJECTION':
      default: {
        candidates.push({
          id: `cand_${Date.now()}_1`,
          strategyName: 'Abort Malicious Context & Reset to Clean State',
          actions: [
            {
              id: `act_rec_${Date.now()}_1`,
              type: 'NAVIGATE',
              target: '/portal/step1',
              value: 'http://127.0.0.1:3000',
              isStateChanging: false,
              humanLabel: 'Fallback: Reset to Safe Base State'
            }
          ],
          expectedBenefitScore: 0.9,
          riskScore: 0.05,
          compositeUtilityScore: 0.89,
          requiresHumanApproval: false,
          predictedOutcome: 'Isolates prompt injection and resets workflow to trusted boundary.'
        });
        break;
      }
    }

    // Sort candidates descending by compositeUtilityScore
    candidates.sort((a, b) => b.compositeUtilityScore - a.compositeUtilityScore);

    const selected = candidates[0];
    const alternatives = candidates.slice(1);

    return {
      id: `plan_${Date.now()}`,
      runId,
      hypothesisId: hypothesis.id,
      strategyName: selected.strategyName,
      selectedCandidate: selected,
      alternativeCandidates: alternatives,
      actions: selected.actions,
      predictedOutcome: selected.predictedOutcome,
      riskAssessment: selected.riskScore < 0.3 ? 'LOW' : selected.riskScore < 0.6 ? 'MEDIUM' : 'HIGH'
    };
  }
}
