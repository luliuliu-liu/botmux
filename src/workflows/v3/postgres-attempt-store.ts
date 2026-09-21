/**
 * Fenced PostgreSQL attempt leases for a Workflow v3 controller.
 *
 * The lease fence is monotonically increased every time an expired attempt is
 * recovered. A worker/result callback must present its exact fence and holder,
 * so a late process cannot settle an attempt reacquired by a newer controller.
 */

import {
  type PostgresClient,
  type PostgresPool,
  withPostgresTransaction,
} from './postgres-event-store.js';

export type AttemptStatus =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface ReserveWorkflowAttempt {
  readonly runId: string;
  readonly attemptId: string;
  readonly nodeId: string;
  readonly instanceId: string;
  readonly attemptNumber: number;
  readonly executor: string;
}

export interface AttemptLease {
  readonly runId: string;
  readonly attemptId: string;
  readonly holderId: string;
  readonly fence: number;
  readonly expiresAt: string;
}

type AttemptRow = { status: AttemptStatus };
type LeaseRow = {
  fence: string | number;
  holder_id: string;
  expires_at: Date | string;
  is_live: boolean;
};
type FenceRow = { fence: string | number; expires_at: Date | string };

function required(value: string, name: string): string {
  if (!value.trim()) throw new Error(`workflow postgres attempt store: ${name} is required`);
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`workflow postgres attempt store: ${name} must be a positive integer`);
  }
  return value;
}

function fence(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`workflow postgres attempt store: invalid fence ${String(value)}`);
  }
  return parsed;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export class PostgresWorkflowAttemptStore {
  constructor(private readonly pool: PostgresPool) {}

  async reserve(input: ReserveWorkflowAttempt): Promise<void> {
    required(input.runId, 'runId');
    required(input.attemptId, 'attemptId');
    required(input.nodeId, 'nodeId');
    required(input.instanceId, 'instanceId');
    required(input.executor, 'executor');
    positive(input.attemptNumber, 'attemptNumber');
    await withPostgresTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO agent_workflow.workflow_attempt
           (run_id, attempt_id, node_id, instance_id, attempt_number, executor, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [input.runId, input.attemptId, input.nodeId, input.instanceId, input.attemptNumber, input.executor],
      );
    });
  }

  /**
   * Acquire an unowned or expired lease. Locks are scoped to one attempt and
   * the returned fence must be stored with every externally observed result.
   */
  async acquire(
    runId: string,
    attemptId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<AttemptLease> {
    required(runId, 'runId');
    required(attemptId, 'attemptId');
    required(holderId, 'holderId');
    positive(ttlMs, 'ttlMs');
    return withPostgresTransaction(this.pool, async (client) => {
      const attempt = await client.query<AttemptRow>(
        `SELECT status
           FROM agent_workflow.workflow_attempt
          WHERE run_id = $1 AND attempt_id = $2
          FOR UPDATE`,
        [runId, attemptId],
      );
      const current = attempt.rows[0];
      if (!current) throw new Error(`workflow postgres attempt store: attempt not found: ${attemptId}`);
      if (current.status !== 'pending' && current.status !== 'leased') {
        throw new Error(`workflow postgres attempt store: attempt is not leasable: ${attemptId}`);
      }
      const existing = await client.query<LeaseRow>(
        `SELECT fence, holder_id, expires_at, expires_at > now() AS is_live
           FROM agent_workflow.workflow_lease
          WHERE run_id = $1 AND attempt_id = $2
          FOR UPDATE`,
        [runId, attemptId],
      );
      const lease = existing.rows[0];
      if (lease) {
        if (lease.is_live) {
          throw new Error(`workflow postgres attempt store: attempt lease is held: ${attemptId}`);
        }
      }
      const next = lease
        ? await client.query<FenceRow>(
          `UPDATE agent_workflow.workflow_lease
              SET fence = fence + 1, holder_id = $3,
                  expires_at = now() + ($4 * interval '1 millisecond'), updated_at = now()
            WHERE run_id = $1 AND attempt_id = $2
            RETURNING fence, expires_at`,
          [runId, attemptId, holderId, ttlMs],
        )
        : await client.query<FenceRow>(
          `INSERT INTO agent_workflow.workflow_lease
             (run_id, attempt_id, fence, holder_id, expires_at)
           VALUES ($1, $2, 1, $3, now() + ($4 * interval '1 millisecond'))
           RETURNING fence, expires_at`,
          [runId, attemptId, holderId, ttlMs],
        );
      const granted = next.rows[0];
      if (!granted) throw new Error(`workflow postgres attempt store: lease allocation failed: ${attemptId}`);
      await client.query(
        `UPDATE agent_workflow.workflow_attempt
            SET status = 'leased'
          WHERE run_id = $1 AND attempt_id = $2`,
        [runId, attemptId],
      );
      return { runId, attemptId, holderId, fence: fence(granted.fence), expiresAt: iso(granted.expires_at) };
    });
  }

  /** Mark an attempt dispatched only when the caller still owns its fence. */
  async markDispatched(lease: AttemptLease, sandboxId: string): Promise<void> {
    required(sandboxId, 'sandboxId');
    await this.requireOwnedUpdate(lease,
      `UPDATE agent_workflow.workflow_attempt
          SET status = 'dispatched', sandbox_id = $5, dispatched_at = now()
        WHERE run_id = $1 AND attempt_id = $2
          AND status = 'leased'
          AND EXISTS (
            SELECT 1 FROM agent_workflow.workflow_lease
             WHERE run_id = $1 AND attempt_id = $2 AND holder_id = $3
               AND fence = $4 AND expires_at > now()
          )`,
      [sandboxId],
    );
  }

  /** Settle exactly once and retire the matching lease in one transaction. */
  async settle(
    lease: AttemptLease,
    status: Extract<AttemptStatus, 'succeeded' | 'failed' | 'cancelled' | 'unknown'>,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await withPostgresTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE agent_workflow.workflow_attempt
            SET status = $5,
                result_manifest = CASE WHEN $5 = 'succeeded' THEN $6::jsonb ELSE result_manifest END,
                failure = CASE WHEN $5 <> 'succeeded' THEN $6::jsonb ELSE failure END,
                settled_at = now()
          WHERE run_id = $1 AND attempt_id = $2
            AND status IN ('leased', 'dispatched')
            AND EXISTS (
              SELECT 1 FROM agent_workflow.workflow_lease
               WHERE run_id = $1 AND attempt_id = $2 AND holder_id = $3
                 AND fence = $4 AND expires_at > now()
            )`,
        [lease.runId, lease.attemptId, lease.holderId, lease.fence, status, JSON.stringify(details)],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new Error(`workflow postgres attempt store: stale lease cannot settle: ${lease.attemptId}`);
      }
      await client.query(
        `DELETE FROM agent_workflow.workflow_lease
          WHERE run_id = $1 AND attempt_id = $2 AND holder_id = $3 AND fence = $4`,
        [lease.runId, lease.attemptId, lease.holderId, lease.fence],
      );
    });
  }

  private async requireOwnedUpdate(
    lease: AttemptLease,
    sql: string,
    suffix: readonly unknown[],
  ): Promise<void> {
    await withPostgresTransaction(this.pool, async (client) => {
      const updated = await client.query(sql, [
        lease.runId, lease.attemptId, lease.holderId, lease.fence, ...suffix,
      ]);
      if ((updated.rowCount ?? 0) !== 1) {
        throw new Error(`workflow postgres attempt store: stale lease cannot dispatch: ${lease.attemptId}`);
      }
    });
  }
}
