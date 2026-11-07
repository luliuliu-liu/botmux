import { describe, expect, it } from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import { validateDag, isGoalNode, isLoopNode } from '../src/workflows/v3/dag.js';
import { bindDagToSelectedPool } from '../src/workflows/v3/library-materialize.js';
import type { ProjectWorkspaceBinding } from '../src/platform/workflow/project-workspace.js';
import { nextLaunchStep } from '../src/workflows/v3/draft-launch.js';
import {recordDagApprovalCard} from '../src/workflows/v3/authoring-approval.js';

const POOL = '11111111-1111-1111-1111-111111111111';
const OLD_POOL = '22222222-2222-2222-2222-222222222222';
const KEEP = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const workspace: ProjectWorkspaceBinding = {
  schema: 'workflow-project-workspace-v1', poolId: POOL, kind: 'volume', claim: 'project',
  executionMode: 'pool', controlRelativeRoot: '', controlRoot: { kind: 'volume', claim: 'project' },
  accessEvidence:{sameClaim:true}, bindingHash: 'a'.repeat(64),
};

const oldSelection = {
  poolId: OLD_POOL, requirement: 'typescript', candidateIds: [KEEP, FOREIGN], reason: '旧池候选',
};

describe('managed Workflow pool binding', () => {
  it('rebinds top-level and loop goals and drops candidates outside the selected pool', () => {
    const dag = validateDag({
      schemaVersion: 2,
      runId: 'managed-pool',
      nodes: [
        { id: 'prepare', type: 'goal', goal: 'prepare', agentSelection: oldSelection },
        {
          id: 'fix', type: 'loop', maxIterations: 2, depends: ['prepare'], inputs: [{ from: 'prepare' }],
          body: { nodes: [
            { id: 'work', type: 'goal', goal: 'work' },
            {
              id: 'check', type: 'goal', goal: 'check', depends: ['work'], inputs: [{ from: 'work' }],
              resultSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
              agentSelection: oldSelection,
            },
          ] },
          exit: { node: 'check', when: { path: 'result.ok', equals: true } },
          output: { from: 'work' },
        },
      ],
    });

    const rebound = bindDagToSelectedPool(dag, workspace, [{ memberId: KEEP }]);
    const prepare = rebound.nodes[0]!;
    const loop = rebound.nodes[1]!;
    expect(isGoalNode(prepare) && prepare.agentSelection).toMatchObject({
      poolId: POOL, requirement: 'typescript', candidateIds: [KEEP], reason: '旧池候选',
    });
    expect(isLoopNode(loop)).toBe(true);
    if (!isLoopNode(loop)) throw new Error('expected loop');
    expect(loop.body.nodes.map((node) => node.agentSelection)).toEqual([
      expect.objectContaining({ poolId: POOL, requirement: 'work', candidateIds: [] }),
      expect.objectContaining({ poolId: POOL, requirement: 'typescript', candidateIds: [KEEP] }),
    ]);
  });

  it('records one approval card idempotently and rejects a conflicting resend', () => {
    const base=mkdtempSync(join(tmpdir(),'approval-card-')),runId='approval-run',dir=join(base,runId);mkdirSync(dir);
    const nonce='33333333-3333-4333-8333-333333333333';
    writeFileSync(join(dir,'dag.approval.json'),JSON.stringify({nonce,status:'pending'}));
    try{
      expect(recordDagApprovalCard(runId,nonce,'om_card',base).cardMessageId).toBe('om_card');
      expect(recordDagApprovalCard(runId,nonce,'om_card',base).cardMessageId).toBe('om_card');
      expect(()=>recordDagApprovalCard(runId,nonce,'om_other',base)).toThrow('approval_card_conflict');
      expect(JSON.parse(readFileSync(join(dir,'dag.approval.json'),'utf8')).cardMessageId).toBe('om_card');
    }finally{rmSync(base,{recursive:true,force:true});}
  });

  it('pauses after the root until the card approves, and never advances a rejection', () => {
    const base:any={chat:{initiator:'joined'},root:{messageId:'om_root'},approval:{state:'pending'},grants:{}};
    expect(nextLaunchStep(base,{flowRevision:0,targets:[]})).toBe('approval');
    expect(nextLaunchStep({...base,approval:{state:'rejected'}},{flowRevision:0,targets:[]})).toBe('approval');
    expect(nextLaunchStep({...base,approval:{state:'approved'}},{flowRevision:0,targets:[]})).toBe('migrate');
  });
});
