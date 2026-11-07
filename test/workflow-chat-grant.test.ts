import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {applyWorkflowChatGrant} from '../src/services/workflow-chat-grant.js';
import {WorkflowGrantLeaseStore} from '../src/services/workflow-grant-lease-store.js';
import {requestExactChatGrant} from '../src/cli/exact-chat-grant-client.js';
import {WORKFLOW_CHAT_GRANT_PATH} from '../src/core/workflow-grant-protocol.js';
import type {ExactChatGrantSuccess} from '../src/services/exact-chat-grant.js';
const roots:string[]=[];afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
const identity={receiverLarkAppId:'cli_receiver',chatId:'oc_fixture',subjectOpenId:'ou_subject'};
function setup(){const root=mkdtempSync(join(tmpdir(),'workflow-grant-'));roots.push(root);let granted=false;const primitive=vi.fn(async(input:any)=>{granted=input.operation==='grant';return {ok:true,operation:input.operation,permissionSource:'chatGrant',talkOnly:true,receiverLarkAppId:identity.receiverLarkAppId,chatId:identity.chatId,grantsTalk:granted,grantsOperate:false,subjects:[]} as ExactChatGrantSuccess;});return {deps:{store:new WorkflowGrantLeaseStore(join(root,'leases.json')),primitive,hasGrant:()=>granted},primitive};}
it('真实租约墓碑阻止晚到授予，且旧撤销不删新一代',async()=>{
 const h=setup(),oldId=randomUUID(),newId=randomUUID();
 expect((await applyWorkflowChatGrant({...identity,leaseId:oldId,operation:'revoke'},h.deps)).ok).toBe(true);
 expect(await applyWorkflowChatGrant({...identity,leaseId:oldId,operation:'grant'},h.deps)).toMatchObject({ok:false,error:'workflow_grant_lease_revoked'});expect(h.primitive).not.toHaveBeenCalled();
 expect(await applyWorkflowChatGrant({...identity,leaseId:newId,operation:'grant'},h.deps)).toMatchObject({ok:true,workflowLeaseFenced:true,leaseActive:true,grantsTalk:true});
 await applyWorkflowChatGrant({...identity,leaseId:oldId,operation:'revoke'},h.deps);expect(h.deps.hasGrant()).toBe(true);expect(h.primitive).toHaveBeenCalledTimes(1);
});
it('租约身份绑定，不接受同一ID改接收目标',async()=>{
 const h=setup(),leaseId=randomUUID();await applyWorkflowChatGrant({...identity,leaseId,operation:'grant'},h.deps);
 expect(await applyWorkflowChatGrant({...identity,subjectOpenId:'ou_other',leaseId,operation:'grant'},h.deps)).toMatchObject({ok:false,error:'workflow_grant_lease_identity_conflict'});expect(h.primitive).toHaveBeenCalledTimes(1);
});
it('租约RPC仅走专用HMAC路径，旧接收端缺能力不降级',async()=>{
 const workflowLease={leaseId:randomUUID(),subjectOpenId:identity.subjectOpenId};const input={daemon:{ipcPort:45123,larkAppId:identity.receiverLarkAppId},secret:'fixture-secret',receiverLarkAppId:identity.receiverLarkAppId,chatId:identity.chatId,operation:'grant' as const,workflowLease};
 const unavailable=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({ok:false},{status:404}));await expect(requestExactChatGrant(input,unavailable)).rejects.toThrow();expect(unavailable).toHaveBeenCalledTimes(1);expect(unavailable.mock.calls[0][0]).toBe('http://127.0.0.1:45123'+WORKFLOW_CHAT_GRANT_PATH);
 const confirmed=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({ok:true,...identity,...workflowLease,workflowLeaseFenced:true,leaseActive:true,grantsTalk:true}));expect((await requestExactChatGrant(input,confirmed)).leaseActive).toBe(true);
 const body=JSON.parse(confirmed.mock.calls[0][1]!.body as string);expect(body).toEqual({operation:'grant',receiverLarkAppId:identity.receiverLarkAppId,chatId:identity.chatId,...workflowLease});
 const unfenced=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({ok:true}));await expect(requestExactChatGrant(input,unfenced)).rejects.toThrow();
});
