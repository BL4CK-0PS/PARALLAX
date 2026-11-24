import type { Action } from '../core/types.ts';
import type { BrowserCapture } from './browser.ts';
import type { ExecutionOutcome, GuardedExecutor } from './executor.ts';
import type { EventSink } from './recorder.ts';
import { redactText } from './redact.ts';

export interface Persona {
  name: string;
  email: string;
  studentId: string;
  applicationRef: string;
  course: string;
  cgpa: string;
  previousInstitution: string;
  meritScholarship: boolean;
  supportingDocument: string;
}

export interface StepResult {
  outcome: ExecutionOutcome;
  /** Workflow step shown by the portal after the action settled. */
  stepAfter: number;
  /** True if the portal displayed an error banner after the action. */
  errorShown: boolean;
}

export interface UntrustedContent {
  selector: string;
  text: string;
  instructionLike: boolean;
}

/**
 * Deterministic agent for the synthetic portal. It has no model: its next action comes from
 * a fixed workflow and persona data, never from page text. Every action goes through the
 * GuardedExecutor; this class never touches the page except for read-only state queries.
 */
export class PortalAgent {
  private readonly executor: GuardedExecutor;
  private readonly capture: BrowserCapture;
  private readonly sink: EventSink;
  private seq = 0;

  constructor(opts: { executor: GuardedExecutor; capture: BrowserCapture; sink: EventSink }) {
    this.executor = opts.executor;
    this.capture = opts.capture;
    this.sink = opts.sink;
  }

  private nextId(tag: string): string {
    this.seq += 1;
    return `act_${this.sink.runId}_${String(this.seq).padStart(3, '0')}_${tag}`;
  }

  public async open(url: string): Promise<ExecutionOutcome> {
    const outcome = await this.executor.execute({ id: this.nextId('open'), type: 'NAVIGATE', target: 'browser', value: url, humanLabel: 'Open admissions portal' });
    if (outcome.status === 'EXECUTED') await this.waitSettled();
    return outcome;
  }

  public async fillStep1(p: Persona): Promise<StepResult> {
    for (const [sel, value, label] of [
      ['#student-name', p.name, 'Fill full name'],
      ['#student-email', p.email, 'Fill email'],
      ['#student-id', p.studentId, 'Fill student ID'],
      ['#application-ref', p.applicationRef, 'Fill application reference']
    ] as const) {
      const o = await this.type(sel, value, label);
      if (o.status !== 'EXECUTED') return this.result(o);
    }
    return this.click('#btn-next-1', 'Save and continue to step 2');
  }

  public async fillStep2(p: Persona, opts: { includeDocument: boolean }): Promise<ExecutionOutcome | null> {
    const select = await this.executor.execute({ id: this.nextId('course'), type: 'SELECT', target: '#course', value: p.course, humanLabel: 'Select degree programme' });
    if (select.status !== 'EXECUTED') return select;
    for (const [sel, value, label] of [
      ['#cgpa', p.cgpa, 'Fill CGPA'],
      ['#previous-institution', p.previousInstitution, 'Fill previous institution']
    ] as const) {
      const o = await this.type(sel, value, label);
      if (o.status !== 'EXECUTED') return o;
    }
    if (p.meritScholarship) {
      const merit = await this.executor.execute({ id: this.nextId('merit'), type: 'CLICK', target: '#merit-scholarship', humanLabel: 'Select merit scholarship' });
      if (merit.status !== 'EXECUTED') return merit;
      if (opts.includeDocument && p.supportingDocument) {
        const doc = await this.type('textarea#statement_of_purpose', p.supportingDocument, 'Provide supporting document text');
        if (doc.status !== 'EXECUTED') return doc;
      }
    }
    return null;
  }

  public continueToReview(): Promise<StepResult> {
    return this.click('#btn-next-2', 'Continue to review');
  }

  public revealHiddenText(): Promise<StepResult> {
    return this.click('#reveal-hidden', 'Reveal hidden draft comment (demo toggle)');
  }

  public attest(): Promise<StepResult> {
    return this.click('#attestation', 'Tick attestation checkbox');
  }

  public submitApplication(): Promise<StepResult> {
    return this.submitLike('button#submit-application', 'Submit application');
  }

  /**
   * Reads untrusted content from the page as DATA and records it. Nothing returned here is
   * ever used to choose an action by this agent.
   */
  public async scanUntrustedContent(instructionPattern: RegExp): Promise<UntrustedContent[]> {
    const page = this.capture.pageForExecutor();
    const found = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-untrusted]')).map((el) => ({
        selector: el.id ? `#${el.id}` : `[data-untrusted="${el.getAttribute('data-untrusted') ?? ''}"]`,
        text: (el.textContent ?? '').trim().slice(0, 500)
      }))
    );
    const items = found.map((f) => ({ ...f, text: redactText(f.text), instructionLike: instructionPattern.test(f.text) }));
    for (const item of items) {
      this.sink.record('DOM_OBSERVED', 'BROWSER', {
        kind: 'UNTRUSTED_CONTENT',
        selector: item.selector,
        text: item.text,
        instructionLike: item.instructionLike,
        treatedAs: 'DATA',
        note: 'Untrusted page content is recorded as evidence only; it is never an instruction to the agent.',
        source: 'playwright:page.evaluate([data-untrusted])'
      });
    }
    return items;
  }

  /**
   * Runs an arbitrary proposal through the executor. Used for (a) recovery-plan actions and
   * (b) clearly labelled simulations of what a hijacked model would propose.
   */
  public async propose(action: Omit<Action, 'id' | 'isStateChanging' | 'dom'> & { isStateChanging?: boolean; tag: string }): Promise<StepResult> {
    const { tag, ...rest } = action;
    const outcome = await this.executor.execute({ id: this.nextId(tag), ...rest });
    if (outcome.status === 'EXECUTED') await this.waitSettled();
    return this.result(outcome);
  }

  /**
   * Maps an abstract planner action onto a concrete portal element. REAUTHENTICATE becomes a
   * click on the portal's own "Sign in again" control, so recovery uses authorised UI only.
   * Returns null when the plan's target does not exist on the current page.
   */
  public async materialize(planAction: Action): Promise<Action | null> {
    const page = this.capture.pageForExecutor();
    const mapped: Action = planAction.type === 'REAUTHENTICATE'
      ? { ...planAction, type: 'CLICK', target: '#reauth-button', humanLabel: `${planAction.humanLabel} (portal "Sign in again")`, dom: undefined }
      : { ...planAction, dom: undefined };
    if (mapped.type === 'NAVIGATE') return mapped;
    const count = await page.locator(mapped.target).count();
    if (count !== 1) return null;
    const visible = await page.locator(mapped.target).isVisible();
    return visible ? mapped : null;
  }

  public async currentStep(): Promise<number> {
    const raw = await this.capture.pageForExecutor().evaluate(() => document.body.getAttribute('data-step'));
    return raw !== null && /^\d+$/.test(raw) ? Number(raw) : 0;
  }

  public async applicationIdShown(): Promise<string | null> {
    const loc = this.capture.pageForExecutor().locator('#application-id');
    if ((await loc.count()) === 0) return null;
    return loc.getAttribute('data-application-id');
  }

  private type(selector: string, value: string, label: string): Promise<ExecutionOutcome> {
    return this.executor.execute({ id: this.nextId('type'), type: 'TYPE', target: selector, value, humanLabel: label });
  }

  private async click(selector: string, label: string): Promise<StepResult> {
    const outcome = await this.executor.execute({ id: this.nextId('click'), type: 'CLICK', target: selector, humanLabel: label });
    if (outcome.status === 'EXECUTED') await this.waitSettled();
    return this.result(outcome);
  }

  private async submitLike(selector: string, label: string): Promise<StepResult> {
    const outcome = await this.executor.execute({ id: this.nextId('submit'), type: 'SUBMIT', target: selector, humanLabel: label, isStateChanging: true });
    if (outcome.status === 'EXECUTED') await this.waitSettled();
    return this.result(outcome);
  }

  /** Synchronises on the portal's own busy flag (set synchronously by every handler), not on sleeps. */
  private async waitSettled(): Promise<void> {
    const page = this.capture.pageForExecutor();
    await page.waitForFunction(() => document.readyState !== 'loading' && document.body.dataset.busy !== 'true', undefined, { timeout: 15_000 });
    await this.capture.flush();
  }

  private async result(outcome: ExecutionOutcome): Promise<StepResult> {
    const page = this.capture.pageForExecutor();
    const stepAfter = await this.currentStep();
    const errorShown = (await page.locator('#alert-box .banner.error').count()) > 0;
    return { outcome, stepAfter, errorShown };
  }
}
