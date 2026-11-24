import type { EventRecord } from '../src/core/types.ts';
import { ChronosTimeline } from '../src/chronos/timeline.ts';
import type { Reconstruction, TimelineEntry } from '../src/chronos/timeline.ts';
import { redactDeep } from '../src/capture/redact.ts';

/**
 * Everything the Command Center shows about a run, derived ONLY from recorded events.
 * Live runs and replays of persisted runs therefore render identically.
 */
export interface RunView {
  runId: string | null;
  eventCount: number;
  latestEventAt: number | null;
  chainValid: boolean | null;
  timeline: TimelineEntry[];
  events: EventRecord[];
  hypotheses: Array<{ eventId: string; failureEventId: string; hypothesis: Record<string, unknown> }>;
  probes: Array<{ eventId: string; payload: Record<string, unknown> }>;
  plans: Array<{ eventId: string; payload: Record<string, unknown> }>;
  verification: Array<{ eventId: string; passed: boolean; payload: Record<string, unknown> }>;
  policyDecisions: Array<{ eventId: string; type: string; payload: Record<string, unknown> }>;
  networkEvents: Array<{ eventId: string; type: string; payload: Record<string, unknown> }>;
  reconstructions: Reconstruction[];
  approvalsResolved: Array<{ eventId: string; type: string; payload: Record<string, unknown> }>;
}

export function buildRunView(events: EventRecord[], chainValid: boolean | null): RunView {
  const chronos = new ChronosTimeline();
  const ordered = chronos.ingest(events).events;
  const safe = redactDeep(ordered);
  const failureIds = new Set<string>();
  const hypotheses: RunView['hypotheses'] = [];
  for (const e of safe) {
    if (e.type !== 'HYPOTHESIS_FORMULATED') continue;
    const h = e.payload.hypothesis;
    const failureEventId = typeof e.payload.failureEventId === 'string' ? e.payload.failureEventId : '';
    if (typeof h === 'object' && h !== null) {
      hypotheses.push({ eventId: e.id, failureEventId, hypothesis: h as Record<string, unknown> });
      if (failureEventId) failureIds.add(failureEventId);
    }
  }
  const pick = (types: string[]) => safe.filter((e) => types.includes(e.type)).map((e) => ({ eventId: e.id, type: e.type, payload: e.payload }));

  return {
    runId: safe[0]?.runId ?? null,
    eventCount: safe.length,
    latestEventAt: safe.length > 0 ? safe[safe.length - 1].timestamp : null,
    chainValid,
    timeline: chronos.toTimeline(safe),
    events: safe,
    hypotheses,
    probes: safe.filter((e) => e.type === 'PROBE_EXECUTED').map((e) => ({ eventId: e.id, payload: e.payload })),
    plans: safe.filter((e) => e.type === 'RECOVERY_PROPOSED').map((e) => ({ eventId: e.id, payload: e.payload })),
    verification: safe
      .filter((e) => e.type === 'POSTCONDITION_VERIFIED' || e.type === 'POSTCONDITION_FAILED')
      .map((e) => ({ eventId: e.id, passed: e.type === 'POSTCONDITION_VERIFIED', payload: e.payload })),
    policyDecisions: pick(['ACTION_BLOCKED', 'NETWORK_BLOCKED', 'APPROVAL_REQUESTED']).concat(
      safe.filter((e) => e.type === 'ACTION_PROPOSED' && e.payload.kind === 'POLICY_DECISION').map((e) => ({ eventId: e.id, type: e.type, payload: e.payload }))
    ),
    networkEvents: pick(['NETWORK_REQUEST', 'NETWORK_RESPONSE', 'NETWORK_BLOCKED']),
    reconstructions: [...failureIds].map((id) => chronos.reconstruct(safe, id)),
    approvalsResolved: pick(['APPROVAL_GRANTED', 'APPROVAL_DENIED'])
  };
}
