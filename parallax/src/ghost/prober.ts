import type { EventRecord, FailureCategory, Hypothesis, StateSnapshot } from '../core/types.ts';
import type { DeterministicPolicyGuard } from '../policy/guard.ts';

/**
 * GHOST: evidence-driven hypothesis discrimination with bounded, read-only probes.
 *
 * SCORING RULES (the only source of confidence values):
 *   Each evidence item carries a fixed weight by kind:
 *     EXPERIMENT   (result of a read-only probe run now)          0.60
 *     STATUS_CODE  (HTTP status class of the observed failure)    0.25
 *     MESSAGE      (wording of the observed error message)        0.15
 *   S = sum of supporting weights, C = sum of contradicting weights.
 *   confidence = S / (S + C + U), U = 0.25 (fixed mass for unobserved alternatives),
 *   rounded to 2 decimals. Finite evidence therefore never reaches 1.0, and no evidence gives 0.
 *
 * STATUS RULES:
 *   REFUTED       a probe contradicted the hypothesis and no probe supported it.
 *   CONFIRMED     a probe supported it, at least one independent observation supported it,
 *                 and no evidence of EXPERIMENT weight contradicts it.
 *   INCONCLUSIVE  anything else (probe failed, was refused by policy, or evidence is mixed).
 *   PROPOSED      formulated from observations only; no probe has been run yet.
 *
 * FAULT_INJECTED events (harness bookkeeping) are never read.
 */
export const EVIDENCE_WEIGHTS = { EXPERIMENT: 0.6, STATUS_CODE: 0.25, MESSAGE: 0.15 } as const;
export const UNOBSERVED_MASS = 0.25;
export const MAX_PROBES = 4;
export const PROBE_TIMEOUT_MS = 3_000;

export type EvidenceKind = keyof typeof EVIDENCE_WEIGHTS;

export interface EvidenceItem {
  kind: EvidenceKind;
  weight: number;
  description: string;
  eventId?: string;
}

export interface ProbeResult {
  probeId: string;
  name: 'SESSION_STATUS' | 'DOM_REQUIREMENTS';
  method: 'GET' | 'DOM_READ';
  target: string;
  readOnly: true;
  outcome: 'OBSERVED' | 'ERROR' | 'SKIPPED_POLICY' | 'SKIPPED_BUDGET' | 'SKIPPED_UNAVAILABLE';
  observed: Record<string, unknown>;
  durationMs: number;
  eventId?: string;
}

export interface GhostHypothesis extends Hypothesis {
  description: string;
  supporting: EvidenceItem[];
  contradicting: EvidenceItem[];
  experiment: { name: ProbeResult['name']; method: ProbeResult['method']; target: string } | null;
  experimentResult: { outcome: ProbeResult['outcome']; observed: Record<string, unknown>; probeEventId?: string } | null;
  scoring: string;
}

export interface GhostDiagnosis {
  runId: string;
  failureEventId: string;
  hypotheses: GhostHypothesis[];
  probes: ProbeResult[];
  leadingHypothesisId: string | null;
  conclusive: boolean;
}

/** Read-only view of the agent's page. GHOST only needs evaluate(). */
export interface ReadOnlyPage {
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
}

export interface ProbeSink {
  readonly runId: string;
  record(type: 'PROBE_EXECUTED' | 'HYPOTHESIS_FORMULATED', actor: 'AGENT', payload: Record<string, unknown>): EventRecord;
}

export interface DiagnoseInput {
  runId: string;
  failureEvent: EventRecord;
  sessionStatusUrl: string;
  guard: DeterministicPolicyGuard;
  page?: ReadOnlyPage;
  sink?: ProbeSink;
  maxProbes?: number;
  fetchImpl?: typeof fetch;
}

interface FailureFacts {
  status?: number;
  message: string;
  eventId: string;
}

const AUTH_MESSAGE = /session|expired|unauthori[sz]ed|re-?authenticat|sign in|log ?in/i;
const REQUIREMENT_MESSAGE = /requir|missing|must be|validation/i;

/** Pure scoring function implementing the documented rules. */
export function scoreHypothesis(supporting: EvidenceItem[], contradicting: EvidenceItem[], probeRan: boolean): { confidence: number; status: Hypothesis['status'] } {
  const S = supporting.reduce((a, e) => a + e.weight, 0);
  const C = contradicting.reduce((a, e) => a + e.weight, 0);
  const confidence = S + C === 0 ? 0 : Math.round((S / (S + C + UNOBSERVED_MASS)) * 100) / 100;
  const expFor = supporting.some((e) => e.kind === 'EXPERIMENT');
  const expAgainst = contradicting.some((e) => e.kind === 'EXPERIMENT');
  const obsFor = supporting.some((e) => e.kind !== 'EXPERIMENT');
  let status: Hypothesis['status'];
  if (!probeRan) status = 'PROPOSED';
  else if (expAgainst && !expFor) status = 'REFUTED';
  else if (expFor && obsFor && !expAgainst) status = 'CONFIRMED';
  else status = 'INCONCLUSIVE';
  return { confidence, status };
}

function scoringText(supporting: EvidenceItem[], contradicting: EvidenceItem[], confidence: number): string {
  const S = supporting.reduce((a, e) => a + e.weight, 0);
  const C = contradicting.reduce((a, e) => a + e.weight, 0);
  return `S=${S.toFixed(2)} C=${C.toFixed(2)} U=${UNOBSERVED_MASS} → S/(S+C+U)=${confidence.toFixed(2)}`;
}

export class GhostProber {
  /** Extracts the observed failure facts. Only FAILURE_DETECTED events are accepted. */
  public static failureFacts(event: EventRecord): FailureFacts {
    if (event.type !== 'FAILURE_DETECTED') throw new Error(`GHOST diagnoses FAILURE_DETECTED events, got ${event.type}`);
    const status = typeof event.payload.status === 'number' ? event.payload.status : undefined;
    const message = typeof event.payload.error === 'string' ? event.payload.error : '';
    return { status, message, eventId: event.id };
  }

  /** Observation-only evidence for H1 (session) and H2 (dynamic requirement). */
  private observationEvidence(f: FailureFacts): Record<'H1' | 'H2', { sup: EvidenceItem[]; con: EvidenceItem[] }> {
    const h1 = { sup: [] as EvidenceItem[], con: [] as EvidenceItem[] };
    const h2 = { sup: [] as EvidenceItem[], con: [] as EvidenceItem[] };
    const w = EVIDENCE_WEIGHTS;
    if (f.status === 401 || f.status === 403) {
      h1.sup.push({ kind: 'STATUS_CODE', weight: w.STATUS_CODE, description: `Observed HTTP ${f.status} (authentication class) on the failed request.`, eventId: f.eventId });
      h2.con.push({ kind: 'STATUS_CODE', weight: w.STATUS_CODE, description: `Observed HTTP ${f.status} is an authentication status, not a validation status.`, eventId: f.eventId });
    } else if (f.status === 400 || f.status === 422) {
      h2.sup.push({ kind: 'STATUS_CODE', weight: w.STATUS_CODE, description: `Observed HTTP ${f.status} (validation class) on the failed request.`, eventId: f.eventId });
      h1.con.push({ kind: 'STATUS_CODE', weight: w.STATUS_CODE, description: `Observed HTTP ${f.status} is a validation status, not an authentication status.`, eventId: f.eventId });
    }
    if (f.message && AUTH_MESSAGE.test(f.message)) {
      h1.sup.push({ kind: 'MESSAGE', weight: w.MESSAGE, description: `Error text mentions authentication: "${f.message.slice(0, 120)}"`, eventId: f.eventId });
    }
    if (f.message && REQUIREMENT_MESSAGE.test(f.message) && !AUTH_MESSAGE.test(f.message)) {
      h2.sup.push({ kind: 'MESSAGE', weight: w.MESSAGE, description: `Error text names a requirement: "${f.message.slice(0, 120)}"`, eventId: f.eventId });
    }
    return { H1: h1, H2: h2 };
  }

  /**
   * Full diagnosis: formulate H1/H2 from observations, run at most `maxProbes` read-only
   * probes, then score. Records PROBE_EXECUTED and HYPOTHESIS_FORMULATED events when a sink is given.
   */
  public async diagnose(input: DiagnoseInput): Promise<GhostDiagnosis> {
    const facts = GhostProber.failureFacts(input.failureEvent);
    const obs = this.observationEvidence(facts);
    const budget = Math.min(input.maxProbes ?? MAX_PROBES, MAX_PROBES);
    const probes: ProbeResult[] = [];
    const runProbe = async (p: () => Promise<ProbeResult>, name: ProbeResult['name'], method: ProbeResult['method'], target: string): Promise<ProbeResult> => {
      const result = probes.length >= budget
        ? { probeId: `probe_${probes.length + 1}`, name, method, target, readOnly: true as const, outcome: 'SKIPPED_BUDGET' as const, observed: {}, durationMs: 0 }
        : await p();
      if (input.sink) {
        result.eventId = input.sink.record('PROBE_EXECUTED', 'AGENT', { ...result, failureEventId: facts.eventId }).id;
      }
      probes.push(result);
      return result;
    };

    const session = await runProbe(() => this.sessionProbe(input, probes.length + 1), 'SESSION_STATUS', 'GET', input.sessionStatusUrl);
    const dom = await runProbe(() => this.domProbe(input.page, probes.length + 1), 'DOM_REQUIREMENTS', 'DOM_READ', 'visible required form controls');

    // H1 experiment evidence
    const w = EVIDENCE_WEIGHTS.EXPERIMENT;
    if (session.outcome === 'OBSERVED') {
      const st = session.observed.httpStatus;
      const active = session.observed.active;
      if (st === 401 || st === 403 || active === false) {
        obs.H1.sup.push({ kind: 'EXPERIMENT', weight: w, description: `Session probe now returns HTTP ${String(st)} (active=${String(active)}).`, eventId: session.eventId });
      } else if (st === 200 && active === true) {
        obs.H1.con.push({ kind: 'EXPERIMENT', weight: w, description: 'Session probe now returns HTTP 200 with an active session.', eventId: session.eventId });
      }
    }
    // H2 experiment evidence
    if (dom.outcome === 'OBSERVED') {
      const missing = Array.isArray(dom.observed.missingRequired) ? (dom.observed.missingRequired as Array<Record<string, unknown>>) : [];
      const conditional = missing.filter((m) => typeof m.revealedBy === 'string');
      if (conditional.length > 0) {
        const names = conditional.map((m) => `${String(m.field)} (revealed by #${String(m.revealedBy)}, checked=${String(m.controllerChecked)})`).join(', ');
        obs.H2.sup.push({ kind: 'EXPERIMENT', weight: w, description: `DOM probe: dynamically required field(s) visible and empty: ${names}.`, eventId: dom.eventId });
      } else if (missing.length === 0) {
        obs.H2.con.push({ kind: 'EXPERIMENT', weight: w, description: 'DOM probe: no visible required field is empty.', eventId: dom.eventId });
      }
      // Required-but-not-conditional empty fields are neither: they are an ordinary missing field.
    }

    const build = (key: 'H1' | 'H2'): GhostHypothesis => {
      const isH1 = key === 'H1';
      const probe = isH1 ? session : dom;
      const { sup, con } = obs[key];
      const probeRan = probe.outcome !== 'SKIPPED_BUDGET';
      const { confidence, status } = scoreHypothesis(sup, con, probeRan);
      const category: FailureCategory = isH1 ? 'SESSION_EXPIRY' : 'HIDDEN_DEPENDENCY';
      return {
        id: `hyp_${input.runId}_${facts.eventId}_${key}`,
        runId: input.runId,
        claim: isH1 ? 'H1: The authentication session expired before the request.' : 'H2: A dynamically revealed requirement was left unmet.',
        description: isH1
          ? 'The backend rejected the request because the applicant session was no longer valid.'
          : 'A prior selection revealed an additional mandatory field that was empty when the step was sent.',
        category,
        supportingEvidence: sup.map((e) => e.description),
        contradictoryEvidence: con.map((e) => e.description),
        supporting: sup,
        contradicting: con,
        confidenceScore: confidence,
        status,
        experiment: { name: probe.name, method: probe.method, target: probe.target },
        experimentResult: { outcome: probe.outcome, observed: probe.observed, probeEventId: probe.eventId },
        scoring: scoringText(sup, con, confidence)
      };
    };

    const hypotheses = [build('H1'), build('H2')];
    if (input.sink) {
      for (const h of hypotheses) input.sink.record('HYPOTHESIS_FORMULATED', 'AGENT', { hypothesis: h, failureEventId: facts.eventId });
    }
    const confirmed = hypotheses.filter((h) => h.status === 'CONFIRMED');
    const leading = confirmed.length === 1 ? confirmed[0] : null;
    return {
      runId: input.runId,
      failureEventId: facts.eventId,
      hypotheses,
      probes,
      leadingHypothesisId: leading ? leading.id : null,
      conclusive: leading !== null
    };
  }

  /** GET on the session-status endpoint. Never sends a body, never follows redirects, never stores tokens. */
  private async sessionProbe(input: DiagnoseInput, n: number): Promise<ProbeResult> {
    const base = { probeId: `probe_${n}`, name: 'SESSION_STATUS' as const, method: 'GET' as const, target: input.sessionStatusUrl, readOnly: true as const };
    const started = Date.now();
    const policy = input.guard.evaluateNetworkRequest(input.sessionStatusUrl);
    if (!policy.allowed) {
      return { ...base, outcome: 'SKIPPED_POLICY', observed: { reason: policy.reason }, durationMs: 0 };
    }
    try {
      const res = await (input.fetchImpl ?? fetch)(input.sessionStatusUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      let active: boolean | null = null;
      try {
        const body: unknown = await res.json();
        if (typeof body === 'object' && body !== null && typeof (body as { active?: unknown }).active === 'boolean') {
          active = (body as { active: boolean }).active; // only this field is kept
        }
      } catch {
        active = null; // non-JSON body: status alone is the observation
      }
      return { ...base, outcome: 'OBSERVED', observed: { httpStatus: res.status, active }, durationMs: Date.now() - started };
    } catch (err) {
      return { ...base, outcome: 'ERROR', observed: { error: err instanceof Error ? err.message : String(err) }, durationMs: Date.now() - started };
    }
  }

  /** Reads (never writes) visible, enabled, required controls that are empty. */
  private async domProbe(page: ReadOnlyPage | undefined, n: number): Promise<ProbeResult> {
    const base = { probeId: `probe_${n}`, name: 'DOM_REQUIREMENTS' as const, method: 'DOM_READ' as const, target: 'visible required form controls', readOnly: true as const };
    if (!page) return { ...base, outcome: 'SKIPPED_UNAVAILABLE', observed: { reason: 'No browser page available.' }, durationMs: 0 };
    const started = Date.now();
    try {
      const observed = await page.evaluate(readRequirementsInPage, null);
      return { ...base, outcome: 'OBSERVED', observed, durationMs: Date.now() - started };
    } catch (err) {
      return { ...base, outcome: 'ERROR', observed: { error: err instanceof Error ? err.message : String(err) }, durationMs: Date.now() - started };
    }
  }

  /**
   * Observation-only hypotheses (no probes): status PROPOSED, confidence from the same
   * documented rules. Kept for callers that only have an error message.
   */
  public formulateHypotheses(runId: string, failureError: string, _lastGood?: StateSnapshot, _failed?: StateSnapshot, status?: number): GhostHypothesis[] {
    const facts: FailureFacts = { status, message: failureError, eventId: 'unrecorded' };
    const obs = this.observationEvidence(facts);
    return (['H1', 'H2'] as const).map((key) => {
      const { sup, con } = obs[key];
      const { confidence, status: st } = scoreHypothesis(sup, con, false);
      return {
        id: `hyp_${runId}_${key}`,
        runId,
        claim: key === 'H1' ? 'H1: The authentication session expired before the request.' : 'H2: A dynamically revealed requirement was left unmet.',
        description: 'Formulated from the error observation only; not yet tested.',
        category: key === 'H1' ? 'SESSION_EXPIRY' : 'HIDDEN_DEPENDENCY',
        supportingEvidence: sup.map((e) => e.description),
        contradictoryEvidence: con.map((e) => e.description),
        supporting: sup,
        contradicting: con,
        confidenceScore: confidence,
        status: st,
        experiment: null,
        experimentResult: null,
        scoring: scoringText(sup, con, confidence)
      };
    });
  }
}

/** Runs in the page. Pure read: queries DOM properties, assigns nothing. */
function readRequirementsInPage(_: null): Record<string, unknown> {
  const missing: Array<Record<string, unknown>> = [];
  const controls = Array.from(document.querySelectorAll('input, select, textarea'));
  for (const el of controls) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
    const required = el.required || el.getAttribute('aria-required') === 'true';
    if (!required || el.disabled) continue;
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    if (!visible) continue;
    let empty: boolean;
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) empty = !el.checked;
    else if (el instanceof HTMLInputElement && el.type === 'file') empty = !el.files || el.files.length === 0;
    else empty = el.value.trim() === '';
    if (!empty) continue;
    const conditional = el.closest('[data-conditional-on]');
    const controllerId = conditional ? conditional.getAttribute('data-conditional-on') : null;
    const controller = controllerId ? document.getElementById(controllerId) : null;
    missing.push({
      field: el.id || el.name,
      revealedBy: controllerId,
      controllerChecked: controller instanceof HTMLInputElement ? controller.checked : null
    });
  }
  return { missingRequired: missing, step: document.body.getAttribute('data-step') };
}
