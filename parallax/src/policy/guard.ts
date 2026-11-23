import type { Action, PolicyDecision, PolicyLedgerEntry, PolicyStatus } from '../core/types.ts';

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
    /otp/i,
    /auth[_-]?code/i,
    /api[_-]?key/i
  ],
  stateChangingKeywords: [
    'submit',
    'apply',
    'confirm',
    'pay',
    'purchase',
    'delete',
    'checkout',
    'finalize',
    'authorize',
    'transfer'
  ]
};

export class DeterministicPolicyGuard {
  private config: GuardConfig;
  private ledger: PolicyLedgerEntry[] = [];

  constructor(config?: Partial<GuardConfig>) {
    this.config = {
      allowedHosts: config?.allowedHosts ?? DEFAULT_GUARD_CONFIG.allowedHosts,
      sensitiveFieldPatterns: config?.sensitiveFieldPatterns ?? DEFAULT_GUARD_CONFIG.sensitiveFieldPatterns,
      stateChangingKeywords: config?.stateChangingKeywords ?? DEFAULT_GUARD_CONFIG.stateChangingKeywords
    };
  }

  public getAllowedHosts(): string[] {
    return [...this.config.allowedHosts];
  }

  public addAllowedHost(host: string): void {
    if (!this.config.allowedHosts.includes(host)) {
      this.config.allowedHosts.push(host);
    }
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
          reason: `Network request to '${host}' blocked by strict allowlist. Exfiltration rejected.`
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
   * Checks if an input element or selector targets a protected secret field.
   */
  public isSecretField(targetSelector: string): boolean {
    return this.config.sensitiveFieldPatterns.some((pattern) => pattern.test(targetSelector));
  }

  /**
   * Detects if an action modifies external state or performs an irreversible operation.
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
   * Appends decision to the immutable policy ledger.
   */
  public evaluateAction(action: Action, runId = 'default_run'): PolicyDecision {
    const timestamp = Date.now();

    // 1. Secret Field Protection
    if (action.type === 'TYPE' && this.isSecretField(action.target)) {
      const decision: PolicyDecision = {
        status: 'BLOCK',
        reason: `Agent attempted to type into protected secret field '${action.target}'.`,
        violatedRule: 'RULE_SECRET_FIELD_BAN',
        riskLevel: 'CRITICAL',
        action,
        timestamp
      };
      this.recordLedgerEntry(runId, decision);
      return decision;
    }

    // 2. Navigation Allowlist Check
    if (action.type === 'NAVIGATE' && action.value) {
      const netCheck = this.evaluateNetworkRequest(action.value);
      if (!netCheck.allowed) {
        const decision: PolicyDecision = {
          status: 'BLOCK',
          reason: netCheck.reason,
          violatedRule: 'RULE_NETWORK_ALLOWLIST',
          riskLevel: 'CRITICAL',
          action,
          timestamp
        };
        this.recordLedgerEntry(runId, decision);
        return decision;
      }
    }

    // 3. Human Gate for State-Changing Operations
    if (this.isStateChangingAction(action)) {
      const decision: PolicyDecision = {
        status: 'REQUIRE_APPROVAL',
        reason: `Action '${action.humanLabel}' on '${action.target}' is state-changing and requires human confirmation.`,
        violatedRule: 'RULE_HUMAN_APPROVAL_GATE',
        riskLevel: 'HIGH',
        action,
        timestamp
      };
      this.recordLedgerEntry(runId, decision);
      return decision;
    }

    // 4. Default: Safe operation allowed
    const decision: PolicyDecision = {
      status: 'ALLOW',
      reason: `Action '${action.humanLabel}' passed deterministic policy invariants.`,
      riskLevel: 'LOW',
      action,
      timestamp
    };
    this.recordLedgerEntry(runId, decision);
    return decision;
  }

  private recordLedgerEntry(runId: string, decision: PolicyDecision): void {
    this.ledger.push({
      id: `led_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      runId,
      timestamp: decision.timestamp,
      decision
    });
  }

  /**
   * Resolves a pending human approval in the ledger with audit trail.
   */
  public resolveHumanApproval(
    actionId: string,
    approved: boolean,
    operator = 'Human_Operator',
    notes?: string
  ): boolean {
    const entry = this.ledger.find(
      (e) => e.decision.action.id === actionId && e.decision.status === 'REQUIRE_APPROVAL'
    );
    if (!entry) return false;

    entry.humanResolution = {
      resolvedBy: operator,
      decision: approved ? 'APPROVED' : 'DENIED',
      timestamp: Date.now(),
      notes
    };
    return true;
  }

  public getLedger(runId?: string): PolicyLedgerEntry[] {
    if (!runId) return [...this.ledger];
    return this.ledger.filter((e) => e.runId === runId);
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
