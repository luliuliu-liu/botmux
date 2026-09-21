import { describe, expect, it } from 'vitest';
import { PostgresWorkflowScheduler } from '../src/workflows/v3/adapters/postgres/scheduler.js';
import type { StoredEvent } from '../src/workflows/v3/event-contract.js';
import type { V3Dag } from '../src/workflows/v3/dag.js';

const dag: V3Dag = {
  runId: 'run-1',
  nodes: [{ id: 'node-1', type: 'goal', goal: 'Produce the result', depends: [], bot: 'pi' }],
};

const stored = (ts: number, event: Omit<StoredEvent, 'ts'>): StoredEvent => ({
  ...event,
  ts,
} as StoredEvent);

describe('PostgresWorkflowScheduler', () => {
  it('uses upstream decisions for a recovered fresh run', async () => {
    const scheduler = new PostgresWorkflowScheduler({
      async readStoredEvents() {
        return [stored(1, { type: 'runStarted', runId: 'run-1' })];
      },
    });
    const plan = await scheduler.plan(dag);
    expect(plan.snapshot.runStatus).toBe('running');
    expect(plan.actions).toEqual([{
      kind: 'dispatchWork', nodeId: 'node-1', instanceId: 'node-1#001',
    }]);
  });

  it('does not duplicate a dispatch recovered as running', async () => {
    const scheduler = new PostgresWorkflowScheduler({
      async readStoredEvents() {
        return [
          stored(1, { type: 'runStarted', runId: 'run-1' }),
          stored(2, {
            type: 'nodeDispatched', nodeId: 'node-1', instanceId: 'node-1#001', attemptId: 'attempt-1',
          }),
        ];
      },
    });
    const plan = await scheduler.plan(dag);
    expect(plan.actions).toEqual([]);
  });

  it('uses upstream terminal projection after recovery', async () => {
    const scheduler = new PostgresWorkflowScheduler({
      async readStoredEvents() {
        return [
          stored(1, { type: 'runStarted', runId: 'run-1' }),
          stored(2, {
            type: 'nodeDispatched', nodeId: 'node-1', instanceId: 'node-1#001', attemptId: 'attempt-1',
          }),
          stored(3, {
            type: 'nodeSucceeded', nodeId: 'node-1', instanceId: 'node-1#001',
            attemptId: 'attempt-1', manifestPath: '/output/manifest.json',
          }),
        ];
      },
    });
    const plan = await scheduler.plan(dag);
    expect(plan.actions).toEqual([{ kind: 'completeRunSucceeded' }]);
  });
});
