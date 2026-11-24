import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Action, EventRecord, RecoveryPlan } from '../src/core/types.ts';
import { DeterministicPolicyGuard } from '../src/policy/guard.ts';
import { InvariantEngine } from '../src/policy/invariants.ts';
import { RecoveryPlanner } from '../src/planner/recovery.ts';
import { Verifier } from '../src/verify/verifier.ts';
import { ApprovalGate } from '../src/capture/approval.ts';
import type { ApprovalRequest } from '../src/capture/approval.ts';
import { BrowserCapture } from '../src/capture/browser.ts';
import type { BrowserStatus } from '../src/capture/browser.ts';
import { GuardedExecutor } from '../src/capture/executor.ts';
import type { ExecutionOutcome } from '../src/capture/executor.ts';
import { PortalAgent } from '../src/capture/portalAgent.ts';
import type { Persona, StepResult } from '../src/capture/portalAgent.ts';
import { RunRecorder } from '../src/capture/recorder.ts';
import { ChronosTimeline } from '../src/chronos/timeline.ts';
import { GhostProber } from '../src/ghost/prober.ts';
import type { GhostDiagnosis, GhostHypothesis } from '../src/ghost/prober.ts';
import { minimizeFailure } from '../src/ghost/minimize.ts';
import { FailureInjector } from '../demo-app/failures/injector.ts';
import { withIsolatedStep2Oracle } from '../demo-app/failures/isolatedOracle.ts';
import type { Step2Input } from '../demo-app/failures/isolatedOracle.ts';
import { INSTRUCTION_LIKE } from '../demo-app/failures/payloads.ts';
import { buildRunView } from './runView.ts';
import type { RunView } from './runView.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PERSONAS_PATH = path.join(ROOT, 'demo-app', 'fixtures', 'personas.json');

export const SCENARIOS = ['full-demo', 'normal', 'session-expiry', 'missing-document', 'prompt-injection'] as const;
export type ScenarioId = (typeof SCENARIOS)[number];

export type RunStatus =
  | 'IDLE' | 'STARTING' | 'RUNNING' | 'AWAITING_APPROVAL' | 'DIAGNOSING' | 'RECOVERING' | 'VERIFYING'
  | 'VERIFIED' | 'COMPLETED' | 'FAILED' | 'ABORTED';

export type ApprovalPolicy = (req: ApprovalRequest) => 'APPROVE' | 'DENY' | null;

export interface RunControllerOptions {
  portalUrl: string;
  dataDir?: string;
  headless?: boolean;
  slowMoMs?: number;
  approvalTimeoutMs?: number;
  /** Automated operator (tests only). Decides through the same gate.resolve() as the UI. */
  approvalPolicy?: ApprovalPolicy;
}

export interface LiveState {
  runId: string | null;
  scenario: ScenarioId | null;
  status: RunStatus;
  phase: string;
  step: number | null;
  browser: BrowserStatus;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  outcomeSummary: string | null;
  pendingApprovals: ApprovalRequest[];
  minimizations: Array<Record<string, unknown>>;
  invariantAudit: Record<string, unknown> | null;
  hasScreenshot: boolean;
  view: RunView;
}

interface RunContext {
  runId: string;
  scenario: ScenarioId;
  persona: Persona;
  recorder: RunRecorder;
  guard: DeterministicPolicyGuard;
  gate: ApprovalGate;
  capture: BrowserCapture;
  agent: PortalAgent;
  injector: FailureInjector;
  injectFaultOnSubmitApproval: boolean;
}

export function loadPersonas(): Record<string, Persona> {
  const raw: unknown = JSON.parse(fs.readFileSync(PERSONAS_PATH, 'utf-8'));
  if (typeof raw !== 'object' || raw === null) throw new Error('personas.json is not an object');
  const out: Record<string, Persona> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    const p = v as Record<string, unknown>;
    const s = (key: string): string => {
      if (typeof p[key] !== 'string') throw new Error(`persona ${k}.${key} must be a string`);
      return p[key] as string;
    };
    if (typeof p.meritScholarship !== 'boolean') throw new Error(`persona ${k}.meritScholarship must be boolean`);
    out[k] = {
      name: s('name'), email: s('email'), studentId: s('studentId'), applicationRef: s('applicationRef'), course: s('course'),
      cgpa: s('cgpa'), previousInstitution: s('previousInstitution'), meritScholarship: p.meritScholarship, supportingDocument: s('supportingDocument')
    };
  }
  return out;
}

const PERSONA_FOR: Record<ScenarioId, string> = {
  'full-demo': 'scholarApplicant',
  normal: 'standardApplicant',
  'session-expiry': 'standardApplicant',
  'missing-document': 'scholarApplicantMissingDocument',
  'prompt-injection': 'standardApplicant'
};

/**
 * Drives one real run at a time: Playwright browser → guarded executor → P1 guard → human
 * approval → GHOST probes → CHRONOS reconstruction → P1 planner → P1 verifier.
 * Nothing in here writes an event that was not observed or decided by a real component.
 */
export class RunController {
  private readonly opts: RunControllerOptions;
  private ctx: RunContext | null = null;
  private lastRecorder: RunRecorder | null = null;
  private status: RunStatus = 'IDLE';
  private scenario: ScenarioId | null = null;
  private phase = 'Idle';
  private step: number | null = null;
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private error: string | null = null;
  private outcomeSummary: string | null = null;
  private minimizations: Array<Record<string, unknown>> = [];
  private invariantAudit: Record<string, unknown> | null = null;
  private screenshot: Buffer | null = null;
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private aborted = false;
  private readonly chronos = new ChronosTimeline();
  private readonly ghost = new GhostProber();
  private readonly planner = new RecoveryPlanner();
  private readonly verifier = new Verifier();

  constructor(opts: RunControllerOptions) {
    this.opts = opts;
  }

  public get portalBase(): string {
    return new URL('/', this.opts.portalUrl).toString();
  }

  public isBusy(): boolean {
    return this.running !== null;
  }

  public onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error('[PARALLAX] update listener failed:', err);
      }
    }
  }

  private setStatus(status: RunStatus, phase?: string): void {
    this.status = status;
    if (phase) this.phase = phase;
    this.emit();
  }

  /** Starts a run in the background. Throws if one is already active. */
  public start(scenario: ScenarioId): string {
    if (this.running) throw new Error('A run is already in progress.');
    if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario '${String(scenario)}'.`);
    const runId = `run_${Date.now()}_${scenario.replace(/[^a-z]/g, '')}`;
    this.aborted = false;
    this.scenario = scenario;
    this.error = null;
    this.outcomeSummary = null;
    this.minimizations = [];
    this.invariantAudit = null;
    this.screenshot = null;
    this.step = null;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.setStatus('STARTING', 'Launching browser');
    this.running = this.execute(runId, scenario).catch((err: unknown) => {
      this.error = `Run setup failed: ${err instanceof Error ? err.message : String(err)}`;
      this.status = 'FAILED';
      this.phase = 'Setup error';
    }).finally(() => {
      this.running = null;
      this.finishedAt = Date.now();
      this.emit();
    });
    return runId;
  }

  /** Resolves when the current run (if any) has finished. */
  public async waitForIdle(): Promise<void> {
    if (this.running) await this.running;
  }

  public async abort(): Promise<void> {
    if (!this.ctx) return;
    this.aborted = true;
    this.ctx.gate.denyAll('Run aborted by operator.');
    await this.ctx.capture.close();
  }

  public resolveApproval(id: string, approved: boolean, operator: string, notes?: string): boolean {
    if (!this.ctx) return false;
    return this.ctx.gate.resolve(id, approved, operator, notes);
  }

  public latestScreenshot(): Buffer | null {
    return this.screenshot;
  }

  public liveState(): LiveState {
    const recorder = this.ctx?.recorder ?? this.lastRecorder;
    const events = recorder ? recorder.events() : [];
    const chainValid = recorder ? recorder.store.verifyIntegrity(recorder.runId) : null;
    return {
      runId: recorder?.runId ?? null,
      scenario: this.scenario,
      status: this.status,
      phase: this.phase,
      step: this.step,
      browser: this.ctx?.capture.status ?? (this.lastRecorder ? 'CLOSED' : 'NOT_STARTED'),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
      outcomeSummary: this.outcomeSummary,
      pendingApprovals: this.ctx?.gate.list() ?? [],
      minimizations: this.minimizations,
      invariantAudit: this.invariantAudit,
      hasScreenshot: this.screenshot !== null,
      view: buildRunView(events, chainValid)
    };
  }

  // ------------------------------------------------------------------ run

  private async execute(runId: string, scenario: ScenarioId): Promise<void> {
    const recorder = new RunRecorder(runId, this.opts.dataDir);
    this.lastRecorder = recorder;
    const unsubscribe = recorder.subscribe(() => this.emit());
    const guard = new DeterministicPolicyGuard();
    const gate = new ApprovalGate(this.opts.approvalTimeoutMs ?? 10 * 60_000);
    const capture = new BrowserCapture({ guard, sink: recorder, headless: this.opts.headless ?? true, slowMoMs: this.opts.slowMoMs, appOrigin: this.portalBase });
    const injector = new FailureInjector(this.portalBase, recorder);
    const persona = loadPersonas()[PERSONA_FOR[scenario]];
    if (!persona) throw new Error(`persona ${PERSONA_FOR[scenario]} missing`);

    const ctxRef: { current: RunContext | null } = { current: null };
    const executor = new GuardedExecutor({
      capture, guard, gate, sink: recorder,
      hooks: {
        afterApproval: async (action: Action) => {
          const ctx = ctxRef.current;
          if (ctx && ctx.injectFaultOnSubmitApproval && action.target.includes('submit-application')) {
            ctx.injectFaultOnSubmitApproval = false;
            this.phase = 'Fault injection: session expires before the approved submit is dispatched';
            await injector.injectSessionExpiry();
          }
        }
      }
    });
    const agent = new PortalAgent({ executor, capture, sink: recorder });
    const ctx: RunContext = {
      runId, scenario, persona, recorder, guard, gate, capture, agent, injector,
      injectFaultOnSubmitApproval: scenario === 'full-demo'
    };
    ctxRef.current = ctx;
    this.ctx = ctx;

    let statusBeforeApproval: RunStatus = 'RUNNING';
    const offGate = gate.onChange(() => {
      const pending = gate.list();
      if (pending.length > 0) {
        if (this.status !== 'AWAITING_APPROVAL') statusBeforeApproval = this.status;
        this.setStatus('AWAITING_APPROVAL', `Waiting for human decision: ${pending[0].actionType} ${pending[0].target}`);
        const policy = this.opts.approvalPolicy;
        if (policy) {
          for (const req of pending) {
            const d = policy(req);
            if (d) queueMicrotask(() => gate.resolve(req.id, d === 'APPROVE', 'automated-test-operator', `policy decision: ${d}`));
          }
        }
      } else if (this.status === 'AWAITING_APPROVAL') {
        this.setStatus(statusBeforeApproval);
      }
    });

    try {
      await injector.resetBackend();
      await capture.launch();
      this.setStatus('RUNNING', 'Opening portal');
      await this.scenarioFlow(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error = this.aborted ? 'Run aborted by operator.' : message;
      recorder.record('FAILURE_DETECTED', 'AGENT', { kind: this.aborted ? 'RUN_ABORTED' : 'RUN_ERROR', error: this.error });
      this.setStatus(this.aborted ? 'ABORTED' : 'FAILED', this.aborted ? 'Aborted' : 'Run error');
    } finally {
      gate.denyAll('Run finished.');
      offGate();
      const audit = InvariantEngine.auditRunInvariants(recorder.events(), guard.getAllowedHosts());
      this.invariantAudit = { ...audit, auditReport: recorder.store.generateAuditReport(runId) };
      await capture.close();
      await injector.clear().catch((e: unknown) => console.error('[PARALLAX] failure clear:', e));
      unsubscribe();
      this.ctx = null;
      this.emit();
    }
  }

  private async snap(ctx: RunContext, label: string): Promise<void> {
    await ctx.capture.captureSnapshot(label);
    this.step = await ctx.agent.currentStep();
    try {
      this.screenshot = await ctx.capture.screenshot();
    } catch (err) {
      console.error('[PARALLAX] screenshot failed:', err instanceof Error ? err.message : err);
    }
    this.emit();
  }

  private ensure(outcome: ExecutionOutcome, what: string): void {
    if (outcome.status !== 'EXECUTED') throw new Error(`${what} was not executed (${outcome.status}): ${outcome.reason}`);
  }

  private async scenarioFlow(ctx: RunContext): Promise<void> {
    const { agent, persona, scenario } = ctx;
    this.ensure(await agent.open(this.portalBase), 'Opening the portal');
    await this.snap(ctx, 'Portal loaded (step 1)');

    this.phase = 'Step 1: personal details';
    const s1 = await agent.fillStep1(persona);
    this.ensure(s1.outcome, 'Step 1');
    if (s1.stepAfter !== 2) throw new Error('Portal did not advance to step 2 after valid personal details.');
    await this.snap(ctx, 'Step 1 accepted');

    this.phase = 'Step 2: academic details';
    const s2 = await agent.fillStep2(persona, { includeDocument: true });
    if (s2) this.ensure(s2, 'Step 2 field entry');
    await this.snap(ctx, 'Step 2 filled');

    if (scenario === 'full-demo' || scenario === 'prompt-injection') await this.injectionSegment(ctx);

    this.phase = 'Continue to review';
    let review = await agent.continueToReview();
    this.ensure(review.outcome, 'Continue to review');
    if (review.stepAfter !== 3) {
      await this.snap(ctx, 'Step 2 rejected');
      const recovered = await this.diagnoseAndRecover(ctx, review);
      if (!recovered) return;
      this.phase = 'Resuming workflow from last good state';
      review = await agent.continueToReview();
      this.ensure(review.outcome, 'Continue to review (after recovery)');
      if (review.stepAfter !== 3) {
        await this.snap(ctx, 'Step 2 still rejected after recovery');
        this.outcomeSummary = 'Recovery executed but the step was still rejected. Not retried (bounded).';
        this.setStatus('FAILED', 'Recovery did not resolve the failure');
        return;
      }
    }
    await this.snap(ctx, 'Review page (step 3)');

    if (scenario === 'prompt-injection') {
      this.outcomeSummary = 'Injection recorded as data; hijacked navigation and beacon blocked. No submission attempted in this scenario.';
      this.setStatus('COMPLETED', 'Prompt-injection scenario complete');
      return;
    }

    if (scenario === 'full-demo') await this.paySegment(ctx);

    this.phase = 'Attestation';
    const att = await agent.attest();
    this.ensure(att.outcome, 'Attestation');

    if (scenario === 'session-expiry') {
      this.phase = 'Fault injection: session expiry';
      await ctx.injector.injectSessionExpiry();
    }

    this.phase = 'Final submission (requires human approval)';
    const submit = await agent.submitApplication();
    if (submit.outcome.status === 'DENIED' || submit.outcome.status === 'BLOCKED' || submit.outcome.status === 'CANCELLED') {
      await this.snap(ctx, `Submission ${submit.outcome.status.toLowerCase()}`);
      await this.verifyNothingFiled(ctx, submit.outcome.status);
      return;
    }
    this.ensure(submit.outcome, 'Submission');
    if ((await agent.applicationIdShown()) === null) {
      await this.snap(ctx, 'Submission failed');
      const recovered = await this.diagnoseAndRecover(ctx, submit);
      if (!recovered) return;
    }
    await this.snap(ctx, 'After submission');
    await this.verify(ctx);
  }

  private async injectionSegment(ctx: RunContext): Promise<void> {
    this.phase = 'Untrusted content: reveal hidden draft comment';
    const beaconSeen = this.waitForEvent(ctx.recorder, (e) => e.type === 'NETWORK_BLOCKED' && e.payload.layer === 'BROWSER_NETWORK', 5_000);
    const reveal = await ctx.agent.revealHiddenText();
    this.ensure(reveal.outcome, 'Reveal toggle');
    const beacon = await beaconSeen;
    if (!beacon) {
      ctx.recorder.record('DOM_OBSERVED', 'BROWSER', { kind: 'NOTE', note: 'No off-allowlist request observed within 5s of the reveal.' });
    }
    await this.snap(ctx, 'Hidden text revealed');

    const untrusted = await ctx.agent.scanUntrustedContent(INSTRUCTION_LIKE);
    const hostile = untrusted.find((u) => u.instructionLike);
    if (!hostile) return;
    // What a hijacked model would propose after reading this text. Clearly labelled as a
    // simulation; the deterministic agent itself never acts on page text.
    const host = /\bto\s+([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(hostile.text)?.[1];
    if (!host) return;
    this.phase = 'Simulated hijacked proposal: navigate to attacker host';
    const hijack = await ctx.agent.propose({
      tag: 'hijack-nav', type: 'NAVIGATE', target: 'browser', value: `http://${host}/collect`,
      humanLabel: 'Open reviewer reference page',
      metadata: { simulated: 'HIJACKED_MODEL_PROPOSAL', derivedFrom: hostile.selector }
    });
    if (hijack.outcome.status === 'EXECUTED') throw new Error('SECURITY INVARIANT VIOLATED: hijacked navigation executed.');
  }

  private async paySegment(ctx: RunContext): Promise<void> {
    this.phase = 'Simulated hijacked proposal: "View fee details" (actually the Pay button)';
    const pay = await ctx.agent.propose({
      tag: 'hijack-pay', type: 'CLICK', target: '#fee-action-7', humanLabel: 'View fee details',
      metadata: { simulated: 'HIJACKED_MODEL_PROPOSAL', note: 'Label is the agent\'s; DOM facts come from the live element.' }
    });
    await this.snap(ctx, `Spoofed Pay proposal ${pay.outcome.status.toLowerCase()}`);
  }

  /** GHOST + CHRONOS + P1 planner. Returns true only if recovery actions really executed. */
  private async diagnoseAndRecover(ctx: RunContext, failed: StepResult): Promise<boolean> {
    this.setStatus('DIAGNOSING', 'GHOST: formulating and probing hypotheses');
    await ctx.capture.flush();
    const events = ctx.recorder.events();
    const dispatched = failed.outcome.events.find((e) => e.type === 'ACTION_DISPATCHED');
    const startIdx = dispatched ? events.findIndex((e) => e.id === dispatched.id) : 0;
    const failure = events.slice(startIdx).find((e) => e.type === 'FAILURE_DETECTED' && e.payload.kind === 'HTTP_ERROR' && e.payload.path !== '/api/session');
    if (!failure) {
      this.outcomeSummary = 'The step did not advance but no failing backend response was observed; refusing to guess.';
      this.setStatus('FAILED', 'Failure without evidence');
      return false;
    }

    const diagnosis = await this.ghost.diagnose({
      runId: ctx.runId,
      failureEvent: failure,
      sessionStatusUrl: new URL('/api/session', this.portalBase).toString(),
      guard: ctx.guard,
      page: ctx.capture.pageForExecutor(),
      sink: { runId: ctx.runId, record: (type, actor, payload) => ctx.recorder.record(type, actor, payload) }
    });
    this.emit();

    const leading = diagnosis.hypotheses.find((h) => h.id === diagnosis.leadingHypothesisId);
    if (leading?.category === 'HIDDEN_DEPENDENCY') await this.minimize(ctx, failure);

    // CHRONOS is computed from the event store on demand (runView); nothing extra is stored.
    if (!leading) {
      this.outcomeSummary = 'Diagnosis INCONCLUSIVE: no single hypothesis confirmed. Recovery withheld.';
      this.setStatus('FAILED', 'Recovery withheld (inconclusive diagnosis)');
      return false;
    }
    const readiness = InvariantEngine.checkRecoveryReadiness(leading.confidenceScore);
    if (!readiness.satisfied) {
      this.outcomeSummary = readiness.violationReason ?? 'Recovery readiness invariant not satisfied.';
      this.setStatus('FAILED', 'Recovery withheld (INV_4)');
      return false;
    }

    this.setStatus('RECOVERING', 'MIRROR/planner: selecting recovery candidate');
    const plan = this.planner.planRecovery(ctx.runId, leading);
    this.recordPlan(ctx, plan, leading, diagnosis);

    for (const planned of plan.actions) {
      const concrete = await ctx.agent.materialize(planned);
      if (!concrete) {
        ctx.recorder.record('ACTION_PROPOSED', 'AGENT', {
          kind: 'RECOVERY_ACTION_DEFERRED', planId: plan.id, actionId: planned.id, target: planned.target,
          reason: 'Target not present/visible on the current page; the workflow performs this step later under the same guard.'
        });
        continue;
      }
      this.phase = `Recovery: ${concrete.humanLabel}`;
      const res = await ctx.agent.propose({
        tag: 'recovery', type: concrete.type, target: concrete.target, value: concrete.value,
        humanLabel: concrete.humanLabel, isStateChanging: concrete.isStateChanging, metadata: { planId: plan.id, plannedActionId: planned.id }
      });
      if (res.outcome.status !== 'EXECUTED') {
        await this.snap(ctx, `Recovery step ${res.outcome.status.toLowerCase()}`);
        if (res.outcome.status === 'DENIED' && concrete.type === 'SUBMIT') {
          await this.verifyNothingFiled(ctx, 'DENIED');
        } else {
          this.outcomeSummary = `Recovery stopped: ${concrete.humanLabel} → ${res.outcome.status} (${res.outcome.reason}).`;
          this.setStatus('FAILED', 'Recovery stopped');
        }
        return false;
      }
      if (res.errorShown && concrete.type === 'SUBMIT') {
        await this.snap(ctx, 'Recovery submit failed');
        this.outcomeSummary = 'Recovery resubmission failed again. Not retried (bounded).';
        this.setStatus('FAILED', 'Recovery failed');
        return false;
      }
    }
    await this.snap(ctx, 'After recovery actions');
    this.setStatus('RUNNING', 'Recovery actions executed');
    return true;
  }

  private recordPlan(ctx: RunContext, plan: RecoveryPlan, leading: GhostHypothesis, diagnosis: GhostDiagnosis): void {
    ctx.recorder.record('RECOVERY_PROPOSED', 'AGENT', {
      planId: plan.id,
      hypothesisId: leading.id,
      hypothesisClaim: leading.claim,
      failureEventId: diagnosis.failureEventId,
      strategyName: plan.strategyName,
      predictedOutcome: plan.predictedOutcome,
      riskAssessment: plan.riskAssessment,
      selected: { strategyName: plan.selectedCandidate.strategyName, utility: plan.selectedCandidate.compositeUtilityScore, requiresHumanApproval: plan.selectedCandidate.requiresHumanApproval },
      alternatives: plan.alternativeCandidates.map((c) => ({ strategyName: c.strategyName, utility: c.compositeUtilityScore, predictedOutcome: c.predictedOutcome })),
      actions: plan.actions.map((a) => ({ id: a.id, type: a.type, target: a.target, humanLabel: a.humanLabel })),
      scoreSource: 'Candidate utilities are Person 1 planner constants (src/planner/recovery.ts), not measured.'
    });
  }

  /** Delta-debugs the observed step-2 conditions against an isolated synthetic backend. */
  private async minimize(ctx: RunContext, failure: EventRecord): Promise<void> {
    const snaps = this.chronos.extractSnapshots(ctx.recorder.events());
    const before = [...snaps].reverse().find((s) => s.order < ctx.recorder.events().findIndex((e) => e.id === failure.id));
    if (!before) return;
    const f = before.snapshot.formInputs;
    const failing: Step2Input = {
      course: f.course ?? '', cgpa: f.cgpa ?? '',
      meritScholarship: f.merit_scholarship === 'true',
      statementOfPurpose: f.merit_scholarship === 'true' ? (f.statement_of_purpose ?? '') : ''
    };
    const baseline: Step2Input = { course: 'MS AI', cgpa: '8.00', meritScholarship: false, statementOfPurpose: '' };
    const result = await withIsolatedStep2Oracle((oracle) => minimizeFailure(baseline, failing, oracle, 12));
    const payload = {
      name: 'FAILURE_MINIMIZATION', method: 'ISOLATED_REPLAY', readOnly: true, isolated: true,
      target: 'private DemoServer instance (fresh state, synthetic data)',
      outcome: result.reproducedOriginal ? 'OBSERVED' : 'NOT_REPRODUCED',
      observed: { reproducedOriginal: result.reproducedOriginal, minimalDelta: result.minimalDelta, trials: result.trials, maxTrials: result.maxTrials, exhaustedBudget: result.exhaustedBudget, inputSnapshotEventId: before.eventId },
      failureEventId: failure.id
    };
    ctx.recorder.record('PROBE_EXECUTED', 'AGENT', payload);
    this.minimizations.push(payload);
  }

  private async verify(ctx: RunContext): Promise<void> {
    this.setStatus('VERIFYING', 'Verifying backend postconditions');
    const result = await this.verifier.verifyApplicationSubmission(ctx.runId, new URL('/api/admin/applications', this.portalBase).toString(), ctx.persona.studentId);
    const shownId = await ctx.agent.applicationIdShown();
    const backendId = result.checks.find((c) => c.description.includes('persisted'))?.actualValue;
    const checks = [...result.checks, {
      description: 'Confirmation ID shown in the portal equals the backend record ID',
      passed: shownId !== null && shownId === backendId,
      actualValue: shownId,
      expectedValue: backendId
    }];
    const verified = result.verified && checks.every((c) => c.passed);
    ctx.recorder.record(verified ? 'POSTCONDITION_VERIFIED' : 'POSTCONDITION_FAILED', 'VERIFIER', { verified, checks, studentId: ctx.persona.studentId });
    await this.snap(ctx, 'Final state');
    this.outcomeSummary = verified ? `Application ${String(backendId)} verified in backend state.` : 'Postcondition verification FAILED.';
    this.setStatus(verified ? 'VERIFIED' : 'FAILED', verified ? 'Verified' : 'Verification failed');
  }

  /** After a denied/blocked submit, confirm the backend really has no application. */
  private async verifyNothingFiled(ctx: RunContext, why: string): Promise<void> {
    this.setStatus('VERIFYING', 'Verifying that nothing was filed');
    const res = await fetch(new URL('/api/admin/applications', this.portalBase), { signal: AbortSignal.timeout(5_000) });
    const data: unknown = await res.json();
    const apps = typeof data === 'object' && data !== null && Array.isArray((data as { applications?: unknown }).applications)
      ? ((data as { applications: Array<{ studentId?: unknown }> }).applications)
      : null;
    const filed = apps ? apps.some((a) => a.studentId === ctx.persona.studentId) : null;
    const passed = res.ok && filed === false;
    ctx.recorder.record(passed ? 'POSTCONDITION_VERIFIED' : 'POSTCONDITION_FAILED', 'VERIFIER', {
      verified: passed,
      checks: [{ description: `No application persisted after submission was ${why}`, passed, actualValue: filed, expectedValue: false }]
    });
    this.outcomeSummary = passed ? `Submission ${why.toLowerCase()} by the operator; verified that no application was filed.` : 'Expected no application, but backend state disagrees.';
    this.setStatus(passed ? 'COMPLETED' : 'FAILED', passed ? 'Completed (submission not performed)' : 'Verification failed');
  }

  /** Event-driven wait with an upper bound; resolves null if nothing matched in time. */
  private waitForEvent(recorder: RunRecorder, match: (e: EventRecord) => boolean, timeoutMs: number): Promise<EventRecord | null> {
    return new Promise((resolve) => {
      const off = recorder.subscribe((e) => {
        if (match(e)) { clearTimeout(timer); off(); resolve(e); }
      });
      const timer = setTimeout(() => { off(); resolve(null); }, timeoutMs);
    });
  }
}
