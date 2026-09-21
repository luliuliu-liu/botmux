/**
 * PostgreSQL scheduling repository for the local controller integration.
 *
 * This file is the transaction boundary between upstream Workflow v3 events
 * and local durable scheduling state. It does not alter or replace Botmux's
 * native file-journal runtime.
 */

import type { V3Event } from '../../event-contract.js';
import type { StoredEvent } from '../../event-contract.js';
import {
  PostgresWorkflowAttemptStore,
  reserveAttemptInTransaction,
  settleAttemptInTransaction,
  type AttemptLease,
  type ReserveWorkflowAttempt,
  type TerminalAttemptStatus,
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
import { decodeStoredEvents } from './event-codec.js';
import {
  openWaitInTransaction,
  resolveWaitInTransaction,
  type OpenWorkflowWait,
  type ResolveWorkflowWait,
} from './wait-store.js';

export interface DurableDispatch extends ReserveWorkflowAttempt {
  readonly event: Extract<V3Event, { type: 'nodeDispatched' }>;
}

export interface DurableGateOpen extends OpenWorkflowWait {
  readonly event: Extract<V3Event, { type: 'gateDispatched' }>;
}

export interface DurableGateResolution extends ResolveWorkflowWait {
  readonly event: Extract<V3Event, { type: 'gateResolved' }>;
}

type TerminalWorkerEvent = Extract<
  V3Event,
  { type: 'nodeSucceeded' | 'nodeFailed' | 'nodeBlocked' | 'nodeCancelled' }
>;

export interface DurableAttemptSettlement {
  readonly lease: AttemptLease;
  readonly status: TerminalAttemptStatus;
  readonly details?: Record<string, unknown>;
  readonly event: TerminalWorkerEvent;
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

  async readStoredEvents(runId: string): Promise<StoredEvent[]> {
    return decodeStoredEvents(await this.readEvents(runId));
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

  markAttemptDispatched(lease: AttemptLease, sandboxId: string): Promise<void> {
    return this.attempts.markDispatched(lease, sandboxId);
  }

  async settleAttempt(input: DurableAttemptSettlement): Promise<number> {
    const eventAttemptId = input.event.attemptId;
    if (eventAttemptId !== input.lease.attemptId) {
      throw new Error('workflow postgres repository: settlement attempt identity mismatch');
    }
    const expectedStatus: TerminalAttemptStatus = input.event.type === 'nodeSucceeded'
      ? 'succeeded'
      : input.event.type === 'nodeCancelled'
        ? 'cancelled'
        : 'failed';
    if (input.status !== expectedStatus) {
      throw new Error('workflow postgres repository: settlement status does not match event');
    }
    return withPostgresTransaction(this.pool, async (client) => {
      await settleAttemptInTransaction(client, input.lease, input.status, input.details);
      return appendWorkflowEventInTransaction(client, {
        runId: input.lease.runId,
        eventType: input.event.type,
        payload: eventPayload(input.event),
      });
    });
  }

  async openGate(input: DurableGateOpen): Promise<number> {
    if (input.event.waitId !== input.waitId || input.event.nodeId !== input.nodeId) {
      throw new Error('workflow postgres repository: gate-open identity mismatch');
    }
    return withPostgresTransaction(this.pool, async (client) => {
      await openWaitInTransaction(client, input);
      return appendWorkflowEventInTransaction(client, {
        runId: input.runId,
        eventType: input.event.type,
        payload: eventPayload(input.event),
        status: 'waiting',
      });
    });
  }

  async resolveGate(input: DurableGateResolution): Promise<number> {
    if (
      input.event.waitId !== input.waitId ||
      input.event.resolution !== input.resolution ||
      input.event.by !== input.by
    ) {
      throw new Error('workflow postgres repository: gate-resolution identity mismatch');
    }
    return withPostgresTransaction(this.pool, async (client) => {
      await resolveWaitInTransaction(client, input);
      return appendWorkflowEventInTransaction(client, {
        runId: input.runId,
        eventType: input.event.type,
        payload: eventPayload(input.event),
        status: input.resolution === 'approved' ? 'running' : 'failed',
        terminal: input.resolution === 'rejected',
      });
    });
  }
}
