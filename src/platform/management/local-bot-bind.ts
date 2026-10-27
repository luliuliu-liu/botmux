/** Database desired state -> one native Bot. Never copies model/OAuth state. */
import {createHash,randomUUID} from 'node:crypto';
import {join,dirname} from 'node:path';
import {mkdirSync} from 'node:fs';
import {readBotsJsonOrEmpty,mutateBotsJsonAtomic} from '../../setup/bots-store.js';
import {withFileLock} from '../../utils/file-lock.js';
import {withLocalInventoryLock} from './local-inventory-lock.js';
import {localBotRevision} from './local-bot-detach.js';
import {normalizeManagedOwnerEntries,detectUnusableOwnerEntries} from '../../setup/owner-identity.js';
import {findInvalidAllowedUserEntries} from '../../setup/bot-config-editor.js';
export class LocalBindError extends Error{constructor(readonly status:number,message:string){super(message);}}
export function localManagedConfig(bot:any){
 return {larkAppId:bot.larkAppId,larkAppSecret:bot.larkAppSecret||'',displayName:bot.displayName||bot.name||bot.larkAppId,
  cliId:bot.cliId||'pi',defaultWorkingDir:bot.defaultWorkingDir||bot.workingDir||'/workspace',
  ...(bot.brand==='lark'?{brand:'lark'}:{}),
  ...(Array.isArray(bot.allowedUsers)&&bot.allowedUsers.length?{allowedUsers:bot.allowedUsers,ownerOpenId:bot.ownerOpenId}: {})};
}
export function localBotManagedDigest(bot:any){return createHash('sha256').update(JSON.stringify(localManagedConfig(bot))).digest('hex');}
export function localInventoryFromBots(bots:any[],names:Array<{larkAppId:string;displayName?:string;name?:string;runtimeRunning?:boolean;runtimeGeneration?:string|null}>=[]){
 return bots.map(bot=>{const observed=names.find(n=>n.larkAppId===bot.larkAppId);return {appId:bot.larkAppId,
  displayName:observed?.displayName||bot.displayName||bot.name||bot.larkAppId,
  digest:localBotManagedDigest(bot),
  runtimeRunning:(observed?.runtimeRunning??bot.runtimeRunning)===true,
  runtimeGeneration:observed?.runtimeGeneration??bot.runtimeGeneration??null};});
}
export function localInventoryEntries(botsJsonPath:string,names:Array<{larkAppId:string;displayName?:string;name?:string}>=[]){
 return localInventoryFromBots(readBotsJsonOrEmpty(botsJsonPath),names);
}
export function createLocalBotBinder(deps:{botsJsonPath:string;request:(path:string,method?:string,body?:unknown)=>Promise<{status:number;data:any}>;
 gatewayId:string;stop:(id:string)=>Promise<{ok:boolean}>;start:(id:string)=>Promise<{ok:boolean}>;isStopped:(id:string)=>Promise<boolean>;busy:(ids:string[])=>Promise<boolean>;
 runtime:(id:string)=>Promise<{running:boolean;generation:string|null}>;
 validateOwners?:typeof detectUnusableOwnerEntries;assertNoLogin?:()=>Promise<void>}){
 const roster=()=>readBotsJsonOrEmpty(deps.botsJsonPath),fleet=join(dirname(deps.botsJsonPath),'pm2-fleet-mutation');
 const operation=join(dirname(deps.botsJsonPath),'platform','local-agent-operation');mkdirSync(dirname(operation),{recursive:true,mode:0o700});
 const call=async(id:string,action:string,body:unknown)=>{
  const result=await deps.request(`/local-bots/${id}/${action}`,'POST',{...(body as object),gatewayId:deps.gatewayId});
  if(result.status!==200)throw new LocalBindError(result.status,result.data.message||'本地绑定操作未确认，请重试');return result.data;
 };
 return {
  async bind(id:string,input:any){
   if(input.confirmRestart!==true||!['pi','codex','claude-code','traex'].includes(input.cliId))throw new LocalBindError(400,'请确认 CLI 并允许同步、启动此 Bot');
   return withLocalInventoryLock(()=>withFileLock(operation,async()=>{
    await deps.assertNoLogin?.();
    const previous=roster().find(b=>b.larkAppId===id);
    if(previous&&!await deps.isStopped(id)&&await deps.busy([id]))throw new LocalBindError(409,'本地 Bot 正在执行任务或状态不可确认，未修改');
    const detail=await call(id,'inspect',{});
    if(detail.revision!==input.bindingRevision)throw new LocalBindError(409,'数据库绑定已变化，请刷新后重试');
    let owner:any;
    if(typeof input.owner==='string'&&input.owner.trim()){
     let normalized:string|undefined;
     try{normalized=await normalizeManagedOwnerEntries(input.owner.trim(),{creatingApp:true},async()=>undefined);}catch{throw new LocalBindError(400,'请使用邮箱、手机号或 union_id，不可复制其他应用的 open_id');}
     const allowedUsers=normalized?.split(',').map(v=>v.trim()).filter(Boolean)||[];
     if(!allowedUsers.length||findInvalidAllowedUserEntries(allowedUsers).length)throw new LocalBindError(400,'所有者格式无效');
     owner={allowedUsers};
    }else if(!detail.ownerConfigured){
     // A pre-existing native Bot is the same application, not a source Bot.
     // Validate its owner against this target before adopting the missing DB field.
     if(!previous?.allowedUsers?.length)throw new LocalBindError(400,'数据库缺少此应用的所有者，请补充确认后重试');
     owner={allowedUsers:previous.allowedUsers,ownerOpenId:previous.ownerOpenId};
    }
    const prepared=await call(id,'prepare',{revision:detail.revision,requestId:detail.revision!==detail.appliedRevision&&detail.requestId?detail.requestId:randomUUID(),cliId:input.cliId,...(owner?{owner}:{})});
    if(previous||!await deps.isStopped(id))if(!(await deps.stop(id)).ok)throw new LocalBindError(409,'数据库已保留绑定，但本地停止未确认，请重试同步');
    const desired=prepared.config;
    if((await (deps.validateOwners??detectUnusableOwnerEntries)(id,desired.larkAppSecret,desired.brand==='lark'?'lark':'feishu',desired.allowedUsers||[])).length)
     throw new LocalBindError(400,'目标应用不能验证该所有者，请检查身份与可见范围');
    await withFileLock(fleet,async()=>{
     if(!await deps.isStopped(id))throw new LocalBindError(409,'本地进程未确认停止，保留数据库绑定');
     mutateBotsJsonAtomic(deps.botsJsonPath,bots=>{
      const current=bots.find(bot=>bot.larkAppId===id);
      if((current?localBotRevision(current):null)!==(previous?localBotRevision(previous):null))throw new LocalBindError(409,'本地配置被并发修改，未覆盖；请刷新');
      return [...bots.filter(bot=>bot.larkAppId!==id),desired];
     });
    });
    if(!(await deps.start(id)).ok)throw new LocalBindError(409,'配置已恢复，但本地启动未确认，请再次同步；数据库仍保留占用');
    if(localBotRevision(roster().find(bot=>bot.larkAppId===id))!==localBotRevision(desired))throw new LocalBindError(409,'启动期间本地配置变化，未确认同步');
    const digest=localBotManagedDigest(roster().find(bot=>bot.larkAppId===id));
    const ack=await call(id,'ack',{revision:prepared.revision,requestId:prepared.requestId,digest,
      owner:{allowedUsers:desired.allowedUsers,ownerOpenId:desired.ownerOpenId}});
    if(ack.accepted!==true)throw new LocalBindError(409,'本地配置确认未被数据库接受');
    const runtime=await deps.runtime(id);
    if(!runtime.running||!runtime.generation)throw new LocalBindError(409,'本地进程启动后未通过运行代次确认');
    const observed=await deps.request('/local-claims','POST',{bots:localInventoryEntries(deps.botsJsonPath).map(bot=>(
      bot.appId===id?{...bot,runtimeRunning:true,runtimeGeneration:runtime.generation}:bot))});
    const decision=observed.data?.bots?.find((bot:any)=>bot.appId===id);
    if(observed.status!==200||decision?.action!=='keep')throw new LocalBindError(409,'本地配置已启动，但数据库摘要确认未完成；请刷新后重试');
    if(localBotManagedDigest(roster().find(bot=>bot.larkAppId===id))!==digest){
     await deps.request('/local-claims','POST',{bots:localInventoryEntries(deps.botsJsonPath)});
     throw new LocalBindError(409,'确认期间本地配置发生变化，数据库未标记同步完成');
    }
    return {applied:true,revision:prepared.revision};
   }));
  },
  async switchCli(id:string,input:any){
   if(!roster().some(bot=>bot.larkAppId===id))throw new LocalBindError(400,'本地 Bot 不存在，请先恢复绑定');
   const detail=await call(id,'inspect',{});
   await this.bind(id,{...input,bindingRevision:detail.revision});
   return {changed:true};
  },
  async releaseMissing(id:string,input:any){
   if(input.confirmLocalStop!==true)throw new LocalBindError(400,'请确认停止并解除本地绑定');
   return withLocalInventoryLock(async()=>{
    if(roster().some(bot=>bot.larkAppId===id))throw new LocalBindError(409,'本地配置已恢复，请刷新后通过正常解绑操作处理');
    if(!await deps.isStopped(id)&&!(await deps.stop(id)).ok)throw new LocalBindError(409,'本地进程停止未确认，保留绑定');
    return withFileLock(fleet,async()=>{
     if(!await deps.isStopped(id)||roster().some(bot=>bot.larkAppId===id))throw new LocalBindError(409,'本地状态发生变化，未释放');
     return call(id,'release',{revision:input.bindingRevision,confirmLocalStop:true});
    });
   });
  },
 };
}
