import type { FailureCategory, Hypothesis, StateSnapshot } from '../core/types.ts';

export class GhostProber {
  /**
   * Evaluates a failed step and generates candidate hypotheses.
   */
  public formulateHypotheses(
    runId: string,
    failureError: string,
    lastGoodState?: StateSnapshot,
    failedState?: StateSnapshot
  ): Hypothesis[] {
    const hypotheses: Hypothesis[] = [];
    const errLower = failureError.toLowerCase();

    // 1. Session Expiry Hypothesis
    if (
      errLower.includes('session') ||
      errLower.includes('401') ||
      errLower.includes('unauthorized') ||
      errLower.includes('expired')
    ) {
      hypotheses.push({
        id: `hyp_${Date.now()}_1`,
        runId,
        claim: 'Authentication session expired before request submission.',
        category: 'SESSION_EXPIRY',
        supportingEvidence: [failureError],
        contradictoryEvidence: [],
        confidenceScore: 0.85,
        status: 'PROPOSED'
      });
    }

    // 2. Hidden Dynamic Dependency Hypothesis
    if (
      errLower.includes('required') ||
      errLower.includes('validation') ||
      errLower.includes('missing') ||
      (failedState && failedState.formInputs['merit_scholarship'] === 'true')
    ) {
      hypotheses.push({
        id: `hyp_${Date.now()}_2`,
        runId,
        claim: 'A conditional field requirement was triggered by a prior selection.',
        category: 'HIDDEN_DEPENDENCY',
        supportingEvidence: ['Merit scholarship selected but statement of purpose was omitted.'],
        contradictoryEvidence: [],
        confidenceScore: 0.75,
        status: 'PROPOSED'
      });
    }

    // 3. Prompt Injection Exfiltration Hypothesis
    if (errLower.includes('allowlist') || errLower.includes('blocked') || errLower.includes('exfiltration')) {
      hypotheses.push({
        id: `hyp_${Date.now()}_3`,
        runId,
        claim: 'Untrusted page content attempted to redirect agent or exfiltrate state off-site.',
        category: 'PROMPT_INJECTION',
        supportingEvidence: [failureError],
        contradictoryEvidence: [],
        confidenceScore: 0.95,
        status: 'PROPOSED'
      });
    }

    if (hypotheses.length === 0) {
      hypotheses.push({
        id: `hyp_${Date.now()}_0`,
        runId,
        claim: 'Unclassified workflow failure.',
        category: 'UNKNOWN',
        supportingEvidence: [failureError],
        contradictoryEvidence: [],
        confidenceScore: 0.2,
        status: 'PROPOSED'
      });
    }

    return hypotheses;
  }

  /**
   * Executes a safe, read-only micro-probe against an endpoint or DOM state to test a hypothesis.
   */
  public async probeSessionStatus(sessionCheckUrl: string): Promise<boolean> {
    try {
      const resp = await fetch(sessionCheckUrl);
      if (resp.status === 401 || resp.status === 403) {
        return false; // Session is indeed expired
      }
      return resp.ok;
    } catch {
      return false;
    }
  }
}
