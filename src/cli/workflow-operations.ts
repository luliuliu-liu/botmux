import {writeFileSync,readFileSync} from 'node:fs';
import {defaultBaseDir} from '../workflows/v3/grill-state.js';
import {workflowStatus,workflowDiff,workflowArtifacts,publicArtifacts,exportWorkflowArtifacts,workflowLogs,workflowPreflight,cloneWorkflow,operationsRunDir,artifactBytes,operationEvents} from '../workflows/v3/operations.js';
import {join} from 'node:path';
export const OPERATION_COMMANDS=new Set(['status','wait','watch','logs','artifacts','export','diff','clone','revise','spec-validate','preflight']);
export const WORKFLOW_HELP=`Workflow authoring: new "goal" → edit spec.md → spec-finalize → approve-spec → architect → diff → approve-dag → start
Spec confirmation is agent review; new managed DAG approval requires the initiating user card.
Run operations:
 status <runId> [--json]              phase, nextAction, attempts, resources, delivery
 wait <runId> [--timeout <seconds>] [--delivery]  0 success, 1 failed, 2 needs input/blocked, 3 cancelled, 4 timeout, 5 query error
 watch <runId> [--timeout <seconds>]  ordered events; stops at terminal/blocked
 logs <runId> <nodeId> [--stream stdout|stderr] [--tail N] [--attempt <attemptId>]
 artifacts <runId> [--json] [--download <key> --output <file>]
 export <runId> --output <new-directory>   validated files and deliverables manifest
 clone|revise <runId>                 new draft with parent lineage; old run unchanged
 diff <runId>                        spec goals vs DAG, edges, outputs, gates, mounts
 preflight <runId>                   inspect declared mounted inputs before start
 spec-validate <runId>               validate spec.md without finalizing
 retry <runId> [--node id]            same frozen DAG, new attempt/job/workDir; does not change inputs or mounts automatically
All commands support --help before accessing files, identities or network. --base-dir selects a local run root.
`;
export async function cmdWorkflowOperations(sub:string,rest:string[]){
 const get=(key:string)=>{const i=rest.indexOf(key);return i<0?undefined:rest[i+1];};
 const runId=rest[0];if(!runId||runId.startsWith('-'))throw Error('runId required');const baseDir=get('--base-dir')??defaultBaseDir();const {assertWorkflowHostCaller,chatBindingFromEnv}=await import('../workflows/v3/host.js');assertWorkflowHostCaller(operationsRunDir(runId,baseDir),chatBindingFromEnv());
 if(sub==='spec-validate'){const {extractSpecJsonBlock,validateSpec}=await import('../workflows/v3/spec.js');const dir=operationsRunDir(runId,baseDir);const draft=extractSpecJsonBlock(readFileSync(join(dir,'spec.md'),'utf8')) as Record<string,unknown>;const spec=validateSpec({...draft,runId});console.log(JSON.stringify({valid:true,nodes:spec.nodes.length}));return;}
 if(sub==='preflight'){const v=workflowPreflight(runId,baseDir);console.log(JSON.stringify(v,null,2));if(!v.ok)process.exitCode=2;return;}
 if(sub==='status'){console.log(JSON.stringify(workflowStatus(runId,baseDir),null,2));return;}
 if(sub==='diff'){console.log(JSON.stringify(workflowDiff(runId,baseDir),null,2));return;}
 if(sub==='clone'||sub==='revise'){const {runId:newId,runDir,lineage}=await cloneWorkflow(runId,{baseDir,goal:get('--goal')});console.log(JSON.stringify({runId:newId,runDir,lineage,nextAction:'Edit spec.md, then workflow spec-finalize'}));return;}
 if(sub==='logs'){if(!rest[1]||rest[1].startsWith('-'))throw Error('nodeId required');console.log(workflowLogs(runId,rest[1],{baseDir,stream:get('--stream')??'stdout',tail:Number(get('--tail')??80),attempt:get('--attempt')}));return;}
 if(sub==='export'){const out=get('--output');if(!out)throw Error('--output required');console.log(JSON.stringify({files:await exportWorkflowArtifacts(runId,out,baseDir)}));return;}
 if(sub==='artifacts'){const items=await workflowArtifacts(runId,baseDir),key=get('--download');if(key){const found=items.find(f=>f.key===key),out=get('--output');if(!found||!out)throw Error('artifact key and --output required');writeFileSync(out,artifactBytes(found),{flag:'wx',mode:0o600});}else console.log(JSON.stringify({files:publicArtifacts(items)},null,2));return;}
 const timeout=Number(get('--timeout')??0);if(!Number.isFinite(timeout)||timeout<0)throw Error('invalid_timeout');let after=0;const deadline=timeout?Date.now()+timeout*1000:Infinity;
 for(;;){let status;try{status=workflowStatus(runId,baseDir);}catch(error){process.exitCode=5;throw error;}
  if(sub==='watch'){const events=operationEvents(operationsRunDir(runId,baseDir));for(const e of events.slice(after))console.log(JSON.stringify(e));after=events.length;}
  const state=status.runStatus;let code:number|undefined;if(state==='failed')code=1;else if(state==='cancelled')code=3;else if(state==='blocked'||status.phase==='authoring')code=2;
  else if(state==='succeeded'){const d=status.reportDelivery?.status;if(!rest.includes('--delivery')||d==='succeeded'||d==='not_applicable')code=0;else if(['creation_unknown','ambiguous_report','invalid_report','awaiting_configuration','awaiting_login'].includes(d))code=2;}
  if(code!==undefined){console.log(JSON.stringify(status));process.exitCode=code;return;}
  if(Date.now()>=deadline){console.log(JSON.stringify({runId,status:state,error:'wait_timeout',cancelled:false}));process.exitCode=4;return;}
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
}
