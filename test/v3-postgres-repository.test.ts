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

  it('settles an attempt, retires its fence and appends the result event atomically', async () => {
    const fake = fakePool();
    const repository = new PostgresWorkflowRepository(fake.pool);
    await expect(repository.settleAttempt({
      lease: {
        runId: 'run-1', attemptId: 'attempt-1', holderId: 'controller-1',
        fence: 1, expiresAt: '2099-01-01T00:00:00.000Z',
      },
      status: 'succeeded',
      details: { manifest: 'sha256:abc' },
      event: {
        type: 'nodeSucceeded', nodeId: 'node-1', instanceId: 'node-1#1',
        attemptId: 'attempt-1', manifestPath: '/runtime/manifest.json',
      },
    })).resolves.toBe(1);
    expect(fake.calls[0]?.sql).toBe('BEGIN');
    expect(fake.calls[1]?.sql).toContain("SET status = $5");
    expect(fake.calls[2]?.sql).toContain('DELETE FROM agent_workflow.workflow_lease');
    expect(fake.calls[3]?.sql).toContain('UPDATE agent_workflow.workflow_run');
    expect(fake.calls[4]?.sql).toContain('INSERT INTO agent_workflow.workflow_event');
    expect(fake.calls[5]?.sql).toContain('INSERT INTO agent_workflow.workflow_outbox');
    expect(fake.calls[6]?.sql).toBe('COMMIT');
  });

  it('fences an active attempt and records cancellation as one transaction', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client: PostgresClient = {
      async query(sql, values) {
        calls.push({ sql, values });
        if (sql.includes('SELECT status FROM agent_workflow.workflow_run')) {
          return { rows: [{ status: 'running' }] };
        }
        if (sql.includes('SELECT attempt_id, sandbox_id')) {
          return { rows: [{ attempt_id: 'attempt-1', sandbox_id: 'sandbox-1' }] };
        }
        if (sql.includes('RETURNING next_event_sequence')) return { rows: [{ sequence: calls.length }] };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const repository = new PostgresWorkflowRepository({ async connect() { return client; } });
    await expect(repository.cancelRun({
      runId: 'run-1', cancelRequestId: 'cancel-1', by: 'operator-1',
      activeAttempt: { attemptId: 'attempt-1', sandboxId: 'sandbox-1' },
      nodes: [{
        type: 'nodeCancelled', nodeId: 'node-1', instanceId: 'node-1#001',
        attemptId: 'attempt-1', reason: 'runCancelled', cancelRequestId: 'cancel-1',
      }],
    })).resolves.toBeGreaterThan(0);
    expect(calls[0]?.sql).toBe('BEGIN');
    expect(calls.some((call) => call.sql.includes("SET status = 'cancelled'"))).toBe(true);
    expect(calls.some((call) => call.sql.includes('DELETE FROM agent_workflow.workflow_lease'))).toBe(true);
    expect(calls.filter((call) => call.sql.includes('INSERT INTO agent_workflow.workflow_event')))
      .toHaveLength(3);
    expect(calls.at(-1)?.sql).toBe('COMMIT');
  });

  it('records a blocked retry reservation with the run reopening atomically', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client: PostgresClient = {
      async query(sql, values) {
        calls.push({ sql, values });
        if (sql.includes('SELECT status FROM agent_workflow.workflow_run')) {
          return { rows: [{ status: 'blocked' }] };
        }
        if (sql.includes('SELECT status FROM agent_workflow.workflow_attempt')) {
          return { rows: [{ status: 'failed' }] };
        }
        if (sql.includes('RETURNING next_event_sequence')) return { rows: [{ sequence: 5 }] };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const repository = new PostgresWorkflowRepository({ async connect() { return client; } });
    await expect(repository.retryNode({
      runId: 'run-1',
      event: {
        type: 'nodeRetryRequested', nodeId: 'node-1', instanceId: 'node-1#001',
        previousAttemptId: 'node-1#001/attempts/001',
        nextAttemptId: 'node-1#001/attempts/002', reason: 'blockedRetry',
      },
    })).resolves.toBe(5);
    expect(calls[0]?.sql).toBe('BEGIN');
    expect(calls.some((call) => call.sql.includes('INSERT INTO agent_workflow.workflow_event'))).toBe(true);
    expect(calls.some((call) => call.sql.includes("status = $2"))).toBe(true);
    expect(calls.at(-1)?.sql).toBe('COMMIT');
  });
});
