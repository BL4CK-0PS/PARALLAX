import { chromium } from 'playwright';
import type { Browser, BrowserContext, ElementHandle, Page, Request, Response, Route } from 'playwright';
import type { EventRecord, StateSnapshot } from '../core/types.ts';
import type { DeterministicPolicyGuard } from '../policy/guard.ts';
import { hashSnapshot } from '../chronos/stateHash.ts';
import type { EventSink } from './recorder.ts';
import { REDACTED, redactDeep, redactText, redactUrl } from './redact.ts';

export type BrowserStatus = 'NOT_STARTED' | 'LAUNCHING' | 'CONNECTED' | 'DISCONNECTED' | 'CLOSED';

export interface BrowserCaptureOptions {
  /** Person 1's guard. Its allowlist decides every request; capture never keeps its own list. */
  guard: DeterministicPolicyGuard;
  sink: EventSink;
  headless?: boolean;
  slowMoMs?: number;
  /** Origin of the target application; HTTP errors from it are recorded as failures. */
  appOrigin: string;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
}

export interface CapturedState {
  snapshot: StateSnapshot;
  stateHash: string;
  event: EventRecord;
}

/** Identifies how the accessibility tree was obtained (recorded with every snapshot). */
export const ARIA_SNAPSHOT_SOURCE = 'playwright:page.ariaSnapshot({ mode: "ai" })';

const SECRET_AUTOCOMPLETE = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp'];

/**
 * Playwright observation layer: one browser, one context, one page per capture instance.
 *
 * - All requests pass through context.route(), where Person 1's guard decides allow/abort.
 *   Allowed requests are recorded as NETWORK_REQUEST, refused ones as NETWORK_BLOCKED.
 * - Responses, failed requests, navigations, console errors and page errors are recorded.
 * - Bodies, headers and cookies are never recorded. The only body read is the `error` field
 *   of a failing JSON response from the target app, which is redacted and truncated.
 *
 * Browser actions are NOT exposed here: they go through GuardedExecutor (executor.ts),
 * which is the only caller of pageForExecutor().
 */
export class BrowserCapture {
  private readonly options: BrowserCaptureOptions;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private statusValue: BrowserStatus = 'NOT_STARTED';
  private closing = false;
  private blockedRequests = new WeakSet<Request>();
  private pending = new Set<Promise<void>>();
  private lastAppStatus?: number;
  private failureSinceSnapshot = false;
  private snapshotCount = 0;

  constructor(options: BrowserCaptureOptions) {
    this.options = options;
  }

  public get status(): BrowserStatus {
    return this.statusValue;
  }

  public get lastAppHttpStatus(): number | undefined {
    return this.lastAppStatus;
  }

  /** Launches Chromium. Refuses a second launch so there is never more than one browser. */
  public async launch(): Promise<void> {
    if (this.statusValue !== 'NOT_STARTED') {
      throw new Error(`BrowserCapture.launch() called in state ${this.statusValue}; one browser per capture.`);
    }
    this.statusValue = 'LAUNCHING';
    try {
      this.browser = await chromium.launch({
        headless: this.options.headless ?? true,
        slowMo: this.options.slowMoMs
      });
      this.browser.on('disconnected', () => {
        if (!this.closing) {
          this.options.sink.record('FAILURE_DETECTED', 'BROWSER', {
            kind: 'BROWSER_DISCONNECTED',
            source: 'playwright:browser.disconnected',
            error: 'Browser process disconnected unexpectedly.'
          });
        }
        this.statusValue = this.closing ? 'CLOSED' : 'DISCONNECTED';
      });

      // Deterministic, isolated context: fixed viewport, locale and clock zone, no service workers
      // (a service worker could otherwise issue requests that bypass context.route()).
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 860 },
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
        acceptDownloads: false
      });
      this.context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs ?? 15_000);
      this.context.setDefaultTimeout(this.options.actionTimeoutMs ?? 10_000);
      await this.context.route('**/*', (route) => this.onRoute(route));

      this.page = await this.context.newPage();
      this.attachPageListeners(this.page);
      this.statusValue = 'CONNECTED';
    } catch (err) {
      this.statusValue = 'DISCONNECTED';
      await this.close();
      throw new Error(`Chromium launch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** For GuardedExecutor and read-only GHOST probes only. Throws if the browser is not usable. */
  public pageForExecutor(): Page {
    if (!this.page || this.statusValue !== 'CONNECTED' || this.page.isClosed()) {
      throw new Error(`Browser page unavailable (status ${this.statusValue}).`);
    }
    return this.page;
  }

  /** Waits for in-flight evidence writes (e.g. reading an error body) to land in the store. */
  public async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  // ---------------------------------------------------------------- network

  private async onRoute(route: Route): Promise<void> {
    const request = route.request();
    const url = request.url();
    let allowed = false;
    let reason = 'Guard evaluation failed; request aborted (fail-closed).';
    try {
      const verdict = this.options.guard.evaluateNetworkRequest(url);
      allowed = verdict.allowed;
      reason = verdict.reason;
    } catch (err) {
      reason = `Guard threw while evaluating request; aborted (fail-closed): ${String(err)}`;
    }

    if (!allowed) {
      this.blockedRequests.add(request);
      this.options.sink.record('NETWORK_BLOCKED', 'GUARD', {
        url: redactUrl(url),
        host: safeHost(url),
        method: request.method(),
        resourceType: request.resourceType(),
        isNavigation: request.isNavigationRequest(),
        reason,
        violatedRule: 'RULE_NETWORK_ALLOWLIST',
        layer: 'BROWSER_NETWORK',
        source: 'playwright:context.route'
      });
      await route.abort('blockedbyclient').catch((err: unknown) => {
        console.error('[PARALLAX] route.abort failed:', err);
      });
      return;
    }

    this.options.sink.record('NETWORK_REQUEST', 'BROWSER', {
      url: redactUrl(url),
      method: request.method(),
      resourceType: request.resourceType(),
      isNavigation: request.isNavigationRequest(),
      source: 'playwright:context.route'
    });
    await route.continue().catch((err: unknown) => {
      // Happens when the page navigates away mid-request; the requestfailed handler records it.
      console.error('[PARALLAX] route.continue failed:', err instanceof Error ? err.message : err);
    });
  }

  private isAppUrl(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.options.appOrigin).origin;
    } catch {
      return false;
    }
  }

  private markFailure(isFailure: boolean): void {
    if (isFailure) this.failureSinceSnapshot = true;
  }

  private onResponse(response: Response): void {
    const request = response.request();
    const url = request.url();
    const status = response.status();
    const type = request.resourceType();
    const isApi = this.isAppUrl(url) && (type === 'fetch' || type === 'xhr' || type === 'document');

    const responseEvent = this.options.sink.record('NETWORK_RESPONSE', 'TARGET_APP', {
      url: redactUrl(url),
      method: request.method(),
      resourceType: type,
      status,
      ok: response.ok(),
      source: 'playwright:page.on(response)'
    });

    if (!isApi) return;
    this.lastAppStatus = status;
    if (status < 400) return;

    this.markFailure(true);
    const task = this.readErrorBody(response).then((errorText) => {
      this.options.sink.record('FAILURE_DETECTED', 'TARGET_APP', {
        kind: 'HTTP_ERROR',
        url: redactUrl(url),
        path: safePath(url),
        method: request.method(),
        status,
        error: errorText,
        responseEventId: responseEvent.id,
        source: 'playwright:page.on(response)'
      });
    });
    this.track(task);
  }

  /** Reads only the `error` string of a JSON error body. Nothing else from the body is kept. */
  private async readErrorBody(response: Response): Promise<string | null> {
    try {
      const contentType = response.headers()['content-type'] ?? '';
      if (!contentType.includes('application/json')) return null;
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        const value = (body as { error: unknown }).error;
        return typeof value === 'string' ? redactText(value).slice(0, 300) : null;
      }
      return null;
    } catch (err) {
      return `(error body unreadable: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  private track(task: Promise<void>): void {
    const wrapped = task.catch((err: unknown) => {
      console.error('[PARALLAX] evidence task failed:', err);
    });
    this.pending.add(wrapped);
    void wrapped.finally(() => this.pending.delete(wrapped));
  }

  private attachPageListeners(page: Page): void {
    page.on('response', (response) => this.onResponse(response));

    page.on('requestfailed', (request) => {
      if (this.blockedRequests.has(request)) return; // already recorded as NETWORK_BLOCKED
      this.markFailure(this.isAppUrl(request.url()));
      this.options.sink.record('FAILURE_DETECTED', 'BROWSER', {
        kind: 'REQUEST_FAILED',
        url: redactUrl(request.url()),
        method: request.method(),
        resourceType: request.resourceType(),
        error: request.failure()?.errorText ?? 'unknown network failure',
        source: 'playwright:page.on(requestfailed)'
      });
    });

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.options.sink.record('BROWSER_NAVIGATED', 'BROWSER', {
        url: redactUrl(frame.url()),
        source: 'playwright:page.on(framenavigated)'
      });
    });

    page.on('console', (message) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      this.options.sink.record('BROWSER_CONSOLE', 'BROWSER', {
        level: message.type(),
        text: redactText(message.text()).slice(0, 500),
        location: redactUrl(message.location().url),
        source: 'playwright:page.on(console)'
      });
    });

    page.on('pageerror', (error) => {
      this.markFailure(true);
      this.options.sink.record('BROWSER_CONSOLE', 'BROWSER', {
        level: 'pageerror',
        text: redactText(error.message).slice(0, 500),
        source: 'playwright:page.on(pageerror)'
      });
    });

    page.on('crash', () => {
      this.markFailure(true);
      this.options.sink.record('FAILURE_DETECTED', 'BROWSER', {
        kind: 'PAGE_CRASH',
        error: 'Renderer process crashed.',
        source: 'playwright:page.on(crash)'
      });
    });
  }

  // ---------------------------------------------------------------- snapshots

  /**
   * Captures URL, title, AI-mode accessibility tree and sanitised form state, and records
   * it as a DOM_OBSERVED event with a state hash. Health is derived from observations made
   * since the previous snapshot, never asserted by the caller.
   */
  public async captureSnapshot(label: string): Promise<CapturedState> {
    const page = this.pageForExecutor();
    await this.flush();

    const [url, title] = [page.url(), await page.title()];
    let ariaSnapshot: string | undefined;
    let ariaError: string | undefined;
    try {
      ariaSnapshot = sanitizeAriaSnapshot(await page.ariaSnapshot({ mode: 'ai', timeout: 5_000 }), await secretLabels(page));
    } catch (err) {
      ariaError = err instanceof Error ? err.message : String(err);
    }

    const pageState = await page.evaluate(readPageStateInPage, SECRET_AUTOCOMPLETE);
    const healthy = !this.failureSinceSnapshot && (this.lastAppStatus === undefined || this.lastAppStatus < 400);

    const raw: StateSnapshot = {
      step: pageState.step,
      url,
      title,
      ariaSnapshot,
      formInputs: pageState.formInputs,
      lastHttpStatusCode: this.lastAppStatus,
      timestamp: Date.now(),
      isHealthy: healthy
    };
    const snapshot = redactDeep(raw);
    const stateHash = hashSnapshot(snapshot);
    this.snapshotCount += 1;

    const event = this.options.sink.record('DOM_OBSERVED', 'BROWSER', {
      kind: 'STATE_SNAPSHOT',
      label,
      sequence: this.snapshotCount,
      snapshot,
      stateHash,
      alerts: pageState.alerts.map((a) => redactText(a)),
      ariaError,
      source: ARIA_SNAPSHOT_SOURCE
    });
    this.failureSinceSnapshot = false;
    return { snapshot, stateHash, event };
  }

  /** PNG/JPEG of the current viewport for the Command Center. Not stored as evidence. */
  public async screenshot(): Promise<Buffer> {
    return this.pageForExecutor().screenshot({ type: 'jpeg', quality: 60 });
  }

  /** Image of a single element, shown to the operator in the approval panel. */
  public async elementScreenshot(handle: ElementHandle<Element>): Promise<string | undefined> {
    try {
      const png = await handle.screenshot({ type: 'png', timeout: 3_000 });
      return `data:image/png;base64,${png.toString('base64')}`;
    } catch (err) {
      console.error('[PARALLAX] element screenshot unavailable:', err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  public async close(): Promise<void> {
    this.closing = true;
    try {
      await this.flush();
      if (this.context) await this.context.close().catch((err: unknown) => console.error('[PARALLAX] context close:', err));
      if (this.browser) await this.browser.close().catch((err: unknown) => console.error('[PARALLAX] browser close:', err));
    } finally {
      this.page = undefined;
      this.context = undefined;
      this.browser = undefined;
      this.statusValue = 'CLOSED';
    }
  }
}

/** Names of inputs whose values must never appear in the accessibility text. */
async function secretLabels(page: Page): Promise<string[]> {
  return page.evaluate((secretTokens) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('input'))) {
      const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
      if (el.type === 'password' || secretTokens.some((t) => ac.includes(t))) {
        const label = el.labels && el.labels.length > 0 ? el.labels[0].innerText : el.getAttribute('aria-label');
        if (label) out.push(label.trim());
      }
    }
    return out;
  }, SECRET_AUTOCOMPLETE);
}

/**
 * Removes typed values of secret textboxes from the AI-mode snapshot
 * (`- textbox "Password" [ref=e4]: hunter2` → `...: [REDACTED]`) and token patterns everywhere.
 */
export function sanitizeAriaSnapshot(text: string, secretFieldLabels: string[]): string {
  const sensitive = /password|passcode|otp|one-time|token|secret|cvv|card number/i;
  const lines = text.split('\n').map((line) => {
    const m = /^(\s*-\s*textbox\s+"([^"]*)"[^:]*):\s.*$/.exec(line);
    if (m && (sensitive.test(m[2]) || secretFieldLabels.includes(m[2]))) return `${m[1]}: ${REDACTED}`;
    return line;
  });
  return redactText(lines.join('\n'));
}

/** Runs in the page: reads workflow step, visible alerts and sanitised form values. */
function readPageStateInPage(secretTokens: string[]): { step: number; formInputs: Record<string, string>; alerts: string[] } {
  const stepAttr = document.body.getAttribute('data-step');
  const step = stepAttr !== null && /^\d+$/.test(stepAttr) ? Number(stepAttr) : 0;
  const formInputs: Record<string, string> = {};
  const fields = Array.from(document.querySelectorAll('input, select, textarea'));
  for (const el of fields) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
    const key = el.name || el.id;
    if (!key) continue;
    if (el instanceof HTMLInputElement) {
      const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
      if (el.type === 'password' || el.type === 'hidden' || secretTokens.some((t) => ac.includes(t))) {
        formInputs[key] = el.value ? '[REDACTED]' : '';
        continue;
      }
      if (el.type === 'checkbox' || el.type === 'radio') {
        formInputs[key] = String(el.checked);
        continue;
      }
      if (el.type === 'file') {
        formInputs[key] = el.files && el.files.length > 0 ? `[file: ${el.files[0].name}]` : '';
        continue;
      }
    }
    const value = el.value;
    formInputs[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
    .map((a) => (a instanceof HTMLElement ? a.innerText.trim() : ''))
    .filter((t) => t.length > 0);
  return { step, formInputs, alerts };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable)';
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '(unparseable)';
  }
}
