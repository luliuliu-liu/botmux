import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { BotOnboardingManager } from '../../dashboard/bot-onboarding.js';
import { readBotsJsonOrEmpty } from '../../setup/bots-store.js';
import { jsonRes } from '../../dashboard/http.js';
import { createFeishuSessionReader, type FeishuSessionStatus } from './feishu-session.js';
import { createOnboardingSessionConfirmation } from './onboarding-session.js';

export function platformManagementEnabled(): boolean { return process.env.BOTMUX_PLATFORM_MANAGED === 'true'; }

export async function platformRequest(path: string, method='GET',body?:unknown) {
  const base=process.env.CONTROL_PLANE_URL?.trim();
  const key=process.env.CONTROL_PLANE_SYNC_KEY?.trim();
  if(!base||!key)throw new Error('平台后台尚未配置 CONTROL_PLANE_URL / CONTROL_PLANE_SYNC_KEY');
  const response=await fetch(`${base.replace(/\/$/,'')}/internal/v1/platform${path}`,{
    method,headers:{'content-type':'application/json','x-api-key':key},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(path.startsWith('/dispatch/')?660000:180000)});
  const data=await response.json();
  return {status:response.status,data};
}

export function createPlatformDashboardApi(deps:{
  botsJsonPath:string;
  localOnboarding:BotOnboardingManager;
  listLocalBots:()=>Array<{larkAppId:string;displayName?:string;name?:string}>;
  readFeishuSession?:(force?:boolean)=>Promise<FeishuSessionStatus>;
}) {
  const readFeishuSession = deps.readFeishuSession ?? createFeishuSessionReader();
  const onboardingSession=createOnboardingSessionConfirmation(()=>deps.localOnboarding.sessionStatus());
  const path=join(dirname(deps.botsJsonPath),'platform','pool-bots.json');
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
  async function inventory() {
    const bots=deps.listLocalBots().map(bot=>({appId:bot.larkAppId,displayName:bot.displayName||bot.name||bot.larkAppId}));
    const result=await platformRequest('/local-claims','POST',{gatewayId:process.env.BOTMUX_PLATFORM_GATEWAY_ID||'local-gateway',bots});
    if(result.status>=400)throw new Error('无法确认本地机器人占用，请检查平台后台');
    return bots;
  }
  return async(req:IncomingMessage,res:ServerResponse,url:URL,canManage:boolean)=>{
    if(!url.pathname.startsWith('/api/platform/'))return false;
    if(!canManage){jsonRes(res,401,{error:'management_auth_required'});return true;}
    if(url.pathname==='/api/platform/capabilities'){
      jsonRes(res,200,{enabled:platformManagementEnabled()});return true;
    }
    if(!platformManagementEnabled()){jsonRes(res,404,{error:'platform_disabled'});return true;}
    const read=async()=>{
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536)throw new Error('请求过大');}
      const value=JSON.parse(raw||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('需要 JSON 对象');return value;
    };
    try {
      const suffix=url.pathname.slice('/api/platform'.length);
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
      if(!/^\/(catalog|bots|containers(?:\/[0-9a-f-]+(?:\/reconcile)?)?|models(?:\/[A-Za-z0-9._-]+)?)$/.test(suffix)||
        !['GET','POST','PUT','DELETE'].includes(req.method||'')){
        jsonRes(res,404,{error:'not_found'});return true;
      }
      const allowed = req.method === 'GET' && ['/catalog','/bots','/containers','/models'].includes(suffix)
        || req.method === 'POST' && (suffix === '/containers' || /^\/containers\/[0-9a-f-]+\/reconcile$/.test(suffix))
        || req.method === 'PUT' && /^\/(containers\/[0-9a-f-]+|models\/[A-Za-z0-9._-]+)$/.test(suffix)
        || req.method === 'DELETE' && /^\/containers\/[0-9a-f-]+$/.test(suffix);
      if (!allowed) { jsonRes(res,405,{error:'method_not_allowed'});return true; }
      // Inventory is sampled on every mutation/list: no sandbox can select a
      // local identity merely because the UI last loaded an old free-bot list.
      const local=await inventory();
      const result=await platformRequest(suffix,req.method,req.method==='GET'?undefined:await read());
      if(suffix==='/bots'&&req.method==='GET'&&result.status===200){
        const rows=result.data.bots as Array<{appId:string}>;
        for(const bot of local)if(!rows.some(row=>row.appId===bot.appId))rows.push({
          ...bot,botId:bot.appId,usage:'local',secretConfigured:true,
        } as any);
      }
      jsonRes(res,result.status,result.data);return true;
    }catch{
      jsonRes(res,502,{error:'platform_unavailable',message:'平台后台操作未确认完成，请刷新查看记录；不要重复创建飞书应用'});
      return true;
    }
  };
}
