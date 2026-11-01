import {join} from 'node:path';
import {readV3RunChatBinding} from '../../workflows/v3/daemon-run.js';
import {defaultBaseDir,type RunChatBinding} from '../../workflows/v3/grill-state.js';
import {workflowResourceRequest} from '../../platform/workflow/agent-pool-client.js';
import {RESOURCE_ACTIONS,resourceNonce} from './v3-resource-card.js';
export type ResourceCardDeps={baseDir?:string;driveRun:(runId:string)=>void;canResolve:(binding:RunChatBinding|undefined,operator:string|undefined)=>boolean;request?:typeof workflowResourceRequest};
export const isV3ResourceAction=(action:unknown)=>typeof action==='string'&&RESOURCE_ACTIONS.includes(action);
export async function handleV3ResourceAction(value:any,operator:string|undefined,deps:ResourceCardDeps,form:any){
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId??'')||!/^[0-9a-f-]{36}$/.test(value.jobId??'')||value.nonce!==resourceNonce(value.runId,value.jobId))return {toast:{type:'warning',content:'资源等待卡已失效'}};
 const dir=join(deps.baseDir??defaultBaseDir(),value.runId),binding=readV3RunChatBinding(dir);
 if(!deps.canResolve(binding,operator))return {toast:{type:'warning',content:'你没有权限处理此 Workflow 的资源等待'}};
 try{
  const request=deps.request??workflowResourceRequest;
  const jobs=request(dir).jobs as any[],pending=jobs.find(j=>j.jobId===value.jobId);
  if(!pending){deps.driveRun(value.runId);return {toast:{type:'info',content:'资源等待已处理'}};}
  let body:any;
  if(value.action==='v3_resource_select')body={memberId:form?.memberId};
  else if(value.action==='v3_resource_create'){
   const [modelProfileId,modelId]=JSON.parse(form?.modelChoice??'null');
   body={requestId:value.jobId,create:{displayName:form?.displayName,description:form?.description,agentType:form?.agentType,
    modelProfileId,modelId,cpu:Number(form?.cpu||2),memoryMiB:Number(form?.memoryMiB||4096),mountGlobalReadOnly:form?.mountGlobalReadOnly==='yes',...(form?.hostMountIds===undefined?{}:{hostMountIds:form.hostMountIds})}};
  }
  request(dir,`/${value.jobId}/${value.action==='v3_resource_cancel'?'cancel':'resolve'}`,'POST',body??{});
  deps.driveRun(value.runId);return {toast:{type:'success',content:value.action==='v3_resource_cancel'?'已取消此节点':value.action==='v3_resource_create'?'已提交补建，Agent 就绪后自动继续':'Agent 已加入候选，继续执行'}};
 }catch(error){return {toast:{type:'error',content:`处理未完成，可重试：${error instanceof Error?error.message:String(error)}`}};}
}
