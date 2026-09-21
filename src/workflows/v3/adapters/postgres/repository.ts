/**
 * PostgreSQL scheduling repository for the local controller integration.
 *
 * This file is the transaction boundary between upstream Workflow v3 events
 * and local durable scheduling state. It does not alter or replace Botmux's
 * native file-journal runtime.
 */

import type { V3Event } from '../../event-contract.js';
import {
  PostgresWorkflowAttemptStore,
  reserveAttemptInTransaction,
  type AttemptLease,
  type ReserveWorkflowAttempt,
} from './attempt-store.js';
import {
  appendWorkflowEventInTransaction,
  PostgresWorkflowEventStore,
  type PostgresPool,
  type WorkflowEventRecord,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  withPostgresTransaction,
} from './event-store.js';

export interface DurableDispatch extends ReserveWorkflowAttempt {
  readonly event: Extract<V3Event, { type: 'nodeDispatched' }>;
}

function runProjection(event: V3Event): {
  status?: WorkflowRunStatus;
  terminal?: boolean;
} {
  switch (event.type) {
    case 'runStarted': return { status: 'running' };
    case 'runSucceeded': return { status: 'succeeded', terminal: true };
    case 'runFailed': return { status: 'failed', terminal: true };
    case 'runBlocked': return { status: 'blocked' };
    case 'runCancelRequested': return { status: 'running' };
    case 'runCancelled': return { status: 'cancelled', terminal: true };
    case 'gateDispatched': return { status: 'waiting' };
    case 'gateResolved': return { status: 'running' };
    default: return {};
  }
}

function eventPayload(event: V3Event): Record<string, unknown> {
  const { type: _type, ...payload } = event;
  return payload;
}

export class PostgresWorkflowRepository {
  readonly events: PostgresWorkflowEventStore;
  readonly attempts: PostgresWorkflowAttemptStore;

  constructor(private readonly pool: PostgresPool) {
    this.events = new PostgresWorkflowEventStore(pool);
    this.attempts = new PostgresWorkflowAttemptStore(pool);
  }

  createRun(record: WorkflowRunRecord): Promise<void> {
    return this.events.createRun(record);
  }

  readEvents(runId: string): Promise<WorkflowEventRecord[]> {
    return this.events.readEvents(runId);
  }

  append(runId: string, event: V3Event): Promise<number> {
    const projection = runProjection(event);
    return this.events.append({
      runId,
      eventType: event.type,
      payload: eventPayload(event),
      ...projection,
    });
  }

  /**
   * Reserve the durable attempt and publish its dispatch event atomically.
   * A crash can therefore never expose a dispatched node without an attempt
   * row that reconciliation can inspect.
   */
  async dispatch(input: DurableDispatch): Promise<number> {
    if (input.event.attemptId !== input.attemptId) {
      throw new Error('workflow postgres repository: dispatch attempt identity mismatch');
    }
    if (input.event.nodeId !== input.nodeId) {
      throw new Error('workflow postgres repository: dispatch node identity mismatch');
    }
    if (input.event.instanceId !== input.instanceId) {
      throw new Error('workflow postgres repository: dispatch instance identity mismatch');
    }
    return withPostgresTransaction(this.pool, async (client) => {
      await reserveAttemptInTransaction(client, input);
      return appendWorkflowEventInTransaction(client, {
        runId: input.runId,
        eventType: input.event.type,
        payload: eventPayload(input.event),
        status: 'running',
      });
    });
  }

  acquireAttempt(
    runId: string,
    attemptId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<AttemptLease> {
    return this.attempts.acquire(runId, attemptId, holderId, ttlMs);
  }
}
