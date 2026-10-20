/** Platform-only import/readback. Never creates apps, resets secrets or changes
 * permissions. Native setup and unmanaged Botmux behavior remain untouched. */
import {randomUUID} from 'node:crypto';
import {prepareFeishuWebSession,createOpenPlatformApiClient,listOpenPlatformApps,fetchOpenPlatformAppSecret,
  type OpenPlatformApiClient,type OpenPlatformAppSummary,type FeishuWebSessionIdentity} from '../../setup/open-platform-automation.js';
import {validateCredentials} from '../../setup/verify-permissions.js';
import {normalizeManagedOwnerEntries,detectUnusableOwnerEntries} from '../../setup/owner-identity.js';
import {findInvalidAllowedUserEntries,hasOwnerEntry} from '../../setup/bot-config-editor.js';

export class ExistingBotError extends Error{constructor(readonly status:number,readonly code:string,message:string){super(message);}}
type Connection={client:OpenPlatformApiClient;identity:FeishuWebSessionIdentity};
type Managed={appId:string;displayName:string;usage?:string};
const fail=(status:number,code:string,message:string):never=>{throw new ExistingBotError(status,code,message);};
const timedFetch:typeof fetch=(input,init)=>fetch(input,{...init,signal:init?.signal
  ?AbortSignal.any([init.signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});
async function connect():Promise<Connection>{
  const session=await prepareFeishuWebSession({disableQrLogin:true,disableBytedcliFallback:true,fetchImpl:timedFetch});
  if(!session.ok)return fail(409,'feishu_login_required','请先在 Bot 管理中登录飞书，再读取已有应用。');
  const result=await createOpenPlatformApiClient(session.cookies,{fetchImpl:timedFetch});
  if(!result.ok||!result.identity)return fail(409,'feishu_identity_unavailable','无法确认当前飞书账号与企业，请检查登录态后重试。');
  return {client:result.client,identity:result.identity};
}
async function validateBot(appId:string,secret:string){
  const result=await validateCredentials(appId,secret,'feishu');
  if(!result.ok)return fail(409,'bot_credentials_invalid','应用凭证不可用，请检查飞书应用的发布状态与访问权限。');
  const response=await timedFetch('https://open.feishu.cn/open-apis/bot/v3/info/',{headers:{authorization:`Bearer ${result.tenantAccessToken}`}});
  const body=await response.json() as any;
  if(!response.ok||body.code!==0||!body.bot?.open_id)return fail(409,'bot_unavailable','此应用尚无可用的机器人，请先在飞书开放平台启用机器人并发布。');
}
export function createExistingBotsManager(deps:{
  managed:()=>Promise<Managed[]>;
  register:(body:unknown)=>Promise<unknown>;
  refresh:(appId:string,displayName:string)=>Promise<unknown>;
  connect?:()=>Promise<Connection>;
  list?:typeof listOpenPlatformApps;
  secret?:typeof fetchOpenPlatformAppSecret;
  validateBot?:typeof validateBot;
  validateOwners?:typeof detectUnusableOwnerEntries;
  now?:()=>number;
}){
  const open=deps.connect??connect,list=deps.list??listOpenPlatformApps,secret=deps.secret??fetchOpenPlatformAppSecret;
  const check=deps.validateBot??validateBot,owners=deps.validateOwners??detectUnusableOwnerEntries,now=deps.now??Date.now;
  const confirmations=new Map<string,{userId:string;tenantId:string;apps:Set<string>;expires:number}>();
  const prune=()=>{for(const [id,value] of confirmations)if(value.expires<=now())confirmations.delete(id);};
  const appId=(value:unknown)=>typeof value==='string'&&/^cli_[A-Za-z0-9_-]{1,196}$/.test(value)?value:fail(400,'invalid_app_id','App ID 无效。');
  const find=(apps:OpenPlatformAppSummary[],id:string)=>apps.find(app=>app.clientId===id)
    ??fail(403,'app_not_visible','当前账号下未找到此应用，未读取凭据或修改配置。');
  return {
    async list(){
      prune();const {client,identity}=await open();
      const [apps,managed]=await Promise.all([list(client,{maxApps:1000}),deps.managed()]);
      if(confirmations.size>=100)confirmations.delete(confirmations.keys().next().value!);
      const confirmationToken=randomUUID();
      confirmations.set(confirmationToken,{userId:identity.userId,tenantId:identity.tenantId,apps:new Set(apps.map(a=>a.clientId)),expires:now()+600000});
      return {confirmationToken,identity:{userName:identity.userName,tenantName:identity.tenantName,...(identity.email?{email:identity.email}:{})},
        apps:apps.map(app=>({appId:app.clientId,displayName:app.name,description:app.description,
          registered:managed.some(bot=>bot.appId===app.clientId),usage:managed.find(bot=>bot.appId===app.clientId)?.usage})),
        limited:apps.length>=1000};
    },
    async import(input:any){
      prune();const id=appId(input.appId),token=input.confirmationToken;
      const confirmed=typeof token==='string'?confirmations.get(token):undefined;
      if(!confirmed||!confirmed.apps.has(id))return fail(409,'selection_expired','应用选择已过期，请刷新列表并重新确认账号。');
      confirmations.delete(token);
      const {client,identity}=await open();
      if(identity.userId!==confirmed.userId||identity.tenantId!==confirmed.tenantId)return fail(409,'feishu_account_changed','飞书账号或企业已变化，请重新读取列表；未导入应用。');
      // Recheck membership/name instead of trusting the browser's old list.
      const app=find(await list(client,{maxApps:1000}),id);
      if((await deps.managed()).some(bot=>bot.appId===id))return fail(409,'bot_already_registered','此机器人已纳管，请刷新列表；无需重复导入。');
      const raw=typeof input.owner==='string'?input.owner.trim():identity.email?.trim();
      if(!raw)return fail(400,'owner_required','请提供机器人所有者的企业邮箱、手机号或 union_id。');
      let normalized:string|undefined;
      try{normalized=await normalizeManagedOwnerEntries(raw,{creatingApp:true},async()=>undefined);}
      catch{return fail(400,'invalid_owner','所有者不能使用其他应用的 open_id，请填写企业邮箱、手机号或 union_id。');}
      const allowedUsers=normalized?.split(',').map(v=>v.trim()).filter(Boolean)??[];
      if(!hasOwnerEntry(allowedUsers)||findInvalidAllowedUserEntries(allowedUsers).length)return fail(400,'invalid_owner','所有者格式无效，请填写完整企业邮箱、手机号或 union_id。');
      const key=await secret(client,id);
      await check(id,key);
      if((await owners(id,key,'feishu',allowedUsers)).length)return fail(400,'owner_unavailable','目标应用无法识别此所有者，请检查企业身份和应用可见范围。');
      await deps.register({appId:id,appSecret:key,displayName:app.name,brand:'feishu',owner:{allowedUsers},reimport:true});
      return {imported:true,appId:id,displayName:app.name};
    },
    async refresh(value:unknown){
      const id=appId(value);
      if(!(await deps.managed()).some(bot=>bot.appId===id))return fail(404,'bot_not_registered','此机器人尚未纳管，请先导入。');
      const {client}=await open(),app=find(await list(client,{maxApps:1000}),id);
      // Refresh metadata only. Reading/resetting secrets is not part of rename.
      return deps.refresh(id,app.name);
    },
  };
}
