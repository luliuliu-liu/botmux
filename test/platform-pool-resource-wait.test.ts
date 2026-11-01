import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runWorkflow} from '../src/workflows/v3/runtime.js';
import {validateDag} from '../src/workflows/v3/dag.js';
import {readJournal,appendEvent} from '../src/workflows/v3/journal.js';
import {materialize} from '../src/workflows/v3/state.js';
import {buildArchitectGoal} from '../src/workflows/v3/architect.js';
import {resourceNonce,buildV3ResourceCard} from '../src/im/lark/v3-resource-card.js';
import {handleV3ResourceAction} from '../src/im/lark/v3-resource-card-handler.js';
const selection={poolId:'11111111-1111-1111-1111-111111111111',requirement:'coding',candidateIds:[],reason:'missing skill'};
it('does not dispatch a resource-waiting node or consume its timeout; independent nodes finish',async()=>{
 const base=mkdtempSync(join(tmpdir(),'pool-wait-'));let ready=false;const ran:string[]=[];
 const dag=validateDag({runId:'pool-wait',nodes:[{id:'waiting',type:'goal',goal:'wait',agentSelection:selection,timeoutSec:1},{id:'independent',type:'goal',goal:'run'}]});
 const deps={resolveBotSnapshot:()=>({larkAppId:'fixture',cliId:'pi' as const,workingDir:'/workspace'}),
  prepareResource:({node,attemptId}:any)=>node.id==='waiting'&&!ready?{ready:false,wait:{...selection,selection,jobId:'22222222-2222-2222-2222-222222222222',nodeId:node.id,attemptId,waitReason:'capability'}}:{ready:true},
  runNode:async(req:any)=>{ran.push(req.node.id);mkdirSync(req.outputDir,{recursive:true});const path=join(req.attemptDir,'manifest.json');writeFileSync(path,'{}');return {status:'ok' as const,manifestPath:path};},
  validateManifest:async()=>({ok:true as const,manifest:{schemaVersion:1 as const,status:'ok' as const,summary:'done',files:[]}})};
 try{
  const first=await runWorkflow(dag,deps,{baseDir:base,gateMode:'suspend'});
  expect(first.reason).toBe('awaitingResources');expect(ran).toEqual(['independent']);
  const journal=readJournal(join(base,'pool-wait/journal.ndjson'));expect(journal.some(e=>e.type==='nodeDispatched'&&e.nodeId==='waiting')).toBe(false);
  ready=true;const second=await runWorkflow(dag,deps,{baseDir:base,gateMode:'suspend'});expect(second).toMatchObject({reason:'terminal',runStatus:'succeeded'});expect(ran).toEqual(['independent','waiting']);
 }finally{rmSync(base,{recursive:true,force:true});}
});
it('preserves candidate sets in DAG validation and forbids model overrides',()=>{
 const dag=validateDag({runId:'pool-schema',nodes:[{id:'work',type:'goal',goal:'work',agentSelection:selection}]});
 expect(dag.nodes[0].agentSelection).toEqual(selection);
 expect(()=>validateDag({runId:'pool-schema',nodes:[{id:'work',type:'goal',goal:'work',agentSelection:selection,override:{model:'other'}}]})).toThrow('fixed');
 expect(buildArchitectGoal('/spec','/spec.json',{poolId:selection.poolId,members:[]})).toContain('candidateIds');
});

it('keeps a waiting sibling executable with the same resource identity after blocked retry',async()=>{
 const base=mkdtempSync(join(tmpdir(),'pool-blocked-retry-'));let allowBroken=false,ready=false,repaired=false;const ran:string[]=[],waitingAttempts:string[]=[];
 const dag=validateDag({runId:'pool-blocked-retry',nodes:[{id:'waiting',type:'goal',goal:'wait',agentSelection:selection},{id:'broken',type:'goal',goal:'retry'}]});
 const deps={resolveBotSnapshot:()=>({larkAppId:'fixture',cliId:'pi' as const,workingDir:base}),
  prepareResource:({node,attemptId}:any)=>{if(node.id==='waiting')waitingAttempts.push(attemptId);const available=node.id==='waiting'?ready:allowBroken;return available?{ready:true}:{ready:false,wait:{jobId:'22222222-2222-2222-2222-222222222222',nodeId:node.id,attemptId,poolId:selection.poolId,selection,waitReason:'capacity'}};},
  runNode:async(req:any)=>{ran.push(req.node.id);writeFileSync(join(req.attemptDir,'manifest.json'),'{}');return {status:'ok' as const,manifestPath:join(req.attemptDir,'manifest.json')};},
  validateManifest:async()=>repaired?{ok:true as const,manifest:{schemaVersion:1 as const,status:'ok' as const,summary:'done',files:[]}}:{ok:false as const,problems:['fixture validation failure']}};
 try{
  expect((await runWorkflow(dag,deps,{baseDir:base,gateMode:'suspend'})).reason).toBe('awaitingResources');
  allowBroken=true;expect(await runWorkflow(dag,deps,{baseDir:base,gateMode:'suspend'})).toMatchObject({runStatus:'blocked'});
  const journal=join(base,dag.runId,'journal.ndjson'),blocked=readJournal(journal).find(e=>e.type==='nodeBlocked')!;
  if(blocked.type!=='nodeBlocked')throw Error('missing blocked event');
  appendEvent(journal,{type:'nodeRetryRequested',nodeId:blocked.nodeId,instanceId:blocked.instanceId,nextAttemptId:(blocked.instanceId??blocked.nodeId)+'/attempts/002',by:'fixture'});
  repaired=true;ready=true;expect(await runWorkflow(dag,deps,{baseDir:base,gateMode:'suspend'})).toMatchObject({runStatus:'succeeded'});
  expect(new Set(waitingAttempts).size).toBe(1);expect(ran).toContain('waiting');expect(materialize(readJournal(journal)).nodes.get('waiting')?.status).toBe('done');
 }finally{rmSync(base,{recursive:true,force:true});}
});
it('rejects unauthorized and tampered resource actions before contacting the controller',async()=>{
 const base=mkdtempSync(join(tmpdir(),'resource-card-')),runId='resource-card',jobId='22222222-2222-2222-2222-222222222222',request=vi.fn(),driveRun=vi.fn();
 const value={runId,jobId,nonce:resourceNonce(runId,jobId),action:'v3_resource_create'};
 try{
  const denied=await handleV3ResourceAction(value,'stranger',{baseDir:base,request,driveRun,canResolve:()=>false},{});expect((denied as any).toast.type).toBe('warning');expect(request).not.toHaveBeenCalled();
  await handleV3ResourceAction({...value,nonce:'tampered'},'owner',{baseDir:base,request,driveRun,canResolve:()=>true},{});expect(request).not.toHaveBeenCalled();
  const card=JSON.parse(buildV3ResourceCard(runId,{jobId,nodeId:'work',attemptId:'work/001',waitReason:'capability',poolId:selection.poolId,selection},{agents:[],members:[],models:[]}));
  expect(card.elements.filter((e:any)=>e.tag==='form')).toHaveLength(2);
 }finally{rmSync(base,{recursive:true,force:true});}
});
it('submits an authorized provision with a stable request ID and does not recreate an already resolved wait',async()=>{
 const base=mkdtempSync(join(tmpdir(),'resource-provision-')),runId='resource-create',jobId='22222222-2222-2222-2222-222222222222';
 const value={runId,jobId,nonce:resourceNonce(runId,jobId),action:'v3_resource_create'},driveRun=vi.fn();let pending=true;
 const request=vi.fn((_dir:string,suffix='')=>suffix?{queued:true}:{jobs:pending?[{jobId}]:[]});
 const deps={baseDir:base,driveRun,request,canResolve:()=>true};
 try{
  const form={agentType:'pi',displayName:'Reviewer',description:'Review code',modelChoice:JSON.stringify(['fixture','main']),cpu:'2',memoryMiB:'4096',mountGlobalReadOnly:'no'};
  expect(await handleV3ResourceAction(value,'owner',deps,form)).toMatchObject({toast:{type:'success',content:'已提交补建，Agent 就绪后自动继续'}});
  expect(request.mock.calls[1]).toEqual([join(base,runId),`/${jobId}/resolve`,'POST',{requestId:jobId,create:{agentType:'pi',displayName:'Reviewer',description:'Review code',modelProfileId:'fixture',modelId:'main',cpu:2,memoryMiB:4096,mountGlobalReadOnly:false}}]);
  pending=false;request.mockClear();
  expect(await handleV3ResourceAction(value,'owner',deps,form)).toMatchObject({toast:{type:'info'}});expect(request).toHaveBeenCalledTimes(1);expect(driveRun).toHaveBeenCalledTimes(2);
 }finally{rmSync(base,{recursive:true,force:true});}
});
