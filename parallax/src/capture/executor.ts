import type { ElementHandle, Page } from 'playwright';
import type { Action, ActionType, DomFacts, EventRecord, PolicyDecision } from '../core/types.ts';
import type { DeterministicPolicyGuard } from '../policy/guard.ts';
import type { ApprovalGate, ApprovalResolution } from './approval.ts';
import type { BrowserCapture } from './browser.ts';
import { extractDomFacts, fingerprintDomFacts } from './domFacts.ts';
import type { EventSink } from './recorder.ts';
import { REDACTED } from './redact.ts';

/**
 * What an agent (or planner) may propose. Any `dom` it supplies is discarded:
 * DOM facts are always read from the live element by the executor.
 */
export interface ActionProposal {
  id: string;
  type: ActionType;
  target: string;
  value?: string;
  humanLabel: string;
  isStateChanging?: boolean;
  dom?: unknown;
  metadata?: Record<string, unknown>;
}

export type ExecutionStatus = 'EXECUTED' | 'BLOCKED' | 'DENIED' | 'CANCELLED' | 'FAILED';

export interface ExecutionOutcome {
  status: ExecutionStatus;
  action: Action;
  reason: string;
  decision?: PolicyDecision;
  approval?: ApprovalResolution;
  events: EventRecord[];
}

export interface ExecutorHooks {
  /**
   * Called after a human approves and BEFORE revalidation and dispatch. Used by the demo
   * harness to inject a fault (session expiry) at the moment it would realistically occur.
   */
  afterApproval?: (action: Action) => Promise<void>;
}

const ELEMENT_ACTIONS: ReadonlySet<ActionType> = new Set(['CLICK', 'TYPE', 'SUBMIT', 'SELECT']);
const SECRET_PATTERN = /password|secret|token|otp|cvv|card/i;

/**
 * The only component allowed to dispatch browser actions. For every action:
 *   1. resolve the target to exactly one live element (else fail closed);
 *   2. read DomFacts from that element with locator/handle.evaluate (else fail closed);
 *   3. ask Person 1's guard; BLOCK never runs, REQUIRE_APPROVAL waits for a human;
 *   4. after approval, re-resolve the element, re-read facts and re-ask the guard;
 *      a changed element or a BLOCK cancels the action;
 *   5. immediately before dispatch, re-read facts on the same handle; any change cancels;
 *   6. dispatch on that same handle, so the element evaluated is the element acted on.
 */
export class GuardedExecutor {
  private readonly capture: BrowserCapture;
  private readonly guard: DeterministicPolicyGuard;
  private readonly gate: ApprovalGate;
  private readonly sink: EventSink;
  private readonly hooks: ExecutorHooks;

  constructor(opts: { capture: BrowserCapture; guard: DeterministicPolicyGuard; gate: ApprovalGate; sink: EventSink; hooks?: ExecutorHooks }) {
    this.capture = opts.capture;
    this.guard = opts.guard;
    this.gate = opts.gate;
    this.sink = opts.sink;
    this.hooks = opts.hooks ?? {};
  }

  public async execute(proposal: ActionProposal): Promise<ExecutionOutcome> {
    const events: EventRecord[] = [];
    const base: Action = {
      id: proposal.id,
      type: proposal.type,
      target: proposal.target,
      value: proposal.value,
      // A proposal may make itself stricter, never laxer: the guard reads the DOM regardless.
      isStateChanging: proposal.isStateChanging === true,
      humanLabel: proposal.humanLabel,
      metadata: proposal.metadata
    };
    const fail = (status: ExecutionStatus, reason: string, action: Action, extra: Partial<ExecutionOutcome> = {}): ExecutionOutcome => {
      events.push(this.sink.record('ACTION_EXECUTION_FAILED', 'GUARD', { actionId: action.id, status, reason, ...this.describe(action) }));
      return { status, action, reason, events, ...extra };
    };

    let page: Page;
    try {
      page = this.capture.pageForExecutor();
    } catch (err) {
      return fail('FAILED', `Browser unavailable: ${errorText(err)}`, base);
    }

    // 1-2. Resolve element and read live DOM facts.
    let handle: ElementHandle<Element> | undefined;
    let action: Action = base;
    if (ELEMENT_ACTIONS.has(proposal.type)) {
      try {
        handle = await this.resolveSingle(page, proposal.target);
        action = { ...base, dom: await extractDomFacts(handle) };
      } catch (err) {
        return fail('FAILED', `DOM inspection failed; action not executed (fail-closed): ${errorText(err)}`, base);
      }
    } else if (proposal.type === 'NAVIGATE') {
      if (!proposal.value) return fail('FAILED', 'NAVIGATE requires a URL in value.', base);
      try {
        action = { ...base, value: new URL(proposal.value, page.url()).toString() };
      } catch {
        return fail('BLOCKED', `Malformed navigation URL rejected: ${proposal.value}`, base);
      }
    } else if (proposal.type !== 'WAIT') {
      return fail('FAILED', `Action type ${proposal.type} is abstract and must be mapped to a concrete UI action first.`, base);
    }

    const fingerprint = fingerprintDomFacts(action.dom);
    events.push(this.sink.record('ACTION_PROPOSED', 'AGENT', {
      actionId: action.id,
      ...this.describe(action),
      factsFingerprint: fingerprint,
      domSource: action.dom ? 'playwright:elementHandle.evaluate (live element)' : 'none',
      agentSuppliedDomIgnored: proposal.dom !== undefined
    }));

    // 3. Guard.
    let decision = this.guard.evaluateAction(action, this.sink.runId);
    events.push(this.recordDecision(action, decision));
    if (decision.status === 'BLOCK') {
      return { status: 'BLOCKED', action, reason: decision.reason, decision, events };
    }

    let approval: ApprovalResolution | undefined;
    if (decision.status === 'REQUIRE_APPROVAL') {
      const shot = handle ? await this.capture.elementScreenshot(handle) : undefined;
      const ticket = this.gate.request({
        runId: this.sink.runId,
        actionId: action.id,
        actionType: action.type,
        target: action.target,
        agentLabel: action.humanLabel,
        dom: action.dom,
        factsFingerprint: fingerprint,
        guardStatus: decision.status,
        guardReason: decision.reason,
        violatedRule: decision.violatedRule,
        riskLevel: decision.riskLevel,
        elementScreenshot: shot
      });
      events.push(this.sink.record('APPROVAL_REQUESTED', 'GUARD', {
        approvalId: ticket.id,
        actionId: action.id,
        ...this.describe(action),
        factsFingerprint: fingerprint,
        reason: decision.reason,
        violatedRule: decision.violatedRule,
        riskLevel: decision.riskLevel
      }));

      approval = await ticket.decision;
      this.guard.resolveHumanApproval(action.id, approval.approved, approval.operator, approval.notes);
      if (!approval.approved) {
        events.push(this.sink.record('APPROVAL_DENIED', 'HUMAN', {
          approvalId: ticket.id, actionId: action.id, operator: approval.operator, notes: approval.notes
        }));
        return { status: 'DENIED', action, reason: approval.notes ?? 'Denied by operator.', decision, approval, events };
      }
      events.push(this.sink.record('APPROVAL_GRANTED', 'HUMAN', {
        approvalId: ticket.id, actionId: action.id, operator: approval.operator, notes: approval.notes, factsFingerprint: fingerprint
      }));

      if (this.hooks.afterApproval) await this.hooks.afterApproval(action);

      // 4. Revalidate: approval covers exactly this element as it was shown, nothing else.
      if (ELEMENT_ACTIONS.has(action.type)) {
        try {
          handle = await this.resolveSingle(page, action.target);
          const fresh = await extractDomFacts(handle);
          if (fingerprintDomFacts(fresh) !== fingerprint) {
            return fail('CANCELLED', 'Target element changed after approval; approval does not transfer (fail-closed).', { ...action, dom: fresh }, { decision, approval });
          }
          action = { ...action, dom: fresh };
        } catch (err) {
          return fail('CANCELLED', `Revalidation failed after approval: ${errorText(err)}`, action, { decision, approval });
        }
      }
      const revalidated = this.guard.evaluateAction(action, this.sink.runId);
      events.push(this.recordDecision(action, revalidated, 'POST_APPROVAL_REVALIDATION'));
      if (revalidated.status === 'BLOCK') {
        return { status: 'BLOCKED', action, reason: revalidated.reason, decision: revalidated, approval, events };
      }
      if (revalidated.status === 'REQUIRE_APPROVAL' && revalidated.violatedRule !== decision.violatedRule) {
        return fail('CANCELLED', `Revalidation raised a different rule (${revalidated.violatedRule}); new approval required.`, action, { decision: revalidated, approval });
      }
      decision = revalidated;
    }

    // 5. Freshness check on the exact handle we will act on.
    if (handle) {
      try {
        const latest = await extractDomFacts(handle);
        if (fingerprintDomFacts(latest) !== fingerprintDomFacts(action.dom)) {
          return fail('CANCELLED', 'DOM changed between policy decision and dispatch (stale facts); not executed.', { ...action, dom: latest }, { decision, approval });
        }
      } catch (err) {
        return fail('CANCELLED', `Target detached before dispatch: ${errorText(err)}`, action, { decision, approval });
      }
    }

    // 6. Dispatch.
    try {
      await this.dispatch(page, action, handle);
    } catch (err) {
      return fail('FAILED', `Browser dispatch failed: ${errorText(err)}`, action, { decision, approval });
    }
    events.push(this.sink.record('ACTION_DISPATCHED', 'AGENT', {
      actionId: action.id,
      ...this.describe(action),
      guardStatus: decision.status,
      approvedBy: approval?.operator,
      factsFingerprint: fingerprintDomFacts(action.dom)
    }));
    return { status: 'EXECUTED', action, reason: decision.reason, decision, approval, events };
  }

  /** Resolves a CSS or aria-ref selector to exactly one attached element. */
  private async resolveSingle(page: Page, target: string): Promise<ElementHandle<Element>> {
    const locator = page.locator(target);
    const count = await locator.count();
    if (count !== 1) throw new Error(`target '${target}' resolved to ${count} elements (exactly 1 required)`);
    const handle = await locator.elementHandle({ timeout: 2_000 });
    if (!handle) throw new Error(`target '${target}' is not attached`);
    return handle;
  }

  private async dispatch(page: Page, action: Action, handle?: ElementHandle<Element>): Promise<void> {
    switch (action.type) {
      case 'NAVIGATE':
        await page.goto(action.value ?? '', { waitUntil: 'domcontentloaded' });
        return;
      case 'WAIT':
        await page.waitForLoadState('domcontentloaded');
        return;
      case 'CLICK':
        await requireHandle(handle).click();
        return;
      case 'TYPE':
        await requireHandle(handle).fill(action.value ?? '');
        return;
      case 'SELECT':
        await requireHandle(handle).selectOption(action.value ?? '');
        return;
      case 'SUBMIT': {
        const h = requireHandle(handle);
        if (action.dom?.tagName === 'form') {
          await h.evaluate((form) => {
            if (form instanceof HTMLFormElement) form.requestSubmit();
            else throw new Error('SUBMIT target is not a form');
          });
        } else {
          await h.click();
        }
        return;
      }
      default:
        throw new Error(`Unsupported action type ${action.type}`);
    }
  }

  private recordDecision(action: Action, decision: PolicyDecision, phase = 'INITIAL'): EventRecord {
    const payload = {
      actionId: action.id,
      phase,
      ...this.describe(action),
      guardStatus: decision.status,
      reason: decision.reason,
      violatedRule: decision.violatedRule,
      riskLevel: decision.riskLevel
    };
    if (decision.status === 'BLOCK') {
      return this.sink.record(decision.violatedRule === 'RULE_NETWORK_ALLOWLIST' ? 'NETWORK_BLOCKED' : 'ACTION_BLOCKED', 'GUARD', {
        ...payload,
        layer: 'ACTION_POLICY',
        source: 'DeterministicPolicyGuard.evaluateAction'
      });
    }
    // ALLOW / REQUIRE_APPROVAL decisions are recorded on the proposal stream; APPROVAL_REQUESTED follows separately.
    return this.sink.record('ACTION_PROPOSED', 'GUARD', { ...payload, kind: 'POLICY_DECISION' });
  }

  /** Display/evidence view of an action. Typed values are hidden for secret-looking fields. */
  private describe(action: Action): Record<string, unknown> {
    const secret = action.type === 'TYPE' && (
      SECRET_PATTERN.test(action.target) ||
      action.dom?.inputType === 'password' ||
      (action.dom?.autocomplete !== undefined && /password|one-time|cc-/.test(action.dom.autocomplete)) ||
      (action.dom?.name !== undefined && SECRET_PATTERN.test(action.dom.name))
    );
    const value = action.value === undefined ? undefined : secret ? REDACTED : action.value.slice(0, 120);
    return {
      actionType: action.type,
      target: action.target,
      agentLabel: action.humanLabel,
      value,
      dom: action.dom satisfies DomFacts | undefined
    };
  }
}

function requireHandle(handle: ElementHandle<Element> | undefined): ElementHandle<Element> {
  if (!handle) throw new Error('No resolved element for element action');
  return handle;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}
