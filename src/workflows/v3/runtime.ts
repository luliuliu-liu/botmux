/**
 * Botmux-compatible facade for the shared Node runtime.
 *
 * Existing daemon/CLI callers keep the historical dependency shape while the
 * shared runtime receives an explicit attempt lease provider.
 */

import type { V3Dag } from './dag.js';
import { createBotmuxAttemptLeaseProvider } from './botmux-attempt-lease.js';
import { authorizeChatBoundHostExecution } from './botmux-host-policy.js';
import {
  runWorkflow as runSharedWorkflow,
  type V3RuntimeDeps as SharedRuntimeDeps,
  type V3RuntimeOptions,
  type V3RunOutcome,
} from './shared-node-runtime.js';
import type { AttemptLeaseProvider } from './runtime-host-contract.js';
import {join} from 'node:path';
import {resolveExecutionBackend} from './execution-backend.js';

export {
  classifyTerminal,
  latestAttemptIdFor,
  matchLoopExitWhen,
  mergeNodeCapability,
  nextAttemptIdFor,
  readGoalAsk,
  readRevisitRequest,
  renderGoalFile,
  revisitBudgetStatus,
  validateResult,
} from './shared-node-runtime.js';
export type {
  ResultValidation,
  V3PendingGate,
  V3RunOutcome,
  V3RuntimeOptions,
} from './shared-node-runtime.js';

export interface V3RuntimeDeps
  extends Omit<SharedRuntimeDeps, 'attemptLeaseProvider'> {
  attemptLeaseProvider?: AttemptLeaseProvider;
}

export async function runWorkflow(
  dag: V3Dag,
  deps: V3RuntimeDeps,
  options: V3RuntimeOptions,
): Promise<V3RunOutcome> {
  const backend=resolveExecutionBackend(join(options.baseDir,dag.runId));
  return runSharedWorkflow(dag, {
    ...deps,
    ...(backend?{runNode:backend.runNode}:{}),
    attemptLeaseProvider:
      deps.attemptLeaseProvider ?? backend?.attemptLeaseProvider ?? createBotmuxAttemptLeaseProvider(),
    hostExecutorPolicy:
      deps.hostExecutorPolicy ?? authorizeChatBoundHostExecution,
  }, options);
}
