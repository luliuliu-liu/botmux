import { describe, expect, it } from 'vitest';
import { PostgresWorkflowController } from '../src/workflows/v3/adapters/postgres/controller.js';
import type { DurableControllerRepository } from '../src/workflows/v3/adapters/postgres/controller.js';
import type { StoredEvent, V3Event } from '../src/workflows/v3/event-contract.js';
import type { AttemptLease } from '../src/workflows/v3/adapters/postgres/attempt-store.js';

function memoryRepository(): DurableControllerRepository & {
  events: StoredEvent[];
  sandboxIds: string[];
} {
  let ts = 1;
  const events: StoredEvent[] = [{ type: 'runStarted', runId: 'run-1', ts: ts++ }];
  const sandboxIds: string[] = [];
  const store = (event: V3Event): number => {
    events.push({ ...event, ts: ts++ } as StoredEvent);
    return events.length;
  };
  return {
    events,
    sandboxIds,
    async readStoredEvents() { return [...events]; },
    async append(_runId, event) { return store(event); },
    async dispatch(input) { return store(input.event); },
    async acquireAttempt(runId, attemptId, holderId): Promise<AttemptLease> {
      return { runId, attemptId, holderId, fence: 1, expiresAt: '2099-01-01T00:00:00.000Z' };
    },
    async acquireDispatchedForRecovery(runId, attemptId, holderId) {
      return {
        sandboxId: 'sandbox-recovery',
        lease: { runId, attemptId, holderId, fence: 2, expiresAt: '2099-01-01T00:00:00.000Z' },
      };
    },
    async markAttemptDispatched(_lease, sandboxId) { sandboxIds.push(sandboxId); },
    async settleAttempt(input) { return store(input.event); },
    async openGate(input) { return store(input.event); },
    async resolveGate(input) { return store(input.event); },
    async cancelRun(input) {
      store({
        type: 'runCancelRequested', cancelRequestId: input.cancelRequestId,
        by: input.by, ...(input.reason ? { reason: input.reason } : {}),
      });
      for (const event of input.nodes) store(event);
      return store({ type: 'runCancelled', cancelRequestId: input.cancelRequestId, by: input.by });
    },
    async retryNode(input) { return store(input.event); },
  };
}

describe('PostgresWorkflowController', () => {
  it('drives one official dispatch decision through a durable terminal run', async () => {
    const repository = memoryRepository();
    const controller = new PostgresWorkflowController(repository, async (request) => {
      await request.onSandboxCreated('sandbox-1');
      return { status: 'succeeded', manifestPath: '/runtime/manifest.json' };
    }, { holderId: 'controller-1', executorId: 'pi-opensandbox' });

    const outcome = await controller.drive({
      runId: 'run-1',
      nodes: [{ id: 'node-1', type: 'goal', goal: 'Do the work', depends: [], bot: 'pi' }],
    });

    expect(outcome.snapshot.runStatus).toBe('succeeded');
    expect(outcome.actions).toEqual([]);
    expect(repository.sandboxIds).toEqual(['sandbox-1']);
    expect(repository.events.map((event) => event.type)).toEqual([
      'runStarted', 'nodeDispatched', 'nodeSucceeded', 'runSucceeded',
    ]);
  });

  it('turns executor exceptions into a durable failed run', async () => {
    const repository = memoryRepository();
    const controller = new PostgresWorkflowController(repository, async () => {
      throw new Error('sandbox unavailable');
    }, { holderId: 'controller-1', executorId: 'pi-opensandbox' });

    const outcome = await controller.drive({
      runId: 'run-1',
      nodes: [{ id: 'node-1', type: 'goal', goal: 'Do the work', depends: [], bot: 'pi' }],
    });
    expect(outcome.snapshot.runStatus).toBe('failed');
    expect(repository.events.map((event) => event.type)).toEqual([
      'runStarted', 'nodeDispatched', 'nodeFailed', 'runFailed',
    ]);
  });

  it('suspends on a durable gate and resumes after approval', async () => {
    const repository = memoryRepository();
    const controller = new PostgresWorkflowController(repository, async () => ({
      status: 'succeeded', manifestPath: '/runtime/manifest.json',
    }), { holderId: 'controller-1', executorId: 'pi-opensandbox' });
    const dag = {
      runId: 'run-1',
      nodes: [{
        id: 'node-1', type: 'goal' as const, goal: 'Do the work', depends: [],
        humanGate: { prompt: 'Proceed?' },
      }],
    };

    const suspended = await controller.drive(dag);
    expect(suspended.snapshot.nodes.get('node-1')?.status).toBe('gateWaiting');
    expect(repository.events.map((event) => event.type)).toEqual(['runStarted', 'gateDispatched']);

    const completed = await controller.resolveWait(dag, {
      waitId: 'node-1#001-gate', resolution: 'approved', by: 'operator-1', selected: 'approve',
    });
    expect(completed.snapshot.runStatus).toBe('succeeded');
    expect(repository.events.map((event) => event.type)).toEqual([
      'runStarted', 'gateDispatched', 'gateResolved',
      'nodeDispatched', 'nodeSucceeded', 'runSucceeded',
    ]);
  });

  it('turns a durable gate rejection into the official failed terminal event', async () => {
    const repository = memoryRepository();
    const controller = new PostgresWorkflowController(repository, async () => {
      throw new Error('executor must not run after rejection');
    }, { holderId: 'controller-1', executorId: 'pi-opensandbox' });
    const dag = {
      runId: 'run-1',
      nodes: [{
        id: 'node-1', type: 'goal' as const, goal: 'Do the work', depends: [],
        humanGate: { prompt: 'Proceed?' },
      }],
    };

    await controller.drive(dag);
    const completed = await controller.resolveWait(dag, {
      waitId: 'node-1#001-gate', resolution: 'rejected', by: 'operator-1', selected: 'reject',
    });
    expect(completed.snapshot.runStatus).toBe('failed');
    expect(repository.events.map((event) => event.type)).toEqual([
      'runStarted', 'gateDispatched', 'gateResolved', 'runFailed',
    ]);
  });

  it('settles a proven terminal result from the exact fenced recovery sandbox', async () => {
    const repository = memoryRepository();
    repository.events.push({
      type: 'nodeDispatched', nodeId: 'node-1', instanceId: 'node-1#001',
      attemptId: 'node-1#001/attempts/001', ts: 2,
    });
    const controller = new PostgresWorkflowController(repository, async () => {
      throw new Error('recovery must not redispatch');
    }, { holderId: 'reconciler-1', executorId: 'pi-opensandbox' });

    const completed = await controller.recoverAttempt({
      runId: 'run-1',
      nodes: [{ id: 'node-1', type: 'goal', goal: 'Do the work', depends: [] }],
    }, {
      attemptId: 'node-1#001/attempts/001',
      sandboxId: 'sandbox-recovery',
      status: 'succeeded',
      manifestPath: '/runtime/manifest.json',
      details: { recovered: true },
    });

    expect(completed.snapshot.runStatus).toBe('succeeded');
    expect(repository.events.map((event) => event.type)).toEqual([
      'runStarted', 'nodeDispatched', 'nodeSucceeded', 'runSucceeded',
    ]);
  });

  it('cancels a waiting run without dispatching a worker', async () => {
    const repository = memoryRepository();
    const controller = new PostgresWorkflowController(repository, async () => {
      throw new Error('cancelled gate must not execute');
    }, { holderId: 'controller-1', executorId: 'pi-opensandbox' });
    const dag = {
      runId: 'run-1',
      nodes: [{
        id: 'node-1', type: 'goal' as const, goal: 'Do work', depends: [],
        humanGate: { prompt: 'Proceed?' },
      }],
    };
    await controller.drive(dag);
    const outcome = await controller.cancel(dag, {
      cancelRequestId: 'cancel-1', by: 'operator-1', reason: 'no longer needed',
    });
    expect(outcome.snapshot.runStatus).toBe('cancelled');
    expect(repository.events.map((event) => event.type)).toEqual([
      'runStarted', 'gateDispatched', 'runCancelRequested', 'nodeCancelled', 'runCancelled',
    ]);
  });

  it('treats a stale settlement as benign only after durable cancellation wins', async () => {
    const repository = memoryRepository();
    repository.settleAttempt = async () => { throw new Error('stale lease cannot settle'); };
    const controller = new PostgresWorkflowController(repository, async (request) => {
      await repository.cancelRun({
        runId: request.runId, cancelRequestId: 'cancel-race', by: 'operator-1',
        activeAttempt: { attemptId: request.attemptId, sandboxId: 'sandbox-1' },
        nodes: [{
          type: 'nodeCancelled', nodeId: request.node.id, instanceId: request.instanceId,
          attemptId: request.attemptId, reason: 'runCancelled', cancelRequestId: 'cancel-race',
        }],
      });
      return { status: 'failed', errorCode: 'SANDBOX_TERMINATED' };
    }, { holderId: 'controller-1', executorId: 'pi-opensandbox' });

    const outcome = await controller.drive({
      runId: 'run-1',
      nodes: [{ id: 'node-1', type: 'goal', goal: 'Do the work', depends: [], bot: 'pi' }],
    });
    expect(outcome.snapshot.runStatus).toBe('cancelled');
    expect(repository.events.map((event) => event.type)).toEqual([
      'runStarted', 'nodeDispatched', 'runCancelRequested', 'nodeCancelled', 'runCancelled',
    ]);
  });

  it('retries a blocked node in the same instance with a bounded next attempt', async () => {
    const repository = memoryRepository();
    repository.events.push(
      {
        type: 'nodeDispatched', nodeId: 'node-1', instanceId: 'node-1#001',
        attemptId: 'node-1#001/attempts/001', ts: 2,
      },
      {
        type: 'nodeBlocked', nodeId: 'node-1', instanceId: 'node-1#001',
        attemptId: 'node-1#001/attempts/001', errorClass: 'workerError',
        errorCode: 'RETRYABLE', ts: 3,
      },
      { type: 'runBlocked', blockedNodeId: 'node-1', ts: 4 },
    );
    const attempts: string[] = [];
    const controller = new PostgresWorkflowController(repository, async (request) => {
      attempts.push(request.attemptId);
      return { status: 'succeeded', manifestPath: '/runtime/manifest.json' };
    }, { holderId: 'controller-1', executorId: 'pi-opensandbox' });
    const outcome = await controller.retry({
      runId: 'run-1',
      nodes: [{ id: 'node-1', type: 'goal', goal: 'Do the work', depends: [] }],
    }, { expectedAttemptId: 'node-1#001/attempts/001', maxAttempts: 3 });
    expect(outcome.snapshot.runStatus).toBe('succeeded');
    expect(attempts).toEqual(['node-1#001/attempts/002']);
    expect(repository.events.map((event) => event.type)).toEqual([
      'runStarted', 'nodeDispatched', 'nodeBlocked', 'runBlocked',
      'nodeRetryRequested', 'nodeDispatched', 'nodeSucceeded', 'runSucceeded',
    ]);
  });

  it('refuses retry after the bounded attempt budget is exhausted', async () => {
    const repository = memoryRepository();
    repository.events.push(
      {
        type: 'nodeDispatched', nodeId: 'node-1', instanceId: 'node-1#001',
        attemptId: 'node-1#001/attempts/003', ts: 2,
      },
      {
        type: 'nodeBlocked', nodeId: 'node-1', instanceId: 'node-1#001',
        attemptId: 'node-1#001/attempts/003', errorClass: 'workerError', ts: 3,
      },
      { type: 'runBlocked', blockedNodeId: 'node-1', ts: 4 },
    );
    const controller = new PostgresWorkflowController(repository, async () => {
      throw new Error('executor must not run');
    }, { holderId: 'controller-1', executorId: 'pi-opensandbox' });
    await expect(controller.retry({
      runId: 'run-1',
      nodes: [{ id: 'node-1', type: 'goal', goal: 'Do the work', depends: [] }],
    }, { maxAttempts: 3 })).rejects.toThrow('retry budget exhausted');
  });
});
