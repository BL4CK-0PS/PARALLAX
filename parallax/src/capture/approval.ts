import type { Action, DomFacts, PolicyDecision } from '../core/types.ts';
import { redactDeep } from './redact.ts';

export interface ApprovalRequest {
  id: string;
  runId: string;
  actionId: string;
  actionType: Action['type'];
  target: string;
  /** The agent's own description of the action. Untrusted; displayed for comparison only. */
  agentLabel: string;
  /** Facts read from the live element. This is what the operator is approving. */
  dom?: DomFacts;
  factsFingerprint: string;
  guardStatus: PolicyDecision['status'];
  guardReason: string;
  violatedRule?: string;
  riskLevel: PolicyDecision['riskLevel'];
  elementScreenshot?: string;
  requestedAt: number;
}

export interface ApprovalResolution {
  approved: boolean;
  operator: string;
  notes?: string;
  resolvedAt: number;
}

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (resolution: ApprovalResolution) => void;
  timer?: NodeJS.Timeout;
}

/**
 * Holds actions the guard returned REQUIRE_APPROVAL for, until a human decides.
 * Resolution is single-use: an approval id can be decided once, and only while pending.
 * Unresolved requests are denied on timeout or when the run is aborted (fail closed).
 */
export class ApprovalGate {
  private pending = new Map<string, PendingEntry>();
  private history: Array<{ request: ApprovalRequest; resolution: ApprovalResolution }> = [];
  private listeners = new Set<() => void>();
  private counter = 0;
  private readonly timeoutMs: number;

  constructor(timeoutMs = 10 * 60_000) {
    this.timeoutMs = timeoutMs;
  }

  public request(input: Omit<ApprovalRequest, 'id' | 'requestedAt'>): { id: string; decision: Promise<ApprovalResolution> } {
    this.counter += 1;
    const id = `apr_${Date.now()}_${this.counter}`;
    const request: ApprovalRequest = redactDeep({ ...input, id, requestedAt: Date.now() });
    const decision = new Promise<ApprovalResolution>((resolve) => {
      const entry: PendingEntry = { request, resolve };
      if (this.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.resolve(id, false, 'system:timeout', `No decision within ${Math.round(this.timeoutMs / 1000)}s; denied (fail-closed).`);
        }, this.timeoutMs);
      }
      this.pending.set(id, entry);
    });
    this.emit();
    return { id, decision };
  }

  /** Returns false when the id is unknown or already decided. */
  public resolve(id: string, approved: boolean, operator: string, notes?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const resolution: ApprovalResolution = { approved, operator, notes, resolvedAt: Date.now() };
    this.history.push({ request: entry.request, resolution });
    entry.resolve(resolution);
    this.emit();
    return true;
  }

  public denyAll(reason: string): void {
    for (const id of [...this.pending.keys()]) this.resolve(id, false, 'system:abort', reason);
  }

  public list(): ApprovalRequest[] {
    return [...this.pending.values()].map((e) => e.request);
  }

  public resolved(): Array<{ request: ApprovalRequest; resolution: ApprovalResolution }> {
    return [...this.history];
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error('[PARALLAX] approval listener failed:', err);
      }
    }
  }
}
