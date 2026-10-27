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
  type RecoveredAttemptLease,
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

export interface DurableRunCancellation {
  readonly runId: string;
  readonly cancelRequestId: string;
  readonly by: string;
  readonly reason?: string;
  readonly nodes: ReadonlyArray<Extract<V3Event, { type: 'nodeCancelled' }>>;
  readonly activeAttempt?: {
    readonly attemptId: string;
    readonly sandboxId: string | null;
  };
}

export interface DurableNodeRetry {
  readonly runId: string;
  readonly event: Extract<V3Event, { type: 'nodeRetryRequested' }>;
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

  acquireDispatchedForRecovery(
    runId: string,
    attemptId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<RecoveredAttemptLease> {
    return this.attempts.acquireDispatchedForRecovery(runId, attemptId, holderId, ttlMs);
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
        // gateResolved changes the materialized node; the scheduler owns the
        // subsequent runFailed event for rejection. Do not expose a terminal
        // run projection before that authoritative terminal event exists.
        status: 'running',
      });
    });
  }

  /**
   * Linearize cancellation against a late worker settlement. The active
   * attempt row is locked and moved to cancelled before its lease is removed;
   * a concurrent old holder therefore either settles first or loses its fence.
   */
  async cancelRun(input: DurableRunCancellation): Promise<number> {
    return withPostgresTransaction(this.pool, async (client) => {
      const run = await client.query<{ status: WorkflowRunStatus }>(
        `SELECT status FROM agent_workflow.workflow_run WHERE run_id = $1 FOR UPDATE`,
        [input.runId],
      );
      const status = run.rows[0]?.status;
      if (!status) throw new Error(`workflow postgres repository: run not found: ${input.runId}`);
      if (['succeeded', 'failed', 'cancelled'].includes(status)) {
        throw new Error(`workflow postgres repository: terminal run cannot be cancelled: ${input.runId}`);
      }
      const active = await client.query<{ attempt_id: string; sandbox_id: string | null }>(
        `SELECT attempt_id, sandbox_id
           FROM agent_workflow.workflow_attempt
          WHERE run_id = $1 AND status IN ('pending', 'leased', 'dispatched', 'unknown')
          ORDER BY created_at FOR UPDATE`,
        [input.runId],
      );
      if (active.rows.length > 1) {
        throw new Error('workflow postgres repository: serial controller found multiple active attempts');
      }
      const current = active.rows[0];
      if (current) {
        if (!input.activeAttempt || current.attempt_id !== input.activeAttempt.attemptId ||
            current.sandbox_id !== input.activeAttempt.sandboxId) {
          throw new Error('workflow postgres repository: active cancellation identity mismatch');
        }
        await client.query(
          `UPDATE agent_workflow.workflow_attempt
              SET status = 'cancelled', failure = $3::jsonb, settled_at = now()
            WHERE run_id = $1 AND attempt_id = $2`,
          [input.runId, current.attempt_id, JSON.stringify({
            errorCode: 'RUN_CANCELLED', cancelRequestId: input.cancelRequestId,
          })],
        );
        await client.query(
          `DELETE FROM agent_workflow.workflow_lease WHERE run_id = $1 AND attempt_id = $2`,
          [input.runId, current.attempt_id],
        );
      } else if (input.activeAttempt) {
        throw new Error('workflow postgres repository: cancellation attempt already settled');
      }
      await client.query(
        `UPDATE agent_workflow.workflow_wait
            SET status = 'cancelled', resolution = $2::jsonb, resolved_at = now()
          WHERE run_id = $1 AND status = 'pending'`,
        [input.runId, JSON.stringify({
          cancelRequestId: input.cancelRequestId, by: input.by,
          ...(input.reason ? { reason: input.reason } : {}),
        })],
      );
      await appendWorkflowEventInTransaction(client, {
        runId: input.runId, eventType: 'runCancelRequested',
        payload: eventPayload({
          type: 'runCancelRequested', cancelRequestId: input.cancelRequestId,
          by: input.by, ...(input.reason ? { reason: input.reason } : {}),
        }),
        status: 'running',
      });
      for (const event of input.nodes) {
        await appendWorkflowEventInTransaction(client, {
          runId: input.runId, eventType: event.type, payload: eventPayload(event),
        });
      }
      return appendWorkflowEventInTransaction(client, {
        runId: input.runId, eventType: 'runCancelled',
        payload: eventPayload({
          type: 'runCancelled', cancelRequestId: input.cancelRequestId, by: input.by,
        }),
        status: 'cancelled', terminal: true,
      });
    });
  }

  async retryNode(input: DurableNodeRetry): Promise<number> {
    return withPostgresTransaction(this.pool, async (client) => {
      const run = await client.query<{ status: WorkflowRunStatus }>(
        `SELECT status FROM agent_workflow.workflow_run WHERE run_id = $1 FOR UPDATE`,
        [input.runId],
      );
      if (run.rows[0]?.status !== 'blocked') {
        throw new Error(`workflow postgres repository: run is not blocked: ${input.runId}`);
      }
      const previous = await client.query<{ status: string }>(
        `SELECT status FROM agent_workflow.workflow_attempt
          WHERE run_id = $1 AND attempt_id = $2 FOR UPDATE`,
        [input.runId, input.event.previousAttemptId],
      );
      if (previous.rows[0]?.status !== 'failed') {
        throw new Error('workflow postgres repository: retry attempt is not durably blocked');
      }
      return appendWorkflowEventInTransaction(client, {
        runId: input.runId, eventType: input.event.type,
        payload: eventPayload(input.event), status: 'running',
      });
    });
  }
}
