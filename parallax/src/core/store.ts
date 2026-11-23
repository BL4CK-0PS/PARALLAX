import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActorType, EventRecord, EventType } from './types.ts';

export class AuditEventStore {
  private events: EventRecord[] = [];
  private logFilePath?: string;

  constructor(logFilePath?: string) {
    this.logFilePath = logFilePath;
    if (this.logFilePath) {
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private computeHash(record: Omit<EventRecord, 'hash'>): string {
    const data = `${record.runId}|${record.timestamp}|${record.type}|${record.actor}|${JSON.stringify(record.payload)}|${record.previousHash ?? ''}`;
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Appends a new immutable event record to the audit log.
   */
  public append(runId: string, type: EventType, actor: ActorType, payload: Record<string, unknown>): EventRecord {
    const previous = this.events[this.events.length - 1];
    const previousHash = previous ? previous.hash : undefined;
    const timestamp = Date.now();
    const id = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const partial: Omit<EventRecord, 'hash'> = {
      id,
      runId,
      timestamp,
      type,
      actor,
      payload,
      previousHash
    };

    const hash = this.computeHash(partial);
    const record: EventRecord = { ...partial, hash };

    this.events.push(record);

    if (this.logFilePath) {
      fs.appendFileSync(this.logFilePath, JSON.stringify(record) + '\n', 'utf-8');
    }

    return record;
  }

  public getEvents(runId?: string): EventRecord[] {
    if (!runId) return [...this.events];
    return this.events.filter((e) => e.runId === runId);
  }

  public getLatestEvent(runId?: string): EventRecord | undefined {
    const list = this.getEvents(runId);
    return list[list.length - 1];
  }

  /**
   * Verifies the cryptographic chain integrity of the event log.
   */
  public verifyIntegrity(runId?: string): boolean {
    const list = this.getEvents(runId);
    for (let i = 0; i < list.length; i++) {
      const curr = list[i];
      if (i > 0) {
        const prev = list[i - 1];
        if (curr.previousHash !== prev.hash) return false;
      }
      const calculated = this.computeHash(curr);
      if (calculated !== curr.hash) return false;
    }
    return true;
  }
}
