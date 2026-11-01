import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDag } from '../src/workflows/v3/dag.js';
import { runWorkflow } from '../src/workflows/v3/runtime.js';
import { assertPoolExecutionAvailable } from '../src/workflows/v3/pool-execution-policy.js';
import { configureExecutionBackend } from '../src/workflows/v3/execution-backend.js';

const selection = { poolId: '11111111-1111-1111-1111-111111111111', requirement: 'code', candidateIds: [], reason: 'missing' };
afterEach(() => configureExecutionBackend(undefined));
it('rejects a pool DAG before any local session or journal is created', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'pool-policy-'));
  const runNode = vi.fn();
  const dag = validateDag({ runId: 'pool-required', nodes: [{ id: 'code', type: 'goal', goal: 'code', agentSelection: selection }] });
  try {
    await expect(runWorkflow(dag, { runNode, resolveBotSnapshot: () => ({ larkAppId: 'fixture', cliId: 'pi', workingDir: baseDir }), validateManifest: vi.fn() }, { baseDir }))
      .rejects.toThrow('agent_pool_backend_required');
    expect(runNode).not.toHaveBeenCalled();
    expect(existsSync(join(baseDir, dag.runId))).toBe(false);
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
});
it('requires resource admission for pool nodes nested in a loop', () => {
  const dag = { runId: 'loop-pool', nodes: [{ id: 'loop', type: 'loop', body: { nodes: [{ id: 'code', type: 'goal', agentSelection: selection }] } }] } as any;
  expect(() => assertPoolExecutionAvailable(dag)).toThrow('agent_pool_backend_required');
  expect(() => assertPoolExecutionAvailable(dag, { prepareResource: () => ({ ready: true }) })).not.toThrow();
});
it('preserves ordinary local Workflow execution', () => {
  expect(() => assertPoolExecutionAvailable(validateDag({ runId: 'local', nodes: [{ id: 'code', type: 'goal', goal: 'code' }] }))).not.toThrow();
});
