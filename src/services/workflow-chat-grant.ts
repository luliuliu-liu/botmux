import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {getBot} from '../bot-registry.js';
import {resolveBotmuxDataDir} from '../core/data-dir.js';
import {applyExactChatGrant,type ExactChatGrantFailure} from './exact-chat-grant.js';
import {WorkflowGrantLeaseStore,WorkflowGrantLeaseError} from './workflow-grant-lease-store.js';

export {WORKFLOW_CHAT_GRANT_PATH} from '../core/workflow-grant-protocol.js';
export interface WorkflowChatGrantInput {receiverLarkAppId:string;chatId:unknown;subjectOpenId:unknown;leaseId:unknown;operation:unknown}
export interface WorkflowChatGrantDeps {
 store?:WorkflowGrantLeaseStore;
 primitive?:typeof applyExactChatGrant;
 hasGrant?:(receiver:string,chat:string,subject:string)=>boolean;
}
/** 专用路径不向旧通用授权端点降级；租约撤销不能影响另一代或人工预授。 */
export async function applyWorkflowChatGrant(input:WorkflowChatGrantInput,deps:WorkflowChatGrantDeps={}) {
 if(typeof input.chatId!=='string'||!/^oc_[A-Za-z0-9_-]{1,128}$/.test(input.chatId)||typeof input.subjectOpenId!=='string'||!/^ou_[A-Za-z0-9_-]{1,128}$/.test(input.subjectOpenId)||typeof input.leaseId!=='string'||!['grant','revoke'].includes(String(input.operation)))return {ok:false as const,status:400,error:'invalid_workflow_grant_lease'};
 const receiver=input.receiverLarkAppId,chat=input.chatId,subject=input.subjectOpenId;
 const file=join(resolveBotmuxDataDir(),'workflow-grant-leases',createHash('sha256').update(JSON.stringify([receiver,chat])).digest('hex')+'.json');
 const store=deps.store??new WorkflowGrantLeaseStore(file),primitive=deps.primitive??applyExactChatGrant;
 const hasGrant=()=>deps.hasGrant?deps.hasGrant(receiver,chat,subject):(getBot(receiver).config.chatGrants?.[chat]??[]).includes(subject);
 let rejected:ExactChatGrantFailure|undefined;
 const perform=async(operation:'grant'|'revoke')=>{const result=await primitive({operation,receiverLarkAppId:receiver,chatId:chat,subjectOpenIds:[subject]});if(!result.ok){rejected=result;throw Error('exact_grant_rejected');}};
 try{
  const result=await store.apply({operation:input.operation as 'grant'|'revoke',leaseId:input.leaseId,receiverLarkAppId:receiver,chatId:chat,subjectOpenId:subject},{hasGrant,grant:()=>perform('grant'),revoke:()=>perform('revoke')});
  return {ok:true as const,workflowLeaseFenced:true as const,operation:input.operation,leaseId:input.leaseId,receiverLarkAppId:receiver,chatId:chat,subjectOpenId:subject,leaseActive:result.leaseActive,changed:result.changed,grantsTalk:hasGrant(),grantsOperate:false as const};
 }catch(error){
  if(rejected)return rejected;
  return {ok:false as const,status:error instanceof WorkflowGrantLeaseError&&error.code==='INVALID_INPUT'?400:409,error:error instanceof WorkflowGrantLeaseError?'workflow_grant_'+error.code.toLowerCase():'workflow_grant_failed'};
 }
}
