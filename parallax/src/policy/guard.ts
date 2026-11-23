import type { Action, DomFacts, PolicyDecision, PolicyLedgerEntry, PolicyStatus } from '../core/types.ts';

/** autocomplete tokens that mark credential, OTP or card inputs (HTML spec). */
const SECRET_AUTOCOMPLETE = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp'];

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
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
          allowed: false,
          reason: `URL scheme '${parsed.protocol}' rejected: only http and https may leave the browser.`
        };
      }
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
   * Checks the element the browser actually resolved, so an opaque selector like
   * '#field-3' cannot hide a password or OTP box from the guard.
   */
  public isSecretDomElement(dom?: DomFacts): boolean {
    if (!dom) return false;
    if (dom.inputType?.toLowerCase() === 'password') return true;
    const autocomplete = dom.autocomplete?.toLowerCase() ?? '';
    if (SECRET_AUTOCOMPLETE.some((token) => autocomplete.includes(token))) return true;
    return [dom.name, dom.ariaLabel].some((attr) => attr !== undefined && this.isSecretField(attr));
  }

  /**
   * Returns why an action counts as state-changing, or null if it is read-only.
   * With DOM facts present the agent's own label is ignored: a hijacked agent can
   * call the "Pay" button "View details", but it cannot change the button's text.
   * A CLICK without DOM facts cannot be verified, so it fails closed.
   */
  public stateChangeReason(action: Action): string | null {
    if (action.isStateChanging || action.type === 'SUBMIT') {
      return 'declared state-changing';
    }

    const matches = (s?: string) =>
      s !== undefined && this.config.stateChangingKeywords.some((kw) => s.toLowerCase().includes(kw));

    if (action.dom) {
      const { text, ariaLabel, value, formAction } = action.dom;
      const hit = [text, ariaLabel, value, formAction, action.target].find((s) => matches(s));
      return hit ? `page element reads '${hit.trim()}'` : null;
    }

    if (action.type === 'CLICK') {
      return 'no DOM facts available to verify what this click does (fail-closed)';
    }

    return matches(action.target) || matches(action.humanLabel) ? 'target or label matches a state-changing keyword' : null;
  }

  public isStateChangingAction(action: Action): boolean {
    return this.stateChangeReason(action) !== null;
  }

  /** Every URL an action could send the browser to: navigation, link or form target. */
  private outboundUrls(action: Action): string[] {
    const urls: string[] = [];
    if (action.type === 'NAVIGATE' && action.value) urls.push(action.value);
    if (action.dom?.href) urls.push(action.dom.href);
    if (action.dom?.formAction) urls.push(action.dom.formAction);
    return urls;
  }

  /**
   * Evaluates an agent action before it touches the browser.
   * Appends decision to the immutable policy ledger.
   */
  public evaluateAction(action: Action, runId = 'default_run'): PolicyDecision {
    const timestamp = Date.now();

    // 1. Secret Field Protection
    if (action.type === 'TYPE' && (this.isSecretField(action.target) || this.isSecretDomElement(action.dom))) {
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

    // 2. Allowlist check on every destination: navigation, link href, form action
    for (const url of this.outboundUrls(action)) {
      const netCheck = this.evaluateNetworkRequest(url);
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
    const changeReason = this.stateChangeReason(action);
    if (changeReason) {
      const decision: PolicyDecision = {
        status: 'REQUIRE_APPROVAL',
        reason: `Action '${action.humanLabel}' on '${action.target}' is state-changing (${changeReason}) and requires human confirmation.`,
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
