/** Control-only orchestration over the native Skill library. */
import {dirname,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {withFileLock} from '../../utils/file-lock.js';
import {readSkillRegistry} from '../../services/skill-registry-store.js';
import {applyAgentSkillBundle,buildAgentSkillBundle,AgentSkillError,agentSkillRoots} from './agent-skills.js';
type Request=(path:string,method?:string,body?:unknown)=>Promise<{status:number;data:any}>;
export function imageSkillAgents(path='/opt/agent/image.json'):string[]{
 const image=JSON.parse(readFileSync(path,'utf8'));
 const agents=image.agents.map((a:{id:string})=>a.id);
 if(!agents.length||agents.some((id:string)=>!agentSkillRoots[id]))throw new AgentSkillError(409,'当前镜像尚未支持容器全局 Skill');return agents;
}
export function createAgentSkillManagement(botsJsonPath:string,request:Request){
 const home=dirname(dirname(botsJsonPath));
 return {
  async list(){const result=await request('/skill-assignments');if(result.status!==200)throw new AgentSkillError(result.status,result.data.message||'无法读取 Skill 分配');return result.data;},
  async workers(){const result=await request('/skill-sync');if(result.status!==200)throw new AgentSkillError(result.status,result.data.message||'无法读取 Worker 列表');return result.data;},
  async syncInstalled(target:string,input:any){
   if(!Array.isArray(input.names)||!input.names.length||input.names.length>100||input.names.some((name:unknown)=>typeof name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(name)))throw new AgentSkillError(400,'请选择已安装的 Skill');
   const names=[...new Set(input.names as string[])],registry=readSkillRegistry().skills;
   for(const name of names)if(!Object.hasOwn(registry,name))throw new AgentSkillError(409,'存在未安装的 Skill，请刷新');
   // Image-provided linked Skills are already present on all Agent images.
   // Send their names, not external source files: Worker skips existing names
   // and asks for a copied install if the linked Skill is actually missing.
   const bundle=buildAgentSkillBundle(names.filter(name=>registry[name]!.source.type!=='local-link').map(name=>'skill:'+name));
   const result=await request('/skill-sync/'+target,'POST',{revision:input.revision,names,bundle});
   if(result.status!==200)throw new AgentSkillError(result.status,result.data.message||'Skill 同步未确认');return result.data;
  },
  async save(target:string,input:any){
   const perform=async()=>{
    const bundle=buildAgentSkillBundle(input.selectors);
    const result=await request('/skill-assignments/'+target,'PUT',{revision:input.revision,requestId:input.requestId,selectors:input.selectors,bundle});
    if(result.status!==200)throw new AgentSkillError(result.status,result.data.message||'Skill 分配未确认');
    if(target!=='control')return result.data;
    const applied=await applyAgentSkillBundle(home,{revision:result.data.revision,bundle},imageSkillAgents());
    const ack=await request('/skill-assignments/control/ack','POST',{revision:applied.revision,digest:applied.digest,requestId:result.data.requestId});
    if(ack.status!==200)throw new AgentSkillError(ack.status,ack.data.message||'Skill 已落盘，同步确认待重试');return ack.data;
   };
   return target==='control'?withFileLock(join(home,'.botmux','platform','control-skill-operation'),perform):perform();
  },
 };
}
