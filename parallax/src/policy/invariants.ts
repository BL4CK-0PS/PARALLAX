import type { Action, EventRecord, PolicyDecision, StateSnapshot } from '../core/types.ts';

export interface InvariantResult {
  invariantId: string;
  name: string;
  satisfied: boolean;
  violationReason?: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface RunAuditEvaluation {
  allSatisfied: boolean;
  totalChecks: number;
  passedChecks: number;
  violations: InvariantResult[];
}

/**
 * PARALLAX Formal Invariants (Deterministic Safety Rules)
 * These invariants must hold true at ALL times during workflow execution.
 */
export class InvariantEngine {
  /**
   * INVARIANT 1: NO_UNAUTHORIZED_EXTERNAL_IO
   * No network request may be initiated to a host outside the authorized allowlist.
   */
  public static checkNetworkBoundary(urlStr: string, allowedHosts: string[]): InvariantResult {
    try {
      const parsed = new URL(urlStr);
      const host = parsed.hostname.toLowerCase();
      const isAllowed = allowedHosts.some((h) => {
        const norm = h.toLowerCase();
        return host === norm || host.endsWith(`.${norm}`);
      });

      if (!isAllowed) {
        return {
          invariantId: 'INV_1_NETWORK_BOUNDARY',
          name: 'Strict Network Boundary Isolation',
          satisfied: false,
          violationReason: `Outbound request to '${host}' violates network boundary. Possible data exfiltration attempt.`,
          riskLevel: 'CRITICAL'
        };
      }

      return {
        invariantId: 'INV_1_NETWORK_BOUNDARY',
        name: 'Strict Network Boundary Isolation',
        satisfied: true,
        riskLevel: 'LOW'
      };
    } catch {
      return {
        invariantId: 'INV_1_NETWORK_BOUNDARY',
        name: 'Strict Network Boundary Isolation',
        satisfied: false,
        violationReason: `Malformed URL target: '${urlStr}'`,
        riskLevel: 'CRITICAL'
      };
    }
  }

  /**
   * INVARIANT 2: NO_CREDENTIAL_LEAKAGE
   * Credentials, passwords, OTPs, and private tokens must never be exposed to LLM prompts or typed unassisted.
   */
  public static checkCredentialIsolation(selector: string, value?: string): InvariantResult {
    const sensitivePatterns = [/password/i, /secret/i, /cvv/i, /credit[_-]?card/i, /token/i, /otp/i, /ssn/i];

    const isTargetSensitive = sensitivePatterns.some((pat) => pat.test(selector));
    const isValueSensitive = value ? sensitivePatterns.some((pat) => pat.test(value)) : false;

    if (isTargetSensitive || isValueSensitive) {
      return {
        invariantId: 'INV_2_CREDENTIAL_ISOLATION',
        name: 'Zero Credential Leakage & Secret Ban',
        satisfied: false,
        violationReason: `Action targets sensitive credential field '${selector}'. Direct typing or model exposure prohibited.`,
        riskLevel: 'CRITICAL'
      };
    }

    return {
      invariantId: 'INV_2_CREDENTIAL_ISOLATION',
      name: 'Zero Credential Leakage & Secret Ban',
      satisfied: true,
      riskLevel: 'LOW'
    };
  }

  /**
   * INVARIANT 3: NO_UNCONFIRMED_STATE_MUTATION
   * Irreversible or state-changing actions strictly require verified human confirmation.
   */
  public static checkStateMutation(action: Action, isHumanConfirmed: boolean): InvariantResult {
    if (!action.isStateChanging && action.type !== 'SUBMIT') {
      return {
        invariantId: 'INV_3_STATE_MUTATION_GATE',
        name: 'Human Confirmation Gate for State Changes',
        satisfied: true,
        riskLevel: 'LOW'
      };
    }

    if (!isHumanConfirmed) {
      return {
        invariantId: 'INV_3_STATE_MUTATION_GATE',
        name: 'Human Confirmation Gate for State Changes',
        satisfied: false,
        violationReason: `Action '${action.humanLabel}' on '${action.target}' alters state and has not been confirmed by a human operator.`,
        riskLevel: 'HIGH'
      };
    }

    return {
      invariantId: 'INV_3_STATE_MUTATION_GATE',
      name: 'Human Confirmation Gate for State Changes',
      satisfied: true,
      riskLevel: 'LOW'
    };
  }

  /**
   * INVARIANT 4: NO_RECOVERY_UNDER_UNRESOLVED_UNCERTAINTY
   * An agent must not execute stateful recovery unless a failure hypothesis has been verified.
   */
  public static checkRecoveryReadiness(hypothesisConfidence: number, threshold = 0.7): InvariantResult {
    if (hypothesisConfidence < threshold) {
      return {
        invariantId: 'INV_4_UNCERTAINTY_BOUND',
        name: 'Bounded Recovery Under Validated Hypotheses',
        satisfied: false,
        violationReason: `Hypothesis confidence (${(hypothesisConfidence * 100).toFixed(0)}%) is below acceptable threshold (${(threshold * 100).toFixed(0)}%). Speculative recovery blocked.`,
        riskLevel: 'MEDIUM'
      };
    }

    return {
      invariantId: 'INV_4_UNCERTAINTY_BOUND',
      name: 'Bounded Recovery Under Validated Hypotheses',
      satisfied: true,
      riskLevel: 'LOW'
    };
  }

  /**
   * Performs an end-of-run forensic audit across all logged event records.
   */
  public static auditRunInvariants(events: EventRecord[], allowedHosts: string[]): RunAuditEvaluation {
    const violations: InvariantResult[] = [];
    let totalChecks = 0;

    for (const evt of events) {
      // Check network requests in payloads
      if (evt.type === 'NETWORK_REQUEST' && typeof evt.payload.url === 'string') {
        totalChecks++;
        const netRes = this.checkNetworkBoundary(evt.payload.url, allowedHosts);
        if (!netRes.satisfied) violations.push(netRes);
      }

      // Check actions in payloads
      if (evt.type === 'ACTION_DISPATCHED' && evt.payload.target) {
        totalChecks++;
        const secRes = this.checkCredentialIsolation(
          String(evt.payload.target),
          evt.payload.value ? String(evt.payload.value) : undefined
        );
        if (!secRes.satisfied) violations.push(secRes);
      }
    }

    const passedChecks = totalChecks - violations.length;
    return {
      allSatisfied: violations.length === 0,
      totalChecks,
      passedChecks,
      violations
    };
  }
}
