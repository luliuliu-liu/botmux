/**
 * Local PostgreSQL controller driver over upstream Workflow v3 decisions.
 *
 * First slice: serial goal nodes and run terminal actions. Gates, host actions,
 * loops and conditional edges remain explicit unsupported actions rather than
 * being reimplemented differently from upstream runtime semantics.
 */

import { isGoalNode, type V3Dag, type V3GoalNode } from '../../dag.js';
import type { StoredEvent, V3Event } from '../../event-contract.js';
import type { V3Action } from '../../orchestrator.js';
import { nextAttemptIdFor } from '../../shared-node-runtime.js';
import { normalizeGateWaitInput } from '../../gate-policy.js';
import { v3GateWaitId } from '../../gate-wait-store.js';
import type { AttemptLease } from './attempt-store.js';
import type {
  DurableAttemptSettlement,
  DurableDispatch,
  DurableGateOpen,
  DurableGateResolution,
} from './repository.js';
import {
  PostgresWorkflowScheduler,
  type DurableWorkflowPlan,
} from './scheduler.js';

export interface GoalExecutionRequest {
  readonly runId: string;
  readonly node: V3GoalNode;
  readonly instanceId: string;
  readonly attemptId: string;
  readonly onSandboxCreated: (sandboxId: string) => Promise<void>;
}

export type GoalExecutionResult =
  | { status: 'succeeded'; manifestPath: string; details?: Record<string, unknown> }
  | { status: 'failed'; errorCode?: string; message?: string; details?: Record<string, unknown> }
  | { status: 'blocked'; errorCode?: string; message?: string; details?: Record<string, unknown> };

export type GoalExecutor = (request: GoalExecutionRequest) => Promise<GoalExecutionResult>;

export interface DurableControllerRepository {
  readStoredEvents(runId: string): Promise<StoredEvent[]>;
  append(runId: string, event: V3Event): Promise<number>;
  dispatch(input: DurableDispatch): Promise<number>;
  acquireAttempt(runId: string, attemptId: string, holderId: string, ttlMs: number): Promise<AttemptLease>;
  markAttemptDispatched(lease: AttemptLease, sandboxId: string): Promise<void>;
  settleAttempt(input: DurableAttemptSettlement): Promise<number>;
  openGate(input: DurableGateOpen): Promise<number>;
  resolveGate(input: DurableGateResolution): Promise<number>;
}

export interface ResolvePostgresWorkflowWait {
  readonly waitId: string;
  readonly resolution: 'approved' | 'rejected';
  readonly by: string;
  readonly selected?: string;
}

export interface PostgresWorkflowControllerOptions {
  readonly holderId: string;
  readonly executorId: string;
  readonly leaseTtlMs?: number;
  readonly maxSteps?: number;
}

export class PostgresWorkflowController {
  private readonly scheduler: PostgresWorkflowScheduler;

  constructor(
    private readonly repository: DurableControllerRepository,
    private readonly executeGoal: GoalExecutor,
    private readonly options: PostgresWorkflowControllerOptions,
  ) {
    this.scheduler = new PostgresWorkflowScheduler(repository);
  }

  async drive(dag: V3Dag): Promise<DurableWorkflowPlan> {
    const maxSteps = this.options.maxSteps ?? 100;
    for (let step = 0; step < maxSteps; step++) {
      const plan = await this.scheduler.plan(dag);
      if (plan.actions.length === 0) return plan;
      // Serial first slice: after each action, replay PostgreSQL and ask the
      // upstream scheduler again. This keeps every decision recovery-safe.
      await this.realize(dag, plan.events, plan.actions[0]!);
    }
    throw new Error(`workflow postgres controller: exceeded ${maxSteps} scheduling steps`);
  }

  async resolveWait(
    dag: V3Dag,
    input: ResolvePostgresWorkflowWait,
  ): Promise<DurableWorkflowPlan> {
    const events = await this.repository.readStoredEvents(dag.runId);
    const opened = [...events].reverse().find((event) =>
      event.type === 'gateDispatched' && event.waitId === input.waitId);
    if (!opened || opened.type !== 'gateDispatched') {
      throw new Error(`workflow postgres controller: wait not found: ${input.waitId}`);
    }
    if (events.some((event) => event.type === 'gateResolved' && event.waitId === input.waitId)) {
      throw new Error(`workflow postgres controller: wait already resolved: ${input.waitId}`);
    }
    await this.repository.resolveGate({
      runId: dag.runId,
      waitId: input.waitId,
      resolution: input.resolution,
      by: input.by,
      ...(input.selected ? { selected: input.selected } : {}),
      event: {
        type: 'gateResolved',
        nodeId: opened.nodeId,
        ...(opened.instanceId ? { instanceId: opened.instanceId } : {}),
        waitId: input.waitId,
        resolution: input.resolution,
        by: input.by,
        ...(input.selected ? { selected: input.selected } : {}),
        ...(opened.hostApproval ? { hostApproval: opened.hostApproval } : {}),
      },
    });
    return this.drive(dag);
  }

  private async realize(
    dag: V3Dag,
    events: readonly StoredEvent[],
    action: V3Action,
  ): Promise<void> {
    switch (action.kind) {
      case 'dispatchWork':
        await this.dispatchGoal(dag, events, action);
        return;
      case 'dispatchGate': {
        const node = dag.nodes.find((candidate) => candidate.id === action.nodeId);
        if (!node?.humanGate) {
          throw new Error(`workflow postgres controller: gated node not found: ${action.nodeId}`);
        }
        const gate = normalizeGateWaitInput(node.humanGate);
        const waitId = v3GateWaitId(node.id, action.instanceId);
        await this.repository.openGate({
          runId: dag.runId,
          waitId,
          nodeId: node.id,
          prompt: gate.prompt,
          options: gate.options,
          event: {
            type: 'gateDispatched', nodeId: node.id,
            ...(action.instanceId ? { instanceId: action.instanceId } : {}),
            waitId,
          },
        });
        return;
      }
      case 'completeRunSucceeded':
        await this.repository.append(dag.runId, { type: 'runSucceeded' });
        return;
      case 'completeRunFailed':
        await this.repository.append(dag.runId, {
          type: 'runFailed',
          ...(action.failedNodeId ? { failedNodeId: action.failedNodeId } : {}),
          ...(action.reason ? { reason: action.reason } : {}),
          ...(action.detail ? { detail: action.detail } : {}),
        });
        return;
      case 'completeRunBlocked':
        await this.repository.append(dag.runId, {
          type: 'runBlocked', blockedNodeId: action.blockedNodeId,
        });
        return;
      default:
        throw new Error(`workflow postgres controller: unsupported action in first slice: ${action.kind}`);
    }
  }

  private async dispatchGoal(
    dag: V3Dag,
    events: readonly StoredEvent[],
    action: Extract<V3Action, { kind: 'dispatchWork' }>,
  ): Promise<void> {
    if (action.loop) {
      throw new Error('workflow postgres controller: loop dispatch is not implemented in first slice');
    }
    const node = dag.nodes.find((candidate) => candidate.id === action.nodeId);
    if (!node || !isGoalNode(node)) {
      throw new Error(`workflow postgres controller: goal node not found: ${action.nodeId}`);
    }
    if (!action.instanceId) {
      throw new Error(`workflow postgres controller: dispatch has no instance: ${action.nodeId}`);
    }
    const attemptId = nextAttemptIdFor([...events], action.instanceId);
    const attemptNumber = Number(attemptId.split('/').at(-1));
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
      throw new Error(`workflow postgres controller: invalid attempt id: ${attemptId}`);
    }
    await this.repository.dispatch({
      runId: dag.runId,
      attemptId,
      nodeId: node.id,
      instanceId: action.instanceId,
      attemptNumber,
      executor: this.options.executorId,
      event: {
        type: 'nodeDispatched', nodeId: node.id,
        instanceId: action.instanceId, attemptId,
      },
    });
    const lease = await this.repository.acquireAttempt(
      dag.runId,
      attemptId,
      this.options.holderId,
      this.options.leaseTtlMs ?? 15 * 60_000,
    );
    let result: GoalExecutionResult;
    try {
      result = await this.executeGoal({
        runId: dag.runId,
        node,
        instanceId: action.instanceId,
        attemptId,
        onSandboxCreated: (sandboxId) => this.repository.markAttemptDispatched(lease, sandboxId),
      });
    } catch (error) {
      result = {
        status: 'failed',
        errorCode: 'EXECUTOR_THROWN',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const event = this.resultEvent(node.id, action.instanceId, attemptId, result);
    await this.repository.settleAttempt({
      lease,
      status: result.status === 'succeeded'
        ? 'succeeded'
        : 'failed',
      details: result.details,
      event,
    });
  }

  private resultEvent(
    nodeId: string,
    instanceId: string,
    attemptId: string,
    result: GoalExecutionResult,
  ): Extract<V3Event, { type: 'nodeSucceeded' | 'nodeFailed' | 'nodeBlocked' }> {
    switch (result.status) {
      case 'succeeded':
        return { type: 'nodeSucceeded', nodeId, instanceId, attemptId, manifestPath: result.manifestPath };
      case 'blocked':
        return {
          type: 'nodeBlocked', nodeId, instanceId, attemptId, errorClass: 'workerError',
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          ...(result.message ? { message: result.message } : {}),
        };
      case 'failed':
        return {
          type: 'nodeFailed', nodeId, instanceId, attemptId, errorClass: 'workerError',
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          ...(result.message ? { message: result.message } : {}),
        };
    }
  }
}
