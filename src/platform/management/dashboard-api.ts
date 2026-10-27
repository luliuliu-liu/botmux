import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { BotOnboardingManager } from '../../dashboard/bot-onboarding.js';
import { readBotsJsonOrEmpty,mutateBotsJsonAtomic } from '../../setup/bots-store.js';
import { jsonRes } from '../../dashboard/http.js';
import { createFeishuSessionReader, type FeishuSessionStatus } from './feishu-session.js';
import { createOnboardingSessionConfirmation } from './onboarding-session.js';
import { createLocalBotDetacher,LocalDetachError } from './local-bot-detach.js';
import { withLocalInventoryLock } from './local-inventory-lock.js';
import {originMatchesHost} from '../../dashboard/control-csrf.js';
import {createLocalControlAgent,LocalControlError} from './local-control-agent.js';
import {createExistingBotsManager,ExistingBotError} from './existing-bots.js';
import {containerRole} from './container-role.js';
import {createAgentSkillManagement,imageSkillAgents} from './agent-skill-management.js';
import {AgentSkillError,applyAgentSkillBundle,installMissingAgentSkills} from './agent-skills.js';
import {isNativeWorkerProxyRequest} from './native-worker-proxy-auth.js';
import {createLocalBotBinder,LocalBindError,localInventoryEntries} from './local-bot-bind.js';

export function platformWorkerImage():boolean{
  return containerRole()==='worker';
}
export function platformManagementEnabled(): boolean {
  // A worker's root-owned image role cannot be promoted with container env.
  // Native Botmux transport, credentials, sessions and Dashboard stay intact.
  let imageRole: string | undefined;
  try { imageRole = readFileSync('/etc/botmux-platform-role', 'utf8').trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  if (imageRole === 'worker') return false;
  if (imageRole === 'dev'&&containerRole()!=='control')return false;
  return process.env.BOTMUX_PLATFORM_MANAGED === 'true';
}

export async function platformRequest(path: string, method='GET',body?:unknown) {
  const base=process.env.CONTROL_PLANE_URL?.trim();
  const key=process.env.CONTROL_PLANE_SYNC_KEY?.trim();
  const gatewayKey=process.env.BOTMUX_PLATFORM_GATEWAY_KEY?.trim();
  if(!base||!key)throw new Error('平台后台尚未配置 CONTROL_PLANE_URL / CONTROL_PLANE_SYNC_KEY');
  const response=await fetch(`${base.replace(/\/$/,'')}/internal/v1/platform${path}`,{
    method,headers:{'content-type':'application/json','x-api-key':key,
      ...(gatewayKey?{'x-platform-gateway-id':process.env.BOTMUX_PLATFORM_GATEWAY_ID||'local-gateway','x-platform-gateway-key':gatewayKey}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(/^\/image-cache\/(pull|pull-latest|remove)$/.test(path)?610000:path.startsWith('/dispatch/')?660000:180000)});
  const data=await response.json();
  return {status:response.status,data};
}

export function createPlatformDashboardApi(deps:{
  botsJsonPath:string;
  localOnboarding:BotOnboardingManager;
  listLocalBots:()=>Array<{larkAppId:string;displayName?:string;name?:string}>;
  readFeishuSession?:(force?:boolean)=>Promise<FeishuSessionStatus>;
  stopLocalBot?:(appId:string)=>Promise<{ok:boolean}>;
  isLocalBotStopped?:(appId:string)=>Promise<boolean>;
  startLocalBot?:(appId:string)=>Promise<{ok:boolean}>;
  localAgentBusy?:(ids:string[])=>Promise<boolean>;
  localBotRuntime?:(appId:string)=>Promise<{running:boolean;generation:string|null}>;
  changeLocalCli?:(appId:string,cli:string)=>Promise<{status:number;data:any}>;
  openWorkerDashboard?:(containerId:string,req:IncomingMessage)=>Promise<{url:string}>;
  existingBots?:ReturnType<typeof createExistingBotsManager>;
}) {
  const readFeishuSession = deps.readFeishuSession ?? createFeishuSessionReader();
  const localAgent=createLocalControlAgent({botsJsonPath:deps.botsJsonPath,request:platformRequest,
    stop:id=>deps.stopLocalBot?.(id)??Promise.resolve({ok:false}),start:id=>deps.startLocalBot?.(id)??Promise.resolve({ok:false}),
    isStopped:id=>deps.isLocalBotStopped?.(id)??Promise.resolve(false),busy:ids=>deps.localAgentBusy?.(ids)??Promise.resolve(ids.length>0)});
  const onboardingSession=createOnboardingSessionConfirmation(()=>deps.localOnboarding.sessionStatus());
  const path=join(dirname(deps.botsJsonPath),'platform','pool-bots.json');
  // Native atomic config/pending-job writers deliberately do not create their
  // parent. Prepare private storage BEFORE allowing any external App creation.
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const names = new Map<string,string>();
  const register=async(appId:string)=>{
    const bot=readBotsJsonOrEmpty(path).find((bot:any)=>bot.larkAppId===appId);
    if(!bot)throw new Error('未找到创建流程保存的机器人');
    const result=await platformRequest('/bots','POST',{
      appId:bot.larkAppId,appSecret:bot.larkAppSecret,displayName:[...names].find(([id])=>poolOnboarding.get(id)?.appId===appId)?.[1]||bot.displayName||bot.name||appId,
      brand:bot.brand==='lark'?'lark':'feishu',owner:{allowedUsers:bot.allowedUsers,ownerOpenId:bot.ownerOpenId},
    });
    if(result.status>=400)throw new Error(result.data.message||'机器人入池失败');
    return {ok:true,message:'机器人已进入空闲池，未启动本地 Agent'};
  };
  // Reuse native QR, permission automation and target-app owner validation.
  // The private store is NEVER loaded by the native fleet.
  const poolOnboarding=new BotOnboardingManager({botsJsonPath:path,startBotLive:register});
  const localDetach=createLocalBotDetacher({botsJsonPath:deps.botsJsonPath,
    stop:appId=>deps.stopLocalBot?deps.stopLocalBot(appId):Promise.resolve({ok:false}),
    isStopped:appId=>deps.isLocalBotStopped?deps.isLocalBotStopped(appId):Promise.resolve(false),
    release:body=>platformRequest('/local-release','POST',{...(body as object),gatewayId:process.env.BOTMUX_PLATFORM_GATEWAY_ID||'local-gateway'})});
  const gatewayId=process.env.BOTMUX_PLATFORM_GATEWAY_ID||'local-gateway';
  const agentSkills=createAgentSkillManagement(deps.botsJsonPath,platformRequest);
  const localBinder=createLocalBotBinder({botsJsonPath:deps.botsJsonPath,gatewayId,request:platformRequest,
    stop:id=>deps.stopLocalBot?.(id)??Promise.resolve({ok:false}),start:id=>deps.startLocalBot?.(id)??Promise.resolve({ok:false}),
    isStopped:id=>deps.isLocalBotStopped?.(id)??Promise.resolve(false),busy:ids=>deps.localAgentBusy?.(ids)??Promise.resolve(true),
    runtime:id=>deps.localBotRuntime?.(id)??Promise.resolve({running:false,generation:null}),assertNoLogin:()=>localAgent.assertNoLogin()});
  async function inventory() {
    return withLocalInventoryLock(async()=>{
    const localBots=deps.listLocalBots(),bots=localBots.map(bot=>({appId:bot.larkAppId,displayName:bot.displayName||bot.name||bot.larkAppId}));
    const entries=localInventoryEntries(deps.botsJsonPath,localBots);
    const result=await platformRequest('/local-claims','POST',{bots:await Promise.all(entries.map(async bot=>{
      const runtime=await deps.localBotRuntime?.(bot.appId)??{running:false,generation:null};
      return {...bot,runtimeRunning:runtime.running,runtimeGeneration:runtime.generation};
    }))});
    if(result.status>=400)throw new Error('无法确认本地机器人占用，请检查平台后台');
    return bots;
    });
  }
  const existingBots=deps.existingBots??createExistingBotsManager({
    managed:async()=>{
      const local=await inventory(),result=await platformRequest('/bots');
      if(result.status!==200)throw new ExistingBotError(503,'inventory_unavailable','无法确认已有机器人，请检查平台后台。');
      const rows=[...result.data.bots];
      for(const bot of local)if(!rows.some(row=>row.appId===bot.appId))rows.push({...bot,usage:'local'});
      return rows;
    },
    register:async body=>{
      const result=await platformRequest('/bots','POST',body);
      if(result.status>=400)throw new ExistingBotError(result.status,'bot_registration_failed',result.data.message||'机器人入池未确认，请刷新后重试。');
      return result.data;
    },
    refresh:(appId,displayName)=>withLocalInventoryLock(async()=>{
      const result=await platformRequest(`/bots/${appId}/refresh`,'POST',{displayName});
      if(result.status>=400)throw new ExistingBotError(result.status,'bot_refresh_failed',result.data.message||'配置刷新未确认，请重试。');
      // Native listLocalBots reads persisted names first. No credential/CLI or
      // owner mutation, fleet restart, or cross-container identity transfer.
      if(deps.listLocalBots().some(bot=>bot.larkAppId===appId))
        mutateBotsJsonAtomic(deps.botsJsonPath,bots=>bots.map(bot=>bot.larkAppId===appId?{...bot,displayName}:bot));
      return result.data;
    }),
  });
  return async(req:IncomingMessage,res:ServerResponse,url:URL,canManage:boolean)=>{
    if(!url.pathname.startsWith('/api/platform/'))return false;
    if(!canManage){jsonRes(res,401,{error:'management_auth_required'});return true;}
    if(url.pathname==='/api/platform/capabilities'){
      jsonRes(res,200,{enabled:platformManagementEnabled(),worker:platformWorkerImage()});return true;
    }
    const skillInstall=url.pathname==='/api/platform/skill-install';
    const skillRuntime=url.pathname==='/api/platform/skill-runtime'||skillInstall;
    if(!platformManagementEnabled()&&!(skillRuntime&&platformWorkerImage()&&isNativeWorkerProxyRequest(req))){jsonRes(res,404,{error:'platform_disabled'});return true;}
    if(['POST','PUT','PATCH','DELETE'].includes(req.method||'')&&req.headers){
      const origin=req.headers.origin,site=req.headers['sec-fetch-site'];
      const contentType=String(req.headers['content-type']||'').split(';')[0]?.trim().toLowerCase();
      // SameSite cookies do not protect Control from a sibling Worker origin.
      // Reuse native Origin normalization and require JSON (cross-origin
      // browser fetch then requires a CORS preflight, which we never grant).
      if(contentType!=='application/json'||(origin!==undefined&&!originMatchesHost(origin,req.headers.host))||
        (origin===undefined&&site!==undefined&&site!=='same-origin')){
        jsonRes(res,403,{error:'platform_origin_rejected'});return true;
      }
    }
    const read=async()=>{
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>(skillRuntime?6*1024*1024:65536))throw new Error('请求过大');}
      const value=JSON.parse(raw||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('需要 JSON 对象');return value;
    };
    try {
      const suffix=url.pathname.slice('/api/platform'.length);
      if(skillRuntime){
        if(req.method!=='POST'||!platformWorkerImage()||!isNativeWorkerProxyRequest(req)){jsonRes(res,403,{error:'worker_sync_only'});return true;}
        const input=await read(),home=dirname(dirname(deps.botsJsonPath));
        const config=JSON.parse(readFileSync(join(home,'.botmux','platform','native-config.json'),'utf8'));
        if(!input.generation||input.generation!==config.generation)throw new AgentSkillError(409,'Agent 运行代次已变化');
        if(skillInstall){
          if(input.revision!==config.revision)throw new AgentSkillError(409,'Agent 配置已变化，请刷新');
          jsonRes(res,200,{...await installMissingAgentSkills(home,input.bundle,imageSkillAgents(),input.names),revision:config.revision,generation:config.generation});return true;
        }
        jsonRes(res,200,{...await applyAgentSkillBundle(home,input,imageSkillAgents()),generation:config.generation});return true;
      }
      if(suffix==='/skill-sync'&&req.method==='GET'){jsonRes(res,200,await agentSkills.workers());return true;}
      const skillSync=suffix.match(/^\/skill-sync\/([0-9a-f-]{36})$/);
      if(skillSync&&req.method==='POST'){jsonRes(res,200,await agentSkills.syncInstalled(skillSync[1]!,await read()));return true;}
      if(suffix==='/skill-assignments'&&req.method==='GET'){jsonRes(res,200,await agentSkills.list());return true;}
      const skillTarget=suffix.match(/^\/skill-assignments\/(control|[0-9a-f-]{36})$/);
      if(skillTarget&&req.method==='PUT'){jsonRes(res,200,await agentSkills.save(skillTarget[1]!,await read()));return true;}
      const localBind=suffix.match(/^\/local-bots\/(cli_[A-Za-z0-9_-]+)\/bind$/);
      if(localBind&&req.method==='POST'){jsonRes(res,200,await localBinder.bind(localBind[1]!,await read()));return true;}
      const deleteBot=suffix.match(/^\/bots\/(cli_[A-Za-z0-9_-]+)$/);
      if(deleteBot&&req.method==='DELETE'){
        const input=await read();
        const result=await withLocalInventoryLock(async()=>{
          if(readBotsJsonOrEmpty(deps.botsJsonPath).some(bot=>bot.larkAppId===deleteBot[1])||!await deps.isLocalBotStopped?.(deleteBot[1]!))
            throw new LocalBindError(409,'请先确认本地 Bot 已解绑并停止');
          const result=await platformRequest(`/bots/${deleteBot[1]}`,'DELETE',input);
          if(result.status>=400)throw new LocalBindError(result.status,result.data.message||'删除未确认');
          if(result.data.deleted!==true)throw new LocalBindError(409,'删除未确认');
          if(readBotsJsonOrEmpty(path).some(bot=>bot.larkAppId===deleteBot[1]))mutateBotsJsonAtomic(path,bots=>bots.filter(bot=>bot.larkAppId!==deleteBot[1]));
          localDetach.forget(deleteBot[1]!);return result.data;
        });jsonRes(res,200,result);return true;
      }
      if(suffix==='/feishu-apps'&&req.method==='GET'){jsonRes(res,200,await existingBots.list());return true;}
      if(suffix==='/bots/import'&&req.method==='POST'){jsonRes(res,201,await existingBots.import(await read()));return true;}
      const botRefresh=suffix.match(/^\/bots\/(cli_[A-Za-z0-9_-]+)\/refresh$/);
      if(botRefresh&&req.method==='POST'){await read();jsonRes(res,200,await existingBots.refresh(botRefresh[1]));return true;}
      if(suffix==='/control-upgrade'&&['GET','POST'].includes(req.method||'')){jsonRes(res,req.method==='POST'?202:200,await localAgent.upgrade(req.method==='POST'?await read():undefined));return true;}
      if(suffix==='/control-proxy'&&['GET','PUT'].includes(req.method||'')){jsonRes(res,200,await localAgent.proxy(req.method==='PUT'?await read():undefined));return true;}
      if(suffix==='/local-agent'&&req.method==='GET'){jsonRes(res,200,await localAgent.status());return true;}
      const localModel=suffix.match(/^\/local-agent\/(pi|codex|claude-code|zcode)$/);
      if(localModel&&req.method==='PUT'){const input=await read();jsonRes(res,200,await withLocalInventoryLock(()=>localAgent.apply(localModel[1]!,input)));return true;}
      const localLogin=suffix.match(/^\/local-agent\/(codex|claude-code)\/login$/);
      if(localLogin&&req.method==='POST'){
        const result=await localAgent.login(localLogin[1]!,await read());
        if(result.dashboardLoginId){
          if(!deps.openWorkerDashboard){jsonRes(res,503,{error:'worker_proxy_unavailable'});return true;}
          jsonRes(res,200,await deps.openWorkerDashboard(result.dashboardLoginId,req));return true;
        }
        jsonRes(res,200,result);return true;
      }
      const localCli=suffix.match(/^\/local-agent\/bots\/([A-Za-z0-9._-]+)$/);
      if(localCli&&req.method==='PUT'){const input=await read();await inventory();jsonRes(res,200,await localBinder.switchCli(localCli[1]!,input));return true;}
      const workerDashboard=suffix.match(/^\/(?:containers|logins|browsers)\/([0-9a-f-]{36})\/dashboard$/);
      if(workerDashboard&&req.method==='POST'){
        if(!deps.openWorkerDashboard){jsonRes(res,503,{error:'worker_proxy_unavailable'});return true;}
        jsonRes(res,200,await deps.openWorkerDashboard(workerDashboard[1]!,req));return true;
      }
      const localUnbind=suffix.match(/^\/local-bots\/([A-Za-z0-9._-]+)\/unbind$/);
      if(localUnbind&&req.method==='POST'){
        const input=await read();const local=deps.listLocalBots().find(bot=>bot.larkAppId===localUnbind[1]);
        const result=typeof input.localRevision==='string'?await localDetach.detach(localUnbind[1]!,input.localRevision,input.confirmLocalStop,local?.displayName||local?.name||localUnbind[1]!):await localBinder.releaseMissing(localUnbind[1]!,input);
        jsonRes(res,200,result);return true;
      }
      if(suffix==='/feishu-session'&&req.method==='GET'){
        jsonRes(res,200,{session:await readFeishuSession(url.searchParams.get('refresh')==='1')});return true;
      }
      if(suffix==='/onboarding/session'&&req.method==='GET'){
        jsonRes(res,200,{session:await onboardingSession.inspect()});return true;
      }
      if(suffix==='/onboarding'&&req.method==='POST'){
        const input=await read();
        if(typeof input.name!=='string'||!input.name.trim()||[...input.name].length>64||!['pool','local'].includes(input.target)){
          jsonRes(res,400,{error:'invalid_request',message:'请填写名称并选择用途'});return true;
        }
        if(!['reuse','qr'].includes(input.sessionMode)){
          jsonRes(res,400,{error:'invalid_session_mode',message:'请确认使用当前账号，或明确选择扫码登录'});return true;
        }
        await inventory(); // fail before creating an external Feishu app if storage is unavailable.
        const expectedIdentity=input.sessionMode==='reuse'?await onboardingSession.consume(input.confirmationToken):undefined;
        if(input.sessionMode==='reuse'&&!expectedIdentity){
          jsonRes(res,409,{error:'session_confirmation_required',message:'登录态已失效、账号/企业已变化或确认已过期，请重新确认后创建；未创建应用'});return true;
        }
        const manager=input.target==='local'?deps.localOnboarding:poolOnboarding;
        const job=manager.start({appName:input.name.trim(),registrationMode:'web',sessionMode:input.sessionMode,...(expectedIdentity?{expectedIdentity}:{}),cliId:'pi',workingDir:'/workspace',dirMode:'fixed'});
        names.set(job.id,input.name.trim());
        jsonRes(res,202,{job:manager.get(job.id),target:input.target});return true;
      }
      const jobMatch=suffix.match(/^\/onboarding\/(pool|local)\/([A-Za-z0-9._-]+)(\/owner|\/register)?$/);
      if(jobMatch){
        const manager=jobMatch[1]==='pool'?poolOnboarding:deps.localOnboarding;
        const job=manager.get(jobMatch[2]!);
        if(!job){jsonRes(res,404,{error:'job_not_found'});return true;}
        if(req.method==='POST'&&jobMatch[3]==='/owner'){
          const input=await read();
          if(!Array.isArray(input.entries)||!input.entries.every((e:unknown)=>typeof e==='string')){
            jsonRes(res,400,{error:'invalid_owner'});return true;
          }
          const result=await manager.submitOwner(jobMatch[2]!,input.entries);
          jsonRes(res,result.ok?200:400,{...result,job:manager.get(jobMatch[2]!)});return true;
        }
        if(req.method==='POST'&&jobMatch[3]==='/register'&&jobMatch[1]==='pool'&&job.status==='completed'&&job.appId){
          await register(job.appId);jsonRes(res,200,{ok:true});return true;
        }
        if(req.method==='GET'&&!jobMatch[3]){jsonRes(res,200,{job});return true;}
      }
      if(/^\/(?:proxies|credentials)(?:\/[A-Za-z0-9._-]+)?$/.test(suffix)&&['GET','PUT','DELETE'].includes(req.method||'')){const result=await platformRequest(suffix,req.method,req.method==='GET'?undefined:await read());jsonRes(res,result.status,result.data);return true;}
      if((req.method==='GET'&&suffix==='/image-cache')||(req.method==='POST'&&/^\/image-cache\/(refresh|registry|pull|pull-latest|remove)$/.test(suffix))||(req.method==='POST'&&suffix==='/browsers')||(/^\/browsers\/[0-9a-f-]{36}(?:\/(dashboard-route|reconcile))?$/.test(suffix)&&['GET','POST','PUT','DELETE'].includes(req.method||''))){const result=await platformRequest(suffix,req.method,req.method==='GET'?undefined:await read());jsonRes(res,result.status,result.data);return true;}
      if((suffix==='/images'&&req.method==='GET')||(/^\/containers\/[0-9a-f-]{36}\/upgrade$/.test(suffix)&&req.method==='POST')){const result=await platformRequest(suffix,req.method,req.method==='GET'?undefined:await read());jsonRes(res,result.status,result.data);return true;}
      const accessRoute=/^\/(?:browser-profiles(?:\/[0-9a-f-]{36})?|logins(?:\/[0-9a-f-]{36})?|local-login-workbench(?:\/[0-9a-f-]{36}(?:\/(?:ack|dashboard-route))?)?|containers\/[0-9a-f-]{36}\/(?:login|upgrade))$/.test(suffix);
      if((!accessRoute&&!/^\/(catalog|workspaces|bots(?:\/[A-Za-z0-9._-]+\/unbind)?|containers(?:\/[0-9a-f-]+(?:\/reconcile)?)?|models(?:\/[A-Za-z0-9._-]+(?:\/clone)?)?)$/.test(suffix))||
        !['GET','POST','PUT','DELETE'].includes(req.method||'')){
        jsonRes(res,404,{error:'not_found'});return true;
      }
      const allowed = accessRoute&&(req.method==='GET'&&/^\/(?:browser-profiles|logins|local-login-workbench\/[0-9a-f-]{36}\/dashboard-route)$/.test(suffix)
        ||req.method==='POST'&&/^\/(?:browser-profiles|logins\/[0-9a-f-]{36}|local-login-workbench(?:\/[0-9a-f-]{36}(?:\/ack)?)?|containers\/[0-9a-f-]{36}\/(?:login))$/.test(suffix)
        ||req.method==='PUT'&&/^\/(?:browser-profiles\/[0-9a-f-]{36})$/.test(suffix)
        ||req.method==='DELETE'&&/^\/(?:logins|local-login-workbench)\/[0-9a-f-]{36}$/.test(suffix))
        || req.method === 'GET' && ['/catalog','/workspaces','/bots','/containers','/models'].includes(suffix)
        || req.method === 'POST' && (suffix === '/containers' || /^\/models\/[A-Za-z0-9._-]+(?:\/clone)?$/.test(suffix)|| /^\/containers\/[0-9a-f-]+\/reconcile$/.test(suffix)||/^\/bots\/[A-Za-z0-9._-]+\/unbind$/.test(suffix))
        || req.method === 'PUT' && (suffix==='/workspaces'||/^\/(containers\/[0-9a-f-]+|models\/[A-Za-z0-9._-]+)$/.test(suffix))
        || req.method === 'DELETE' && (/^\/containers\/[0-9a-f-]+$/.test(suffix)||/^\/models\/[A-Za-z0-9._-]+$/.test(suffix));
      if (!allowed) { jsonRes(res,405,{error:'method_not_allowed'});return true; }
      // Inventory is sampled on every mutation/list: no sandbox can select a
      // local identity merely because the UI last loaded an old free-bot list.
      const local=await inventory();
      const result=await platformRequest(suffix,req.method,req.method==='GET'?undefined:await read());
      if(suffix==='/bots'&&req.method==='GET'&&result.status===200){
        const rows=result.data.bots as Array<{appId:string}>;
        for(const bot of local){const existing=rows.find(row=>row.appId===bot.appId) as any;
          if(!existing)rows.push({...bot,botId:bot.appId,usage:'local',secretConfigured:true,localRevision:localDetach.revision(bot.appId)} as any);
          else if(existing.usage==='local'){if(bot.displayName!==bot.appId)existing.displayName=bot.displayName;existing.localRevision=localDetach.revision(bot.appId);}
        }
        for(const pending of localDetach.pending()){
          const existing=rows.find(row=>row.appId===pending.appId) as any;
          if(existing)Object.assign(existing,pending,{usage:'local'});
          else rows.push({...pending,botId:pending.appId,usage:'local',secretConfigured:true} as any);
        }
        for(const row of rows as any[]){
          row.localConfigured=local.some(bot=>bot.appId===row.appId);
          row.localOwned=!row.localGatewayId||row.localGatewayId===gatewayId;
          if(row.usage==='local')row.localState=!row.localOwned?'other':!row.localConfigured?'missing':row.bindingRevision===row.localAppliedRevision?'synced':'pending';
        }
      }
      jsonRes(res,result.status,result.data);return true;
    }catch(error){
      if(error instanceof AgentSkillError){jsonRes(res,error.status,{error:'agent_skill_failed',message:error.message});return true;}
      if(error instanceof LocalBindError){jsonRes(res,error.status,{error:'local_bot_failed',message:error.message});return true;}
      if(error instanceof ExistingBotError){jsonRes(res,error.status,{error:error.code,message:error.message});return true;}
      if(error instanceof LocalControlError){jsonRes(res,error.status,{error:'local_agent_failed',message:error.message});return true;}
      if(error instanceof LocalDetachError){jsonRes(res,error.status,{error:'local_detach_failed',message:error.message});return true;}
      jsonRes(res,502,{error:'platform_unavailable',message:'平台后台操作未确认完成，请刷新查看记录；不要重复创建飞书应用'});
      return true;
    }
  };
}
