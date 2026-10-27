/** Container-local Control Agent lifecycle. No upstream host behavior changes. */
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {withFileLock} from '../../utils/file-lock.js';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import {readBotsJsonOrEmpty,mutateBotsJsonAtomic} from '../../setup/bots-store.js';
import {readContainerAgentEnvironment,readContainerAgentModel,agentEnvironmentKeys,writeContainerAgentEnvironment} from './container-agent-files.mjs';
import {proxyFile,proxyEnvironment,proxyEnvironmentKeys} from './container-proxy.mjs';
import {writeNativeAgentModel} from './native-worker-config.js';
export class LocalControlError extends Error{constructor(readonly status:number,message:string){super(message);}}
type Result={status:number;data:any};
type Dependencies={botsJsonPath:string;request:(path:string,method?:string,body?:unknown)=>Promise<Result>;
 stop:(id:string)=>Promise<{ok:boolean}>;start:(id:string)=>Promise<{ok:boolean}>;isStopped:(id:string)=>Promise<boolean>;busy:(ids:string[])=>Promise<boolean>;
 changeCli?:(id:string,cli:string)=>Promise<Result>};
const types=['pi','codex','claude-code','zcode'];
export function createLocalControlAgent(deps:Dependencies){
 const home=dirname(dirname(deps.botsJsonPath)),directory=join(home,'.botmux','platform');mkdirSync(directory,{recursive:true,mode:0o700});
 const controlId=process.env.BOTMUX_PLATFORM_GATEWAY_ID||'local-gateway';
 const prefix='/local-agents/'+encodeURIComponent(controlId);
 const file=(type:string)=>join(directory,`local-agent-${type}.json`);
 const meta=(type:string)=>existsSync(file(type))?JSON.parse(readFileSync(file(type),'utf8')):null;
 const allBots=()=>readBotsJsonOrEmpty(deps.botsJsonPath);
 const credential=(type:string)=>existsSync(type==='traex'?join(home,'.trae','cli','auth.json'):type==='codex'?join(home,'.codex','auth.json'):type==='claude-code'?join(home,'.claude','.credentials.json'):join(home,'.pi','agent','auth.json'));
 const requireType=(type:string)=>{if(!types.includes(type))throw new LocalControlError(400,'本地镜像支持 Pi、Codex、Claude Code、ZCode');};
 const ownerPath=join(directory,'local-oauth-owner.json');
 let owner:any=existsSync(ownerPath)?JSON.parse(readFileSync(ownerPath,'utf8')):null,oauth:any,restoring:Promise<void>|undefined;
 const saveOwner=()=>atomicWriteFileSync(ownerPath,JSON.stringify(owner),{mode:0o600});
 async function loginManager(){
  if(oauth)return;
  const modulePath='/opt/agent/native-oauth.mjs';
  const {createNativeOAuth}=await import(pathToFileURL(modulePath).href);
  oauth=createNativeOAuth({home,configuration:()=>owner?{agentType:owner.agentType,generation:'local-control',revision:owner.revision,model:{authMethod:'oauth'}}:null,
   pause:async()=>{
    owner.appIds=allBots().filter(b=>b.cliId===owner.agentType).map(b=>b.larkAppId);saveOwner();
    if(await deps.busy(owner.appIds))throw new LocalControlError(409,'本地 Agent 正忙，不能发起登录');
    for(const id of owner.appIds)if(!(await deps.stop(id)).ok)throw new LocalControlError(409,'本地 Bot 停止未确认');
   },resume:async()=>{for(const id of owner?.appIds||[])if(!(await deps.start(id)).ok)throw new LocalControlError(409,'本地 Bot 恢复未确认，请重试关闭登录');},
  });
  restoring=oauth.restore();await restoring;
 }
 async function closeWorkbench(){
  if(!owner?.workbenchGeneration)return;
  const result=await deps.request(`/local-login-workbench/${owner.loginId}`,'DELETE',{});
  if(result.status!==200||result.data.closed!==true)throw new LocalControlError(502,'登录工作台关闭未确认，请重试取消或关闭');
  delete owner.workbenchGeneration;delete owner.profileId;saveOwner();
 }
 async function ensureNoLogin(){if(owner){await loginManager();await restoring;if(oauth.busy())throw new LocalControlError(409,'本地原生登录仍在进行，请先完成或取消登录');}}
 return {
  async upgrade(input?:any){
   if(input===undefined){const result=await deps.request('/control-upgrade');return result.data;}
   if(input.confirmRestart!==true)throw new LocalControlError(400,'请确认重启 Dev Agent');
   return withFileLock(join(directory,'local-agent-operation'),async()=>{
    await ensureNoLogin();const ids=allBots().map(bot=>bot.larkAppId);
    if(await deps.busy(ids))throw new LocalControlError(409,'Agent 正忙，空闲后再升级');
    for(const id of ids)if(!(await deps.stop(id)).ok)throw new LocalControlError(409,'Bot 停止未确认');
    const result=await deps.request('/control-upgrade','POST',input);
    if(result.status!==202){for(const id of ids)await deps.start(id);throw new LocalControlError(result.status,result.data.message||'升级请求未确认');}
    return result.data;
   });
  },
  async proxy(input?:any){
   if(input===undefined){const result=await deps.request('/control-proxy');if(result.status!==200)throw new LocalControlError(result.status,'无法读取代理配置');return result.data;}
   return withFileLock(join(directory,'local-agent-operation'),async()=>{
    await ensureNoLogin();const ids=allBots().map(bot=>bot.larkAppId);
    if(await deps.busy(ids))throw new LocalControlError(409,'Agent 正忙，请空闲后同步代理');
    const prepared=await deps.request('/control-proxy','PUT',input);if(prepared.status!==200)throw new LocalControlError(prepared.status,prepared.data.message||'代理配置未准备完成');
    for(const id of ids)if(!(await deps.stop(id)).ok)throw new LocalControlError(409,'Bot 停止尚未确认');
    const configuration=prepared.data.proxy,environment=proxyEnvironment(configuration);
    atomicWriteFileSync(proxyFile(home),JSON.stringify(configuration),{mode:0o600});
    for(const type of types){const current=readContainerAgentEnvironment(home,type);if(current)writeContainerAgentEnvironment(home,type,{...Object.fromEntries(Object.entries(current).filter(([key])=>!proxyEnvironmentKeys.includes(key))),...environment});}
    for(const id of ids)if(!(await deps.start(id)).ok)throw new LocalControlError(409,'代理已落盘，Bot 恢复待确认');
    const ack=await deps.request('/control-proxy','POST',{revision:prepared.data.revision,proxyRevision:configuration?.revision??0});if(ack.status!==200)throw new LocalControlError(ack.status,'代理同步确认失败');return ack.data;
   });
  },
  async assertNoLogin(){await ensureNoLogin();},
  async status(){
   const result=await deps.request(prefix);if(result.status!==200)throw new LocalControlError(503,'无法读取本地 Agent 的管理状态');
   return {name:'Dev Agent · Control',controlId,bots:allBots().map(b=>({appId:b.larkAppId,displayName:b.displayName||b.name||b.larkAppId,cliId:b.cliId||'claude-code'})),agents:types.map(agentType=>{
    const desired=result.data.agents.find((r:any)=>r.agent_type===agentType),local=meta(agentType),currentModel=readContainerAgentModel(home,agentType),env=readContainerAgentEnvironment(home,agentType);
    return {agentType,revision:desired?.revision??0,appliedRevision:desired?.applied_revision??0,requestId:desired?.request_id,
     authMethod:desired?.auth_method??local?.authMethod??(['pi','zcode'].includes(agentType)||env&&Object.keys(env).length?'api-key':'oauth'),
     requiresLogin:desired?.model_protocol==='vercel-claude'||desired?.auth_method==='oauth',modelProfileId:desired?.model_profile_id??local?.modelProfileId??null,modelId:desired?.selected_model_id??local?.modelId??'',
     currentModel,modelName:desired?.model_name??null,credentialPresent:credential(agentType),
     status:desired?desired.revision!==desired.applied_revision?'pending':local?.revision===desired.revision?'synced':'restore':'unmanaged'};
   })};
  },
  async apply(type:string,input:any){requireType(type);
   if(input.confirmRestart!==true)throw new LocalControlError(400,'请确认同步会重启受影响的空闲 Bot，会话历史和登录态保留');
   return withFileLock(join(directory,'local-agent-operation'),async()=>{
    await ensureNoLogin();
    const bots=allBots().filter(b=>b.cliId===type),ids=bots.map(b=>b.larkAppId);
    if(await deps.busy(ids))throw new LocalControlError(409,'本地 Agent 正在执行任务或状态不可确认，请等待空闲后同步');
    const {confirmRestart,...body}=input;
    const prepared=await deps.request(prefix+'/'+type,'POST',body);
    if(prepared.status!==200)throw new LocalControlError(prepared.status,prepared.data.message||'配置尚未准备完成');
    const value=prepared.data;
    for(const id of ids)if(!(await deps.stop(id)).ok)throw new LocalControlError(409,'本地 Bot 停止未确认，保留模型引用，请重试同步');
    let digest='';
    await withFileLock(join(home,'.botmux','pm2-fleet-mutation'),async()=>{
     for(const id of ids)if(!await deps.isStopped(id))throw new LocalControlError(409,'本地 Bot 又启动了，请刷新后重试');
     await writeNativeAgentModel(home,{generation:'local-control',revision:value.revision,agentType:type as any,model:value.model,binding:null});
     const managed=new Set(Object.values(agentEnvironmentKeys).flat());
     mutateBotsJsonAtomic(deps.botsJsonPath,current=>current.map(bot=>bot.cliId!==type?bot:{...bot,model:undefined,env:Object.fromEntries(Object.entries(bot.env||{}).filter(([key])=>!managed.has(key)))}));
     digest=createHash('sha256').update(JSON.stringify({model:readContainerAgentModel(home,type),env:readContainerAgentEnvironment(home,type)})).digest('hex');
     atomicWriteFileSync(file(type),JSON.stringify({revision:value.revision,requestId:value.requestId,authMethod:value.model.authMethod,modelProfileId:value.modelProfileId,modelId:value.model.modelId,digest}),{mode:0o600});
    });
    for(const id of ids)if(!(await deps.start(id)).ok)throw new LocalControlError(409,'模型已落盘但 Bot 重启尚未确认，请重试同步；原引用暂不释放');
    const ack=await deps.request(prefix+'/'+type+'/ack','POST',{revision:value.revision,requestId:value.requestId,digest,appIds:ids});
    if(ack.status!==200||ack.data.applied!==true)throw new LocalControlError(409,'本地已应用，管理端确认未完成；请重试原配置同步');
    return {applied:true,revision:value.revision,restartedBots:ids.length};
   });
  },
  async changeCli(appId:string,input:any){requireType(input.cliId);
   if(input.confirmRestart!==true||!allBots().some(b=>b.larkAppId===appId))throw new LocalControlError(400,'请确认本地 Bot 与 CLI 切换');
   return withFileLock(join(directory,'local-agent-operation'),async()=>{
    await ensureNoLogin();
    if(await deps.busy([appId]))throw new LocalControlError(409,'机器人正在执行任务，暂不切换 CLI');
    if(!deps.changeCli)throw new LocalControlError(503,'本地 CLI 切换暂不可用');
    const result=await deps.changeCli(appId,input.cliId);if(result.status!==200||result.data.ok!==true)throw new LocalControlError(result.status>=400?result.status:409,'CLI 切换未确认，请刷新状态');
    return {changed:true};
   });
  },
  async login(type:string,input:any){requireType(type);
   if(!['codex','claude-code','traex'].includes(type)||!['start','inspect','cancel','callback','dashboard'].includes(input.action))throw new LocalControlError(400,'原生登录操作无效');
   return withFileLock(join(directory,'local-agent-operation'),async()=>{
    await loginManager();await restoring;
    if(input.action==='start'){
     if(type==='claude-code'&&!readContainerAgentEnvironment(home,type)?.ANTHROPIC_CUSTOM_HEADERS?.startsWith('x-ai-gateway-api-key: Bearer '))throw new LocalControlError(409,'请先选择并同步 Vercel + Claude 订阅连接');
     const current=meta(type);if(current?.authMethod!=='oauth')throw new LocalControlError(409,'请先选择并同步原生 OAuth 登录方式');
     if(oauth.busy())throw new LocalControlError(409,'已有本地登录正在进行，请先完成或取消');
     if(typeof input.profileId!=='string'||!/^[0-9a-f-]{36}$/.test(input.profileId))throw new LocalControlError(400,'请选择登录工作台的浏览器配置');
     owner={agentType:type,revision:current.revision,loginId:randomUUID(),appIds:[],profileId:input.profileId};saveOwner();
    }
    if(owner?.agentType!==type)throw new LocalControlError(409,'没有此 CLI 的本地登录任务');
    if(input.action==='dashboard'){
     if(!owner.workbenchGeneration)throw new LocalControlError(409,'登录工作台尚未就绪');
     return {dashboardLoginId:owner.loginId};
    }
    let result=await oauth.request(input.action,{loginId:owner.loginId,generation:'local-control',revision:owner.revision,...(input.action==='callback'?{callback:input.callback}:{})});
    if(input.action==='start'&&result.oauth.authorizationUrl){
     const generation=randomUUID(),created=await deps.request('/local-login-workbench','POST',{
      loginId:owner.loginId,controlId,agentType:type,profileId:owner.profileId,generation,
      authorizationUrl:result.oauth.authorizationUrl,callbackPort:result.oauth.callbackPort,callbackPath:result.oauth.callbackPath,
     });
     if(created.status!==201){
      await oauth.request('cancel',{loginId:owner.loginId,generation:'local-control',revision:owner.revision});
      await deps.request(`/local-login-workbench/${owner.loginId}`,'DELETE',{});
      throw new LocalControlError(created.status,created.data.message||'登录工作台启动失败');
     }
     owner.workbenchGeneration=generation;saveOwner();
    }
    if(input.action==='start'&&!result.oauth.authorizationUrl){
     await oauth.request('cancel',{loginId:owner.loginId,generation:'local-control',revision:owner.revision});
     throw new LocalControlError(502,'原生登录初始化未返回官方授权地址，请重试');
    }
    if(input.action==='inspect'&&owner.workbenchGeneration){
     const browser=await deps.request(`/local-login-workbench/${owner.loginId}`,'POST',{});
     if(browser.status===200&&browser.data.callback&&result.oauth.state==='waiting'){
      result=await oauth.request('callback',{loginId:owner.loginId,generation:'local-control',revision:owner.revision,callback:browser.data.callback});
      await deps.request(`/local-login-workbench/${owner.loginId}/ack`,'POST',{});
     }
     if(['succeeded','failed','cancelled'].includes(result.oauth.state))await closeWorkbench();
    }
    if(input.action==='cancel')await closeWorkbench();
    return result;
   });
  },
 };
}
