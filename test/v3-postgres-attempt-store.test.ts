import { describe, expect, it } from 'vitest';
import {
  PostgresWorkflowAttemptStore,
  type AttemptLease,
} from '../src/workflows/v3/postgres-attempt-store.js';
import type {
  PostgresClient,
  PostgresPool,
} from '../src/workflows/v3/postgres-event-store.js';

type Response = { rows?: Record<string, unknown>[]; rowCount?: number | null; fail?: Error };

function pool(responses: Response[]): { pool: PostgresPool; queries: string[]; released: { value: boolean } } {
  const queries: string[] = [];
  const released = { value: false };
  const client: PostgresClient = {
    async query(sql) {
      queries.push(sql);
      const response = responses.shift();
      if (response?.fail) throw response.fail;
      return { rows: (response?.rows ?? []) as Record<string, unknown>[], rowCount: response?.rowCount };
    },
    release() { released.value = true; },
  };
  return { pool: { async connect() { return client; } }, queries, released };
}

const lease: AttemptLease = {
  runId: 'run-1', attemptId: 'attempt-1', holderId: 'controller-a',
  fence: 2, expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('PostgresWorkflowAttemptStore', () => {
  it('reserves and acquires a first fenced lease under one attempt lock', async () => {
    const fake = pool([
      {}, {}, {}, // reserve: BEGIN, INSERT, COMMIT
      {}, // acquire: BEGIN
      { rows: [{ status: 'pending' }] },
      { rows: [] },
      { rows: [{ fence: 1, expires_at: new Date('2099-01-01T00:00:00.000Z') }] },
      { rowCount: 1 },
      {}, // acquire: COMMIT
    ]);
    const store = new PostgresWorkflowAttemptStore(fake.pool);

    await store.reserve({
      runId: 'run-1', attemptId: 'attempt-1', nodeId: 'node-1',
      instanceId: 'node-1#1', attemptNumber: 1, executor: 'pi',
    });
    await expect(store.acquire('run-1', 'attempt-1', 'controller-a', 30_000)).resolves.toMatchObject({
      fence: 1, holderId: 'controller-a',
    });
    expect(fake.queries.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    expect(fake.queries.some((sql) => sql.includes('INSERT INTO agent_workflow.workflow_lease'))).toBe(true);
    expect(fake.released.value).toBe(true);
  });

  it('rejects a stale lease before dispatching a worker', async () => {
    const fake = pool([{}, { rowCount: 0 }, {}]);
    const store = new PostgresWorkflowAttemptStore(fake.pool);

    await expect(store.markDispatched(lease, 'sandbox-1')).rejects.toThrow('stale lease cannot dispatch');
    expect(fake.queries).toEqual(['BEGIN', expect.stringContaining("SET status = 'dispatched'"), 'ROLLBACK']);
  });

  it('settles once and removes only the exact lease fence', async () => {
    const fake = pool([{}, { rowCount: 1 }, { rowCount: 1 }, {}]);
    const store = new PostgresWorkflowAttemptStore(fake.pool);

    await store.settle(lease, 'succeeded', { manifest: 'sha256:abc' });
    expect(fake.queries[1]).toContain('fence = $4');
    expect(fake.queries[2]).toContain('DELETE FROM agent_workflow.workflow_lease');
  });
});
