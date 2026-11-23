import type { Action, PolicyDecision, PolicyStatus } from '../core/types.ts';

export interface GuardConfig {
  allowedHosts: string[];
  sensitiveFieldPatterns: RegExp[];
  stateChangingKeywords: string[];
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  allowedHosts: ['localhost', '127.0.0.1', 'demo-university.edu'],
  sensitiveFieldPatterns: [
    /password/i,
    /secret/i,
    /cvv/i,
    /credit[_-]?card/i,
    /ssn/i,
    /token/i,
    /otp/i
  ],
  stateChangingKeywords: [
    'submit',
    'apply',
    'confirm',
    'pay',
    'purchase',
    'delete',
    'checkout',
    'finalize'
  ]
};

export class DeterministicPolicyGuard {
  private config: GuardConfig;

  constructor(config?: Partial<GuardConfig>) {
    this.config = {
      allowedHosts: config?.allowedHosts ?? DEFAULT_GUARD_CONFIG.allowedHosts,
      sensitiveFieldPatterns: config?.sensitiveFieldPatterns ?? DEFAULT_GUARD_CONFIG.sensitiveFieldPatterns,
      stateChangingKeywords: config?.stateChangingKeywords ?? DEFAULT_GUARD_CONFIG.stateChangingKeywords
    };
  }

  /**
   * Evaluates outgoing network URL against the strict host allowlist.
   * Deterministic, fail-closed: anything not explicitly allowed is aborted.
   */
  public evaluateNetworkRequest(urlStr: string): { allowed: boolean; reason: string } {
    try {
      const parsed = new URL(urlStr);
      const host = parsed.hostname.toLowerCase();

      const isAllowed = this.config.allowedHosts.some((allowed) => {
        const normalized = allowed.toLowerCase();
        return host === normalized || host.endsWith(`.${normalized}`);
      });

      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Network request to '${host}' blocked by strict allowlist. Possible exfiltration attempt.`
        };
      }

      return { allowed: true, reason: `Host '${host}' is in allowlist.` };
    } catch {
      return {
        allowed: false,
        reason: `Malformed URL rejected by network guard: ${urlStr}`
      };
    }
  }

  /**
   * Checks if an input element is a protected secret field.
   */
  public isSecretField(targetSelector: string): boolean {
    return this.config.sensitiveFieldPatterns.some((pattern) => pattern.test(targetSelector));
  }

  /**
   * Detects if an action modifies external state or makes irreversible changes.
   */
  public isStateChangingAction(action: Action): boolean {
    if (action.isStateChanging || action.type === 'SUBMIT') {
      return true;
    }

    const targetLower = action.target.toLowerCase();
    const labelLower = action.humanLabel.toLowerCase();

    return this.config.stateChangingKeywords.some(
      (kw) => targetLower.includes(kw) || labelLower.includes(kw)
    );
  }

  /**
   * Evaluates an agent action before it touches the browser.
   * Returns:
   *  - ALLOW: safe read/nav/input
   *  - BLOCK: violates security boundary (secret typing, exfil)
   *  - REQUIRE_APPROVAL: state-changing action requiring human consent
   */
  public evaluateAction(action: Action): PolicyDecision {
    const timestamp = Date.now();

    // 1. Secret Field Protection
    if (action.type === 'TYPE' && this.isSecretField(action.target)) {
      return {
        status: 'BLOCK',
        reason: `Agent attempted to type into protected secret field '${action.target}'.`,
        violatedRule: 'RULE_SECRET_FIELD_BAN',
        riskLevel: 'CRITICAL',
        action,
        timestamp
      };
    }

    // 2. Navigation Allowlist Check
    if (action.type === 'NAVIGATE' && action.value) {
      const netCheck = this.evaluateNetworkRequest(action.value);
      if (!netCheck.allowed) {
        return {
          status: 'BLOCK',
          reason: netCheck.reason,
          violatedRule: 'RULE_NETWORK_ALLOWLIST',
          riskLevel: 'CRITICAL',
          action,
          timestamp
        };
      }
    }

    // 3. Human Gate for State-Changing Operations
    if (this.isStateChangingAction(action)) {
      return {
        status: 'REQUIRE_APPROVAL',
        reason: `Action '${action.humanLabel}' on '${action.target}' is state-changing and requires human confirmation.`,
        violatedRule: 'RULE_HUMAN_APPROVAL_GATE',
        riskLevel: 'HIGH',
        action,
        timestamp
      };
    }

    // 4. Default: Safe operation allowed
    return {
      status: 'ALLOW',
      reason: `Action '${action.humanLabel}' passed deterministic policy invariants.`,
      riskLevel: 'LOW',
      action,
      timestamp
    };
  }

  /**
   * Redacts sensitive fields from text payloads passed to LLMs.
   */
  public scrubSecrets(payload: Record<string, unknown>): Record<string, unknown> {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(payload)) {
      if (this.isSecretField(key)) {
        scrubbed[key] = '[REDACTED_SECRET]';
      } else if (typeof val === 'object' && val !== null) {
        scrubbed[key] = this.scrubSecrets(val as Record<string, unknown>);
      } else {
        scrubbed[key] = val;
      }
    }
    return scrubbed;
  }
}
