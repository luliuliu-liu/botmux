import {loadDag} from './dag-loader.js';
import {validateSpec} from './spec.js';
import {readFileSync,existsSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {withFileLockSync} from '../../utils/file-lock.js';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import {readGrillState,defaultBaseDir} from './grill-state.js';
import {operationsRunDir,workflowDiff} from './operations.js';
import {authorizeAdHocRun,hostApproveDag} from './host.js';
import type {BotConfig} from '../../bot-registry.js';
const hash=(path:string)=>{if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw Error('unsafe_approval_artifact');return createHash('sha256').update(readFileSync(path)).digest('hex');};
export function authoringAudit(dir:string,record:Record<string,unknown>){const path=join(dir,'authoring.audit.ndjson');withFileLockSync(path,()=>{if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw Error('unsafe_authoring_audit');const entries=existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];const eventId=record.eventId??createHash('sha256').update(JSON.stringify(record)).digest('hex');if(entries.some(e=>e.eventId===eventId))return;entries.push({schema:'botmux-authoring-audit-v1',...record,eventId,at:new Date().toISOString()});atomicWriteFileSync(path,entries.map(e=>JSON.stringify(e)).join('\n')+'\n',{mode:0o600,durable:true,followTargetSymlink:false});});}
export function requestDagApproval(runId:string,baseDir=defaultBaseDir()){
 const dir=operationsRunDir(runId,baseDir),state=readGrillState(dir);if(state?.status!=='dag_ready'&&state?.status!=='dag_approved')throw Error('dag_not_ready');
 if(!state.chatBinding?.ownerOpenId)throw Error('human_approval_requires_chat_owner');
 return withFileLockSync(join(dir,'authoring-approval'),()=>{
  if(state.status==='dag_ready'){hash(join(dir,'dag.json'));hash(join(dir,'spec.json'));
    const dag=loadDag(join(dir,'dag.json')),spec=validateSpec(JSON.parse(readFileSync(join(dir,'spec.json'),'utf8')));
    atomicWriteFileSync(join(dir,'dag.json'),JSON.stringify(dag,null,2)+'\n',{mode:0o600});atomicWriteFileSync(join(dir,'spec.json'),JSON.stringify(spec,null,2)+'\n',{mode:0o600});
  }
  const specSha256=hash(join(dir,'spec.json')),dagSha256=hash(join(dir,'dag.json')),path=join(dir,'dag.approval.json');
  const existing=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
  if(existing?.status!=='rejected'&&existing?.specSha256===specSha256&&existing?.dagSha256===dagSha256)return existing;
  const value={schema:'botmux-dag-approval-v1',runId,nonce:randomUUID(),status:'pending',specSha256,dagSha256,requestedAt:new Date().toISOString(),binding:state.chatBinding,diff:workflowDiff(runId,baseDir)};
  atomicWriteFileSync(path,JSON.stringify(value),{mode:0o600,durable:true,followTargetSymlink:false});authoringAudit(dir,{type:'dagApprovalRequested',specSha256,dagSha256,by:'agent'});return value;
 });
}
export function approvalCard(record:any){
 const summary={specRequirement:record.diff.specRequirement,specNodes:record.diff.specNodes,changedGoalDetails:record.diff.dagNodes.filter((n:any)=>record.diff.changedGoals.includes(n.id)).map((n:any)=>({id:n.id,goal:n.goal})),addedNodes:record.diff.addedNodes,removedSketches:record.diff.removedSketches,changedGoals:record.diff.changedGoals,unmatchedCapabilities:record.diff.unmatchedCapabilities,nodes:record.diff.dagNodes};
 const text=JSON.stringify(summary,null,2);if(text.length>16000)throw Error('approval_diff_too_large_use_smaller_dag');
 return JSON.stringify({config:{wide_screen_mode:true},header:{template:'blue',title:{tag:'plain_text',content:'Workflow DAG 人工审批'}},elements:[{tag:'div',text:{tag:'plain_text',content:'Run: '+record.runId+'\nSpec SHA256: '+record.specSha256+'\nDAG SHA256: '+record.dagSha256}},{tag:'div',text:{tag:'plain_text',content:text}},{tag:'action',actions:['approve','reject'].map(selected=>({tag:'button',text:{tag:'plain_text',content:selected==='approve'?'批准 DAG':'拒绝'},type:selected==='approve'?'primary':'danger',value:{action:'v3_authoring_'+selected,runId:record.runId,nonce:record.nonce}}))}]});
}
export function verifyDagApproval(dir:string){
 const state=readGrillState(dir);if(state?.approvalPolicy?.dag!=='user')return;const path=join(dir,'dag.approval.json');
 if(!existsSync(path)||lstatSync(path).isSymbolicLink())throw Error('dag_human_approval_required');const r=JSON.parse(readFileSync(path,'utf8'));
 if(r.status!=='approved'||r.byKind!=='user'||r.actor!==state.chatBinding?.ownerOpenId||!r.messageId||r.specSha256!==hash(join(dir,'spec.json'))||r.dagSha256!==hash(join(dir,'dag.json')))throw Error('dag_human_approval_required');
}
/** Called only by the authenticated Lark card-event path, never by CLI input. */
export async function handleAuthoringApproval(value:any,operator:string|undefined,messageId:string|undefined,larkAppId:string|undefined,deps:{baseDir?:string;loadBots:()=>BotConfig[];canResolve:(binding:any,operator:string)=>boolean}){
 try{const dir=operationsRunDir(value.runId,deps.baseDir??defaultBaseDir());return withFileLockSync(join(dir,'authoring-approval'),()=>{
  const path=join(dir,'dag.approval.json');if(lstatSync(path).isSymbolicLink())throw Error('unsafe_approval');const r=JSON.parse(readFileSync(path,'utf8'));
  if(!operator||!messageId||larkAppId!==r.binding.larkAppId||operator!==r.binding.ownerOpenId||!deps.canResolve(r.binding,operator)||r.cardMessageId!==messageId)throw Error('approval_unauthorized');
  if(value.nonce!==r.nonce||r.specSha256!==hash(join(dir,'spec.json'))||r.dagSha256!==hash(join(dir,'dag.json')))throw Error('approval_stale');
  if(r.status==='approved'){authoringAudit(dir,{eventId:r.nonce+':approved',type:'dagApproved',byKind:'user',actor:r.actor,messageId:r.messageId,specSha256:r.specSha256,dagSha256:r.dagSha256});authorizeAdHocRun(dir,deps.loadBots());hostApproveDag(dir);return {toast:{type:'info',content:'DAG 已批准，请执行 workflow start'}};}
  if(r.status!=='pending')throw Error('approval_already_rejected');
  const status=value.action==='v3_authoring_approve'?'approved':'rejected';
  const next={...r,status,byKind:'user',actor:operator,messageId,approvedAt:new Date().toISOString()};atomicWriteFileSync(path,JSON.stringify(next),{mode:0o600,durable:true,followTargetSymlink:false});
  authoringAudit(dir,{eventId:r.nonce+':'+status,type:status==='approved'?'dagApproved':'dagRejected',byKind:'user',actor:operator,messageId,specSha256:r.specSha256,dagSha256:r.dagSha256});
  if(status==='approved'){authorizeAdHocRun(dir,deps.loadBots());hostApproveDag(dir);}
  return {toast:{type:'success',content:status==='approved'?'DAG 已批准，请执行 workflow start':'DAG 已拒绝，可以 revise-dag'}};
 });}catch(e){return {toast:{type:'error',content:e instanceof Error?e.message:'approval_failed'}};}
}
