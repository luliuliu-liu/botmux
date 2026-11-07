import type {StoredEvent} from './event-contract.js';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import {existsSync,lstatSync,readFileSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,sep,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {readJournal} from './journal.js';
import {materialize} from './state.js';
import {readGrillState,defaultBaseDir,birthRun} from './grill-state.js';
import {readAndValidateManifest} from './manifest.js';
import {requestPersistenceSync,PersistenceRequestError} from '../../platform/workflow/sync-request.js';
import {isValidRunId} from './ops-projection.js';
import {parseWorkflowDeliveryMode} from './delivery-policy.js';
import {archivedManifestForClone,archivedArtifactBytes} from '../../platform/workflow/archive-clone.js';
import {validateSpec} from './spec.js';
import type {WorkflowArchiveManifest} from '../../platform/workflow/archive-contract.js';
import {controlRuntime,resolveWorkflowProjectWorkspace} from '../../platform/workflow/agent-pool-client.js';
import {writeProjectWorkspaceSelection} from '../../platform/workflow/project-workspace.js';
export function operationsRunDir(runId:string,baseDir=defaultBaseDir()){
 if(!isValidRunId(runId))throw Error('invalid_run_id');const root=resolve(baseDir),path=join(root,runId);
 safeFile(root,path,true);return path;
}
function safeFile(root:string,path:string,directory=false){
 const rel=relative(resolve(root),resolve(path));if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw Error('path_outside_run');
 let current=resolve(root);if(lstatSync(current).isSymbolicLink())throw Error('unsafe_run_path');
 for(const part of rel.split(sep)){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('unsafe_run_path');}
 const stat=lstatSync(path);if(directory?!stat.isDirectory():!stat.isFile())throw Error('unsafe_run_file');return stat;
}
const json=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
export function operationEvents(runDir:string):StoredEvent[]{
 const path=join(runDir,'journal.ndjson');
 if(existsSync(join(runDir,'journal.api.json')))return readJournal(path);
 // Authoring views must never register/freeze a DAG through a read operation.
 if(!existsSync(path))return [];safeFile(runDir,path);const raw=readFileSync(path,'utf8'),lines=raw.split('\n'),events:StoredEvent[]=[];
 for(let i=0;i<lines.length;i++){if(!lines[i].trim())continue;try{events.push(JSON.parse(lines[i]));}catch(e){if(i===lines.length-1&&!raw.endsWith('\n'))break;throw e;}}
 return events;
}

export const NEXT_ACTION:Record<string,string>={grilling:'Edit spec.md, then workflow spec-finalize',spec_ready:'workflow approve-spec (agent confirmation)',spec_approved:'workflow architect',architect_running:'Wait for architect or recover architect',dag_ready:'workflow diff, then workflow approve-dag (request human approval)',dag_approved:'workflow start',blocked:'Review error, then workflow retry or workflow clone',failed:'Review logs, then workflow clone',cancelled:'workflow clone',succeeded:'workflow artifacts'};
export function workflowStatus(runId:string,baseDir=defaultBaseDir()){
 const archive=archivedManifestForClone(runId);if(archive)return {runId,runStatus:archive.summary.runStatus,phase:'archived',nextAction:'clone 新ID并重新审批',blockedNodeId:null,resources:[],nodes:[],jobs:archive.summary.jobs,reportDelivery:archive.summary.reportDelivery,authoringApprovals:archive.approvals,lineage:archive.lineage,eventCount:null,readOnly:true,logsArchived:false};
 const runDir=operationsRunDir(runId,baseDir),grill=readGrillState(runDir),events=operationEvents(runDir);
 const started=events.some(e=>e.type==='runStarted'),snap=started?materialize(events):undefined;
 let remote:any={jobs:[],reportDelivery:{status:'not_applicable'}};const descriptor=join(runDir,'journal.api.json');
 if(existsSync(descriptor)){safeFile(runDir,descriptor);let identity=json(descriptor);
  try{remote=requestPersistenceSync({...identity,path:'/runs/'+runId+'/operations',method:'GET'});}catch(e){
    if(!(e instanceof PersistenceRequestError)||e.status!==401)throw e;
    const registry=json(resolve(baseDir,'../platform/workflow-storage.json'));if(registry.baseUrl!==identity.baseUrl)throw Error('workflow_storage_endpoint_changed');
    const issued=requestPersistenceSync({...registry,path:'/runs/'+runId+'/session',method:'POST',body:{}});identity={...identity,token:issued.token,expiresAt:issued.expiresAt};
    atomicWriteFileSync(descriptor,JSON.stringify(identity),{mode:0o600,followTargetSymlink:false});remote=requestPersistenceSync({...identity,path:'/runs/'+runId+'/operations',method:'GET'});
  }
}
 const runStatus=snap?.runStatus??grill?.status??'unknown';if(runStatus==='unknown')throw Error('run_state_unavailable');
 if(existsSync(descriptor)&&json(descriptor).conventionsVersion!==1&&!remote.reportDelivery)remote.reportDelivery={status:'not_applicable'};
 const jobs=(remote.jobs??[]).map((j:any)=>({jobId:j.jobId,attemptId:j.attemptId,state:j.state,waitReason:j.waitReason,lastError:j.lastError,runtime:j.runtime??null}));
 if(existsSync(join(runDir,'authoring.audit.ndjson')))safeFile(runDir,join(runDir,'authoring.audit.ndjson'));
 const authoring=existsSync(join(runDir,'authoring.audit.ndjson'))?readFileSync(join(runDir,'authoring.audit.ndjson'),'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 return {runId,runStatus,phase:started?'execution':'authoring',nextAction:NEXT_ACTION[runStatus]??'workflow watch',blockedNodeId:snap?.blockedNodeId??null,
  resources:snap?.resources??[],nodes:snap?[...snap.nodes].map(([id,s])=>({id,status:s.status,attemptId:snap.attempts.get(id)})):[],jobs,reportDelivery:remote.reportDelivery??null,
  authoringApprovals:authoring,lineage:existsSync(join(runDir,'lineage.json'))?(safeFile(runDir,join(runDir,'lineage.json')),json(join(runDir,'lineage.json'))):null,eventCount:events.length};
}
export function workflowDiff(runId:string,baseDir=defaultBaseDir()){
 const dir=operationsRunDir(runId,baseDir);safeFile(dir,join(dir,'spec.json'));safeFile(dir,join(dir,'dag.json'));const spec=json(join(dir,'spec.json')),dag=json(join(dir,'dag.json'));
 const sketches=spec.nodes??[];const flatten=(nodes:any[],parent=''):any[]=>nodes.flatMap(n=>[{...n,id:parent+n.id},...(n.type==='loop'?flatten(n.body?.nodes??[],parent+n.id+'/'):[])]);const goals=flatten(dag.nodes??[]).map((n:any)=>({id:n.id,type:n.type,goal:n.goal,depends:n.depends??[],inputs:n.inputs??[],outputs:n.outputs??{},humanGate:n.humanGate??null,requiredMountNames:n.agentSelection?.requiredMountNames??[],requiredPaths:n.agentSelection?.requiredPaths??[],candidateIds:n.agentSelection?.candidateIds??[]}));
 return {runId,deliveryMode:parseWorkflowDeliveryMode(spec.deliveryMode)??'feishu-doc',specRequirement:spec.requirement,specNodes:sketches,dagNodes:goals,addedNodes:goals.filter((n:any)=>!sketches.some((s:any)=>s.sketchId===n.id)).map((n:any)=>n.id),removedSketches:sketches.filter((s:any)=>!goals.some((n:any)=>n.id===s.sketchId)).map((s:any)=>s.sketchId),changedGoals:goals.filter((n:any)=>sketches.some((s:any)=>s.sketchId===n.id&&s.goal!==n.goal)).map((n:any)=>n.id),unmatchedCapabilities:goals.filter((n:any)=>n.type==='goal'&&n.candidateIds.length===0).map((n:any)=>n.id)};
}
export async function workflowArtifacts(runId:string,baseDir=defaultBaseDir()){
 const archive=archivedManifestForClone(runId);if(archive)return archive.files.map(({blob,...file})=>({...file,sourcePath:'',archiveRunId:runId}));
 const dir=operationsRunDir(runId,baseDir),events=operationEvents(dir),items:any[]=[];
 for(const e of events){if(e.type!=='nodeSucceeded')continue;
  const manifest=resolve(dir,e.manifestPath),work=join(manifest.slice(0,manifest.lastIndexOf(sep)),'work');safeFile(dir,manifest);safeFile(dir,work,true);
  const parsed=await readAndValidateManifest(manifest,work);
  for(const file of parsed.files){const path=resolve(work,file.path);if(file.kind==='directory')continue;safeFile(dir,path);
   const key=createHash('sha256').update(JSON.stringify([e.attemptId,file.path,file.sha256])).digest('hex');
   items.push({key,nodeId:e.nodeId,attemptId:e.attemptId,path:file.path,bytes:file.bytes,sha256:file.sha256,kind:file.kind,sourcePath:path});
  }
  const runtimePath=join(manifest.slice(0,manifest.lastIndexOf(sep)),'runtime.json');
  if(existsSync(runtimePath)){safeFile(dir,runtimePath);const data=readFileSync(runtimePath),sha256=createHash('sha256').update(data).digest('hex'),key=createHash('sha256').update(e.attemptId+'/platform-runtime').digest('hex');items.push({key,nodeId:e.nodeId,attemptId:e.attemptId,path:'runtime.json',bytes:data.length,sha256,kind:'json',sourcePath:runtimePath,origin:'platform'});}
 }
 return items;
}
export function publicArtifacts(items:Awaited<ReturnType<typeof workflowArtifacts>>){return items.map(({sourcePath,archiveRunId,...v})=>v);}
export async function exportWorkflowArtifacts(runId:string,destination:string,baseDir=defaultBaseDir()){
 const items=await workflowArtifacts(runId,baseDir),requested=resolve(destination),parent=dirname(requested);mkdirSync(parent,{recursive:true});const target=join(realpathSync(parent),basename(requested)),dir=realpathSync(operationsRunDir(runId,baseDir));
 if(target===dir||target.startsWith(dir+sep))throw Error('export_destination_inside_run');
 let p:string=sep;for(const part of target.split(sep).filter(Boolean)){p=join(p,part);if(existsSync(p)){if(!lstatSync(p).isDirectory()||lstatSync(p).isSymbolicLink())throw Error('unsafe_export_destination');}else mkdirSync(p,{mode:0o700});}
 const save=(out:string,data:Buffer|string)=>{if(existsSync(out)){if(lstatSync(out).isSymbolicLink()||!lstatSync(out).isFile()||!readFileSync(out).equals(Buffer.from(data)))throw Error('export_content_conflict');}else writeFileSync(out,data,{flag:'wx',mode:0o600});};
 const exported=items.map(item=>({...item,originalPath:item.path,path:item.key+'-'+item.path.split('/').at(-1)}));
 for(const item of exported)save(join(target,item.path),artifactBytes(item));
 save(join(target,'manifest.json'),JSON.stringify({schema:'botmux-deliverables-v1',runId,files:publicArtifacts(exported)},null,2)+'\n');return publicArtifacts(exported);
}
export function workflowLogs(runId:string,node:string,{baseDir=defaultBaseDir(),stream='stdout',tail=80,attempt}:{baseDir?:string;stream?:string;tail?:number;attempt?:string}={}){
 if(archivedManifestForClone(runId))throw Error('not_archived: 原始日志未包含在归档中');
 if(!['stdout','stderr'].includes(stream)||!Number.isSafeInteger(tail)||tail<1||tail>10000)throw Error('invalid_log_options');
 const dir=operationsRunDir(runId,baseDir),events=operationEvents(dir);
 const event=[...events].reverse().find(e=>e.type==='nodeDispatched'&&e.nodeId===node&&(!attempt||e.attemptId===attempt));
 if(!event||event.type!=='nodeDispatched')throw Error('node_attempt_not_found');
 const path=resolve(dir,event.attemptId,stream+'.log');safeFile(dir,path);return readFileSync(path,'utf8').split('\n').slice(-tail).join('\n');
}
export async function cloneArchivedWorkflow(archive:WorkflowArchiveManifest,{baseDir=defaultBaseDir(),goal,poolId}:{baseDir?:string;goal?:string;poolId?:string}={}){
 const {assertWorkflowPrincipal,chatBindingFromEnv}=await import('./host.js');const current=chatBindingFromEnv();
 if(archive.chatBinding===undefined)throw Error('archive_caller_binding_unknown');
 assertWorkflowPrincipal(archive.runId,archive.chatBinding??undefined,current);
 const workspace=controlRuntime()?await resolveWorkflowProjectWorkspace(poolId??''):undefined;
 const spec=validateSpec(archive.spec);const born=birthRun({baseDir,goal:goal??spec.title,chatBinding:current??archive.chatBinding??undefined});
 if(workspace)writeProjectWorkspaceSelection(born.runDir,workspace);
 writeFileSync(join(born.runDir,'spec.md'),'# 归档运行的新草稿\n\n```json\n'+JSON.stringify({...spec,runId:born.runId},null,2)+'\n```\n',{mode:0o600});
 const lineage={schema:'botmux-run-lineage-v1',parentRunId:archive.runId,supersedes:archive.runId,sourceDagSha256:createHash('sha256').update(JSON.stringify(archive.dag)).digest('hex'),sourceArchive:true};
 writeFileSync(join(born.runDir,'lineage.json'),JSON.stringify(lineage,null,2)+'\n',{flag:'wx',mode:0o600});return {...born,lineage};
}
export async function cloneWorkflow(runId:string,{baseDir=defaultBaseDir(),goal,poolId}:{baseDir?:string;goal?:string;poolId?:string}={}){
 const archive=archivedManifestForClone(runId);if(archive)return cloneArchivedWorkflow(archive,{baseDir,goal,poolId});
 const workspace=controlRuntime()?await resolveWorkflowProjectWorkspace(poolId??''):undefined;
 const {assertWorkflowHostCaller,chatBindingFromEnv}=await import('./host.js');const source=operationsRunDir(runId,baseDir);assertWorkflowHostCaller(source,chatBindingFromEnv());const old=readGrillState(source),born=birthRun({baseDir,goal:goal??old?.goal??'Workflow revision',chatBinding:old?.chatBinding});
 if(workspace)writeProjectWorkspaceSelection(born.runDir,workspace);
 if(existsSync(join(source,'dag.json')))safeFile(source,join(source,'dag.json'));const origin=join(source,'spec.md');if(existsSync(origin)){safeFile(source,origin);writeFileSync(join(born.runDir,'spec.md'),readFileSync(origin),{mode:0o600});}
 const lineage={schema:'botmux-run-lineage-v1',parentRunId:runId,supersedes:runId,sourceDagSha256:existsSync(join(source,'dag.json'))?createHash('sha256').update(readFileSync(join(source,'dag.json'))).digest('hex'):null};
 writeFileSync(join(born.runDir,'lineage.json'),JSON.stringify(lineage,null,2)+'\n',{flag:'wx',mode:0o600});return {...born,lineage};
}

export function workflowPreflight(runId:string,baseDir=defaultBaseDir()){
 const dir=operationsRunDir(runId,baseDir),dag=json(join(dir,'dag.json'));
 const registryPath=resolve(baseDir,'../platform/workflow-storage.json');
 const registry=existsSync(registryPath)?json(registryPath):null;
 const nodes=(dag.nodes??[]).flatMap((n:any)=>n.type==='loop'?[...(n.body?.nodes??[])]:[n]);
 const checks=nodes.filter((n:any)=>n.type==='goal'&&n.agentSelection?.requiredPaths?.length).map((n:any)=>{
  if(!registry)throw Error('preflight_registry_unavailable');
  const s=n.agentSelection;return {nodeId:n.id,...requestPersistenceSync({...registry,path:'/agent-pools/'+s.poolId+'/input-preflight',method:'POST',body:{candidateIds:s.candidateIds,requiredPaths:s.requiredPaths}})};
 });
 return {runId,ok:checks.every((c:any)=>c.ok),checks};
}

export function artifactBytes(item:{sourcePath:string;sha256:string;archiveRunId?:string;key?:string}){if(item.archiveRunId&&item.key){const result=archivedArtifactBytes(item.archiveRunId,item.key),bytes=Buffer.from(result.data,'base64');if(bytes.toString('base64')!==result.data||bytes.length!==result.bytes||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('archive_artifact_corrupt');return bytes;}if(lstatSync(item.sourcePath).isSymbolicLink())throw Error('unsafe_artifact');const data=readFileSync(item.sourcePath);if(createHash('sha256').update(data).digest('hex')!==item.sha256)throw Error('artifact_changed');return data;}
