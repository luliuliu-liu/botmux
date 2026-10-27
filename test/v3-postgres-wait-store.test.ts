import { describe, expect, it } from 'vitest';
import { PostgresWorkflowRepository } from '../src/workflows/v3/adapters/postgres/repository.js';
import type { PostgresClient, PostgresPool } from '../src/workflows/v3/adapters/postgres/event-store.js';

function fakePool(): { pool: PostgresPool; calls: string[] } {
  const calls: string[] = [];
  const client: PostgresClient = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('RETURNING next_event_sequence')) return { rows: [{ sequence: 2 }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, calls };
}

describe('PostgreSQL workflow waits', () => {
  it('opens a wait and its gate event atomically', async () => {
    const fake = fakePool();
    const repository = new PostgresWorkflowRepository(fake.pool);
    await repository.openGate({
      runId: 'run-1', waitId: 'wait-1', nodeId: 'node-1', prompt: 'Approve?', options: ['yes', 'no'],
      event: { type: 'gateDispatched', nodeId: 'node-1', instanceId: 'node-1#1', waitId: 'wait-1' },
    });
    expect(fake.calls[0]).toBe('BEGIN');
    expect(fake.calls[1]).toContain('INSERT INTO agent_workflow.workflow_wait');
    expect(fake.calls.at(-1)).toBe('COMMIT');
  });

  it('resolves a wait once and commits the matching gate event', async () => {
    const fake = fakePool();
    const repository = new PostgresWorkflowRepository(fake.pool);
    await repository.resolveGate({
      runId: 'run-1', waitId: 'wait-1', resolution: 'approved', by: 'user-1', selected: 'yes',
      event: {
        type: 'gateResolved', nodeId: 'node-1', instanceId: 'node-1#1', waitId: 'wait-1',
        resolution: 'approved', by: 'user-1', selected: 'yes',
      },
    });
    expect(fake.calls[1]).toContain('UPDATE agent_workflow.workflow_wait');
    expect(fake.calls.some((sql) => sql.includes('INSERT INTO agent_workflow.workflow_event'))).toBe(true);
    expect(fake.calls.at(-1)).toBe('COMMIT');
  });

  it('rejects a mismatched gate event before opening a transaction', async () => {
    const fake = fakePool();
    const repository = new PostgresWorkflowRepository(fake.pool);
    await expect(repository.openGate({
      runId: 'run-1', waitId: 'wait-1', nodeId: 'node-1', prompt: 'Approve?', options: [],
      event: { type: 'gateDispatched', nodeId: 'other', waitId: 'wait-1' },
    })).rejects.toThrow('gate-open identity mismatch');
    expect(fake.calls).toHaveLength(0);
  });
});
