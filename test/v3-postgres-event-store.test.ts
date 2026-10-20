import { describe, expect, it } from 'vitest';
import {
  PostgresWorkflowEventStore,
  type PostgresClient,
  type PostgresPool,
} from '../src/workflows/v3/adapters/postgres/event-store.js';

type SeenQuery = { sql: string; values?: readonly unknown[] };

function scriptedPool(responses: Array<{ rows?: Record<string, unknown>[]; fail?: Error }>): {
  pool: PostgresPool;
  queries: SeenQuery[];
  released: { value: boolean };
} {
  const queries: SeenQuery[] = [];
  const released = { value: false };
  const client: PostgresClient = {
    async query(sql, values) {
      queries.push({ sql, values });
      const response = responses.shift();
      if (response?.fail) throw response.fail;
      return { rows: (response?.rows ?? []) as Record<string, unknown>[] };
    },
    release() {
      released.value = true;
    },
  };
  return { pool: { async connect() { return client; } }, queries, released };
}

describe('PostgresWorkflowEventStore', () => {
  it('creates a run, first event, projection and outbox in one transaction', async () => {
    const fake = scriptedPool([
      {}, {}, { rows: [{ sequence: 1 }] }, {}, {}, {},
    ]);
    const store = new PostgresWorkflowEventStore(fake.pool);

    await store.createRun({
      runId: 'run-1',
      definition: { nodes: [] },
      executionProfiles: {},
      workspaceBinding: { claim: 'workspace-1' },
      authorizationSnapshot: { actor: 'user-1' },
    });

    expect(fake.queries.map((query) => query.sql.split('\n')[0]?.trim())).toEqual([
      'BEGIN',
      'INSERT INTO agent_workflow.workflow_run',
      'UPDATE agent_workflow.workflow_run',
      'INSERT INTO agent_workflow.workflow_event (run_id, sequence, event_type, payload)',
      'UPDATE agent_workflow.workflow_run',
      'INSERT INTO agent_workflow.workflow_outbox',
      'COMMIT',
    ]);
    expect(fake.queries[3]?.values).toEqual(['run-1', 1, 'runStarted', '{"runId":"run-1"}']);
    expect(fake.queries[5]?.values?.[2]).toBe('workflow.event');
    expect(fake.released.value).toBe(true);
  });

  it('rolls back and releases the connection when event allocation fails', async () => {
    const fake = scriptedPool([{}, { fail: new Error('run missing') }, {}]);
    const store = new PostgresWorkflowEventStore(fake.pool);

    await expect(store.append({
      runId: 'missing',
      eventType: 'nodeDispatched',
      payload: { nodeId: 'node-1' },
    })).rejects.toThrow('run missing');

    expect(fake.queries.map((query) => query.sql)).toEqual(['BEGIN', expect.any(String), 'ROLLBACK']);
    expect(fake.released.value).toBe(true);
  });

  it('returns event replay records in sequence order without mutating them', async () => {
    const fake = scriptedPool([{ rows: [{
      run_id: 'run-1', sequence: '2', event_type: 'nodeSucceeded',
      payload: { nodeId: 'node-1' }, occurred_at: new Date('2026-09-21T00:00:00.000Z'),
    }] }]);
    const store = new PostgresWorkflowEventStore(fake.pool);

    await expect(store.readEvents('run-1')).resolves.toEqual([{
      runId: 'run-1', sequence: 2, eventType: 'nodeSucceeded',
      payload: { nodeId: 'node-1' }, occurredAt: '2026-09-21T00:00:00.000Z',
    }]);
    expect(fake.queries[0]?.sql).toContain('ORDER BY sequence ASC');
  });
});
