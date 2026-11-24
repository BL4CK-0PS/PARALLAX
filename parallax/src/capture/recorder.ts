import { AuditEventStore } from '../core/store.ts';
import type { ActorType, EventRecord, EventType } from '../core/types.ts';
import { redactDeep } from './redact.ts';

export type EventListener = (event: EventRecord) => void;

/** Anything that can record an event for the current run. */
export interface EventSink {
  readonly runId: string;
  record(type: EventType, actor: ActorType, payload: Record<string, unknown>): EventRecord;
}

/**
 * The only path by which P2 code writes evidence. Wraps Person 1's AuditEventStore:
 * - redacts every payload before it reaches the store (and therefore the JSONL file);
 * - uses one store per run, because the store's hash chain spans every event it holds,
 *   so a shared store makes verifyIntegrity(runId) fail for every run after the first;
 * - notifies listeners (the Command Center's SSE stream).
 */
export class RunRecorder implements EventSink {
  public readonly runId: string;
  public readonly store: AuditEventStore;
  private listeners = new Set<EventListener>();

  constructor(runId: string, baseDir?: string) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) {
      throw new Error(`Invalid run id '${runId}': only letters, digits, '_' and '-' are allowed.`);
    }
    this.runId = runId;
    this.store = new AuditEventStore(baseDir);
  }

  public record(type: EventType, actor: ActorType, payload: Record<string, unknown>): EventRecord {
    const event = this.store.append(this.runId, type, actor, redactDeep(payload));
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // A broken UI listener must not stop evidence collection; report it and continue.
        console.error('[PARALLAX] event listener failed:', err);
      }
    }
    return event;
  }

  public events(): EventRecord[] {
    return this.store.getEvents(this.runId);
  }

  public subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
