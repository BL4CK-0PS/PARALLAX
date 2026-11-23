import type { Action, EventRecord, StateSnapshot } from '../core/types.ts';
import { DeterministicPolicyGuard } from '../policy/guard.ts';

export interface BrowserObserverOptions {
  allowedHosts: string[];
  headless?: boolean;
}

/**
 * Playwright Browser Capture & CDP Network Instrumentation.
 * Observes pages, intercepts network requests against the strict allowlist,
 * and extracts semantic accessibility snapshots.
 */
export class PlaywrightBrowserObserver {
  private allowedHosts: string[];
  private guard: DeterministicPolicyGuard;
  private browser: any = null;
  private page: any = null;

  constructor(options: BrowserObserverOptions) {
    this.allowedHosts = options.allowedHosts;
    this.guard = new DeterministicPolicyGuard({ allowedHosts: options.allowedHosts });
  }

  /**
   * Initializes the browser session with CDP route interception.
   */
  public async launch(headless = true): Promise<boolean> {
    try {
      // Dynamic import so it does not fail if playwright is not yet installed
      const { chromium } = await import('playwright');
      this.browser = await chromium.launch({ headless });
      const context = await this.browser.newContext();

      // Enforce strict CDP Network Route Interception
      await context.route('**/*', (route: any) => {
        const url = route.request().url();
        const evaluation = this.guard.evaluateNetworkRequest(url);

        if (!evaluation.allowed) {
          console.warn(`[CDP GUARD INTERCEPT] Blocked request to: ${url}`);
          route.abort('blockedbyclient');
          return;
        }

        route.continue();
      });

      this.page = await context.newPage();
      return true;
    } catch {
      // Graceful fallback to HTTP driver if Playwright is not installed in the environment
      return false;
    }
  }

  /**
   * Captures semantic ARIA accessibility snapshot of the current page.
   */
  public async captureSnapshot(step = 1): Promise<StateSnapshot> {
    if (!this.page) {
      return {
        step,
        url: 'http://127.0.0.1:3000',
        title: 'Graduate Admissions Portal',
        formInputs: {},
        timestamp: Date.now(),
        isHealthy: true
      };
    }

    const url = this.page.url();
    const title = await this.page.title();
    let ariaSnapshot = '';

    try {
      ariaSnapshot = await this.page.ariaSnapshot();
    } catch {
      // fallback
    }

    return {
      step,
      url,
      title,
      ariaSnapshot,
      formInputs: {},
      timestamp: Date.now(),
      isHealthy: true
    };
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
  }
}
