import {createHash} from 'node:crypto';
import type {ResourceWait} from '../../workflows/v3/execution-backend.js';
import {escapeMd} from './v3-card-common.js';
export const RESOURCE_ACTIONS=['v3_resource_create','v3_resource_select','v3_resource_cancel'];
export const resourceNonce=(run:string,job:string)=>createHash('sha256').update(JSON.stringify(['pool-resource-v1',run,job])).digest('hex').slice(0,24);
export function buildV3ResourceCard(runId:string,wait:ResourceWait,catalog:{agents:any[];models:any[];members:any[];mounts?:any[]}) {
 const value=(action:string)=>({action,runId,jobId:wait.jobId,nonce:resourceNonce(runId,wait.jobId)});
 const input=(name:string,label:string,initial?:string)=>({tag:'input',name,label:{tag:'plain_text',content:label},...(initial?{default_value:initial}:{}),placeholder:{tag:'plain_text',content:label}});
 const select=(name:string,label:string,items:Array<{value:string;text:string}>)=>({tag:'select_static',name,placeholder:{tag:'plain_text',content:label},options:items.slice(0,100).map(i=>({value:i.value,text:{tag:'plain_text',content:i.text.slice(0,160)}}))});
 const submit=(action:string,text:string)=>({tag:'button',name:action,action_type:'form_submit',type:'primary',text:{tag:'plain_text',content:text},value:value(action)});
 return JSON.stringify({config:{wide_screen_mode:true},header:{template:'orange',title:{tag:'plain_text',content:'Workflow 等待 Agent 能力'}},elements:[
  {tag:'div',text:{tag:'lark_md',content:`节点 **${escapeMd(wait.nodeId)}**\n能力需求：${escapeMd((wait.selection as any).requirement)}\n${escapeMd(wait.lastError||'当前候选缺失或不可用，请选择已有 Agent，或补建并加入共享工作区池。')}`}},
  {tag:'form',name:'pool_select',elements:[select('memberId','选择已有成员',catalog.members.filter(m=>m.enabled&&!m.quarantined).map(m=>({value:m.memberId,text:m.displayName+' · '+m.description}))),submit('v3_resource_select','选择并继续')]},
  {tag:'form',name:'pool_create',elements:[
   select('agentType','Agent 类型',catalog.agents.filter(a=>a.supported&&a.id!=='browser').map(a=>({value:a.id,text:a.name}))),
   input('displayName','Agent 名称'),input('description','身份／能力描述'),
   select('modelChoice','模型连接 / 模型',catalog.models.flatMap(m=>(m.modelIds?.length?m.modelIds:['']).map((id:string)=>({value:JSON.stringify([m.profileId,id]),text:m.displayName+(id?' · '+id:'')})))),
   input('cpu','CPU','2'),input('memoryMiB','内存 MiB','4096'),...(catalog.mounts?(catalog.mounts.length?[{...select('hostMountIds','命名全局只读挂载',catalog.mounts.map(m=>({value:m.id,text:'/host/'+m.name}))),tag:'multi_select_static'}]:[]):[select('mountGlobalReadOnly','全局只读目录',[{value:'no',text:'不挂载'},{value:'yes',text:'挂载 /host 只读目录'}])]),
   submit('v3_resource_create','创建、加入池并继续')]},
  {tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:'取消此节点'},value:value('v3_resource_cancel')}]},
 ]});
}
