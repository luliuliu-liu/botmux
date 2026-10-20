/** Fail-closed conversion between PostgreSQL rows and upstream v3 events. */

import type { StoredEvent, V3Event } from '../../event-contract.js';
import type { WorkflowEventRecord } from './event-store.js';

// `satisfies Record<...>` intentionally makes an upstream V3Event addition a
// compile error here. A rebase must explicitly decide how the new event is
// projected before PostgreSQL recovery can accept it.
const V3_EVENT_TYPES = {
  edgeResolved: true,
  gateDispatched: true,
  gateResolved: true,
  hostEffectIntent: true,
  hostEffectRetryDeferred: true,
  hostEffectUncertain: true,
  hostInputPrepared: true,
  loopIterationDecision: true,
  loopIterationGranted: true,
  loopIterationStarted: true,
  loopStarted: true,
  nodeAttemptDrained: true,
  nodeBlocked: true,
  nodeCancelled: true,
  nodeDispatched: true,
  nodeFailed: true,
  nodeInstanceSuperseded: true,
  nodeRetryRequested: true,
  nodeRevisitRequested: true,
  nodeSessionReady: true,
  nodeSkipped: true,
  nodeSucceeded: true,
  nodeWorkerFenceArmed: true,
  revisitBudgetGranted: true,
  runBlocked: true,
  runCancelRequested: true,
  runCancelled: true,
  runFailed: true,
  runStarted: true,
  runSucceeded: true,
} as const satisfies Record<V3Event['type'], true>;

export function isV3EventType(value: string): value is V3Event['type'] {
  return Object.hasOwn(V3_EVENT_TYPES, value);
}

export function decodeStoredEvents(records: readonly WorkflowEventRecord[]): StoredEvent[] {
  return records.map((record, index) => {
    const expectedSequence = index + 1;
    if (record.sequence !== expectedSequence) {
      throw new Error(
        `workflow postgres codec: non-contiguous event sequence for ${record.runId}: ` +
        `expected ${expectedSequence}, got ${record.sequence}`,
      );
    }
    if (!isV3EventType(record.eventType)) {
      throw new Error(`workflow postgres codec: unsupported v3 event type: ${record.eventType}`);
    }
    if (
      Object.hasOwn(record.payload, 'type') ||
      Object.hasOwn(record.payload, 'ts')
    ) {
      throw new Error('workflow postgres codec: event payload shadows envelope fields');
    }
    const ts = Date.parse(record.occurredAt);
    if (!Number.isFinite(ts)) {
      throw new Error(`workflow postgres codec: invalid event timestamp: ${record.occurredAt}`);
    }
    return {
      ...record.payload,
      type: record.eventType,
      ts,
    } as StoredEvent;
  });
}
