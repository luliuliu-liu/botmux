import { describe, expect, it } from 'vitest';
import { PostgresWorkflowRepository } from '../src/workflows/v3/adapters/postgres/repository.js';
import type {
  PostgresClient,
  PostgresPool,
} from '../src/workflows/v3/adapters/postgres/event-store.js';

function fakePool(): { pool: PostgresPool; calls: Array<{ sql: string; values?: readonly unknown[] }> } {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client: PostgresClient = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('RETURNING next_event_sequence')) return { rows: [{ sequence: 1 }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, calls };
}

describe('PostgresWorkflowRepository', () => {
  it('commits attempt reservation, dispatch event and outbox together', async () => {
    const fake = fakePool();
    const repository = new PostgresWorkflowRepository(fake.pool);

    await expect(repository.dispatch({
      runId: 'run-1',
      attemptId: 'attempt-1',
      nodeId: 'node-1',
      instanceId: 'node-1#1',
      attemptNumber: 1,
      executor: 'pi',
      event: {
        type: 'nodeDispatched', nodeId: 'node-1', instanceId: 'node-1#1', attemptId: 'attempt-1',
      },
    })).resolves.toBe(1);

    expect(fake.calls[0]?.sql).toBe('BEGIN');
    expect(fake.calls[1]?.sql).toContain('INSERT INTO agent_workflow.workflow_attempt');
    expect(fake.calls[2]?.sql).toContain('UPDATE agent_workflow.workflow_run');
    expect(fake.calls[3]?.sql).toContain('INSERT INTO agent_workflow.workflow_event');
    expect(fake.calls[4]?.sql).toContain('UPDATE agent_workflow.workflow_run');
    expect(fake.calls[5]?.sql).toContain('INSERT INTO agent_workflow.workflow_outbox');
    expect(fake.calls[6]?.sql).toBe('COMMIT');
  });

  it('rejects mismatched worker identities before opening a transaction', async () => {
    const fake = fakePool();
    const repository = new PostgresWorkflowRepository(fake.pool);

    await expect(repository.dispatch({
      runId: 'run-1', attemptId: 'attempt-1', nodeId: 'node-1', instanceId: 'node-1#1',
      attemptNumber: 1, executor: 'pi',
      event: { type: 'nodeDispatched', nodeId: 'node-1', instanceId: 'node-1#1', attemptId: 'wrong' },
    })).rejects.toThrow('attempt identity mismatch');
    expect(fake.calls).toHaveLength(0);
  });
});
