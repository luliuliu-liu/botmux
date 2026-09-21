/**
 * PostgreSQL-backed append-only Workflow v3 event store.
 *
 * This deliberately depends only on the small structural subset exposed by
 * `pg.Pool` / `pg.PoolClient`.  Botmux core remains importable without a
 * bundled database driver; a controller supplies a pool at its composition
 * boundary.  Every mutation below runs in one database transaction: sequence
 * allocation, event append, run projection and transactional-outbox enqueue
 * either all commit or all roll back together.
 */

export type WorkflowRunStatus =
  | 'created'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type JsonObject = Record<string, unknown>;

export interface PostgresQueryResult<Row extends object = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PostgresClient {
  query<Row extends object = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
  release(): void;
}

/** Structural compatibility with `pg.Pool`; no runtime package import. */
export interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

/** Run a caller-defined mutation with pg-compatible transaction semantics. */
export async function withPostgresTransaction<T>(
  pool: PostgresPool,
  work: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original error; a failed rollback means the pool should
      // discard/recover the connection before the next checkout.
    }
    throw error;
  } finally {
    client.release();
  }
}

export interface WorkflowRunRecord {
  readonly runId: string;
  readonly definition: JsonObject;
  readonly executionProfiles: JsonObject;
  readonly workspaceBinding: JsonObject;
  readonly authorizationSnapshot: JsonObject;
}

export interface WorkflowEventRecord {
  readonly runId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly occurredAt: string;
}

export interface AppendWorkflowEvent {
  readonly runId: string;
  readonly eventType: string;
  readonly payload: JsonObject;
  /** The materialized run status to publish atomically with this event. */
  readonly status?: WorkflowRunStatus;
  /** Set the terminal timestamp only when this event reaches a terminal run. */
  readonly terminal?: boolean;
  /** Event consumers use the outbox; callers may choose a narrower topic. */
  readonly topic?: string;
}

type SequenceRow = { sequence: string | number };
type EventRow = {
  run_id: string;
  sequence: string | number;
  event_type: string;
  payload: JsonObject;
  occurred_at: Date | string;
};

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`workflow postgres store: ${label} is required`);
  return value;
}

function asSequence(value: string | number): number {
  const sequence = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`workflow postgres store: invalid allocated event sequence ${String(value)}`);
  }
  return sequence;
}

function asIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function allocateSequence(client: PostgresClient, runId: string): Promise<number> {
  // This UPDATE obtains the row lock and increments the allocator in the same
  // statement. Concurrent writers serialize per run without a global lock.
  const allocation = await client.query<SequenceRow>(
    `UPDATE agent_workflow.workflow_run
        SET next_event_sequence = next_event_sequence + 1,
            updated_at = now()
      WHERE run_id = $1
      RETURNING next_event_sequence - 1 AS sequence`,
    [runId],
  );
  const row = allocation.rows[0];
  if (!row) throw new Error(`workflow postgres store: run not found: ${runId}`);
  return asSequence(row.sequence);
}

async function appendInTransaction(
  client: PostgresClient,
  input: AppendWorkflowEvent,
): Promise<number> {
  requireNonEmpty(input.runId, 'runId');
  requireNonEmpty(input.eventType, 'eventType');
  const sequence = await allocateSequence(client, input.runId);
  await client.query(
    `INSERT INTO agent_workflow.workflow_event (run_id, sequence, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [input.runId, sequence, input.eventType, JSON.stringify(input.payload)],
  );
  if (input.status) {
    await client.query(
      `UPDATE agent_workflow.workflow_run
          SET status = $2,
              terminal_at = CASE WHEN $3 THEN now() ELSE terminal_at END,
              updated_at = now()
        WHERE run_id = $1`,
      [input.runId, input.status, input.terminal === true],
    );
  }
  await client.query(
    `INSERT INTO agent_workflow.workflow_outbox
       (run_id, event_sequence, topic, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      input.runId,
      sequence,
      input.topic ?? 'workflow.event',
      JSON.stringify({
        runId: input.runId,
        sequence,
        eventType: input.eventType,
        payload: input.payload,
      }),
    ],
  );
  return sequence;
}

export class PostgresWorkflowEventStore {
  constructor(private readonly pool: PostgresPool) {}

  private async transaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    return withPostgresTransaction(this.pool, work);
  }

  /** Create an immutable run envelope and its first audit event atomically. */
  async createRun(record: WorkflowRunRecord): Promise<void> {
    requireNonEmpty(record.runId, 'runId');
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO agent_workflow.workflow_run
           (run_id, definition, execution_profiles, workspace_binding, authorization_snapshot, status)
         VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, 'running')`,
        [
          record.runId,
          JSON.stringify(record.definition),
          JSON.stringify(record.executionProfiles),
          JSON.stringify(record.workspaceBinding),
          JSON.stringify(record.authorizationSnapshot),
        ],
      );
      await appendInTransaction(client, {
        runId: record.runId,
        eventType: 'runStarted',
        payload: { runId: record.runId },
        status: 'running',
      });
    });
  }

  /** Append one event, projection update and outbox message as one commit. */
  async append(input: AppendWorkflowEvent): Promise<number> {
    return this.transaction((client) => appendInTransaction(client, input));
  }

  /** Read the immutable event stream in the only valid replay order. */
  async readEvents(runId: string): Promise<WorkflowEventRecord[]> {
    requireNonEmpty(runId, 'runId');
    const client = await this.pool.connect();
    try {
      const result = await client.query<EventRow>(
        `SELECT run_id, sequence, event_type, payload, occurred_at
           FROM agent_workflow.workflow_event
          WHERE run_id = $1
          ORDER BY sequence ASC`,
        [runId],
      );
      return result.rows.map((row) => ({
        runId: row.run_id,
        sequence: asSequence(row.sequence),
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: asIsoTimestamp(row.occurred_at),
      }));
    } finally {
      client.release();
    }
  }
}
