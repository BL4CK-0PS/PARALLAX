import type { EventRecord, StateDiff, StateSnapshot } from '../core/types.ts';

export class ChronosTimeline {
  private snapshots: Map<string, StateSnapshot[]> = new Map();

  public recordSnapshot(runId: string, snapshot: StateSnapshot): void {
    const list = this.snapshots.get(runId) ?? [];
    list.push(snapshot);
    this.snapshots.set(runId, list);
  }

  public getSnapshots(runId: string): StateSnapshot[] {
    return this.snapshots.get(runId) ?? [];
  }

  /**
   * Identifies the Last-Good Known State in a run before an error or failure occurred.
   */
  public getLastGoodState(runId: string): StateSnapshot | undefined {
    const list = this.getSnapshots(runId);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].isHealthy) {
        return list[i];
      }
    }
    return undefined;
  }

  /**
   * Computes the discrete diff between two consecutive state snapshots.
   */
  public diff(before: StateSnapshot, after: StateSnapshot): StateDiff {
    const inputsModified: Record<string, { from: string; to: string }> = {};

    const allKeys = new Set([...Object.keys(before.formInputs), ...Object.keys(after.formInputs)]);
    for (const key of allKeys) {
      const fromVal = before.formInputs[key] ?? '';
      const toVal = after.formInputs[key] ?? '';
      if (fromVal !== toVal) {
        inputsModified[key] = { from: fromVal, to: toVal };
      }
    }

    return {
      stepFrom: before.step,
      stepTo: after.step,
      urlChanged: before.url !== after.url,
      fromUrl: before.url,
      toUrl: after.url,
      inputsModified,
      sessionStatusChanged: before.activeSessionId !== after.activeSessionId,
      healthChanged: before.isHealthy !== after.isHealthy
    };
  }

  /**
   * Builds a human-readable timeline presentation from stored events.
   */
  public formatTimeline(events: EventRecord[]): Array<{
    time: string;
    actor: string;
    type: string;
    summary: string;
    isAlert: boolean;
  }> {
    return events.map((e) => {
      const dateStr = new Date(e.timestamp).toISOString().split('T')[1].replace('Z', '');
      const isAlert =
        e.type === 'NETWORK_BLOCKED' ||
        e.type === 'FAILURE_DETECTED' ||
        e.type === 'APPROVAL_REQUESTED';

      let summary = JSON.stringify(e.payload);
      if (e.type === 'NETWORK_BLOCKED') {
        summary = `🛑 BLOCKED: ${String(e.payload.reason)}`;
      } else if (e.type === 'APPROVAL_REQUESTED') {
        summary = `⚠️ APPROVAL GATE: Action '${String(e.payload.humanLabel)}' requires confirmation`;
      } else if (e.type === 'ACTION_DISPATCHED') {
        summary = `▶ Executed: ${String(e.payload.humanLabel)} (${String(e.payload.target)})`;
      }

      return {
        time: dateStr,
        actor: e.actor,
        type: e.type,
        summary,
        isAlert
      };
    });
  }
}
