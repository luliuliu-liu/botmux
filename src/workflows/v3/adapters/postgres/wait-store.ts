/** Transaction helpers for durable Workflow v3 human waits. */

import type { PostgresClient } from './event-store.js';

export interface OpenWorkflowWait {
  readonly runId: string;
  readonly waitId: string;
  readonly nodeId: string;
  readonly prompt: string;
  readonly options: readonly string[];
}

export interface ResolveWorkflowWait {
  readonly runId: string;
  readonly waitId: string;
  readonly resolution: 'approved' | 'rejected';
  readonly by: string;
  readonly selected?: string;
}

function required(value: string, name: string): string {
  if (!value.trim()) throw new Error(`workflow postgres wait store: ${name} is required`);
  return value;
}

export async function openWaitInTransaction(
  client: PostgresClient,
  input: OpenWorkflowWait,
): Promise<void> {
  required(input.runId, 'runId');
  required(input.waitId, 'waitId');
  required(input.nodeId, 'nodeId');
  required(input.prompt, 'prompt');
  await client.query(
    `INSERT INTO agent_workflow.workflow_wait
       (run_id, wait_id, node_id, prompt, options, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'pending')`,
    [input.runId, input.waitId, input.nodeId, input.prompt, JSON.stringify(input.options)],
  );
}

export async function resolveWaitInTransaction(
  client: PostgresClient,
  input: ResolveWorkflowWait,
): Promise<void> {
  required(input.runId, 'runId');
  required(input.waitId, 'waitId');
  required(input.by, 'by');
  const resolved = await client.query(
    `UPDATE agent_workflow.workflow_wait
        SET status = $3,
            resolution = $4::jsonb,
            resolved_at = now()
      WHERE run_id = $1 AND wait_id = $2 AND status = 'pending'`,
    [
      input.runId,
      input.waitId,
      input.resolution,
      JSON.stringify({ by: input.by, ...(input.selected ? { selected: input.selected } : {}) }),
    ],
  );
  if ((resolved.rowCount ?? 0) !== 1) {
    throw new Error(`workflow postgres wait store: wait is not pending: ${input.waitId}`);
  }
}
