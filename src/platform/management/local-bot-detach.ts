import { createHash,randomUUID } from 'node:crypto';
import { existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,readdirSync,unlinkSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { mutateBotsJsonAtomic } from '../../setup/bots-store.js';
import { withFileLock } from '../../utils/file-lock.js';
import { withLocalInventoryLock } from './local-inventory-lock.js';

export function localBotRevision(bot:unknown){return createHash('sha256').update(JSON.stringify(bot)).digest('hex');}
export class LocalDetachError extends Error {constructor(readonly status:number,message:string){super(message);}}
type Job={appId:string;revision:string;requestId:string;displayName:string;config:any;completed?:boolean};
export function createLocalBotDetacher(deps:{botsJsonPath:string;stop:(appId:string)=>Promise<{ok:boolean}>;
  isStopped:(appId:string)=>Promise<boolean>;release:(body:unknown)=>Promise<{status:number;data:any}>}){
  const directory=join(dirname(deps.botsJsonPath),'platform','local-detach');mkdirSync(directory,{recursive:true,mode:0o700});
  const file=(appId:string)=>join(directory,`${appId}.json`);
  const current=()=>{const value=JSON.parse(readFileSync(deps.botsJsonPath,'utf8'));if(!Array.isArray(value))throw new LocalDetachError(409,'本地配置格式无效');return value;};
  const read=(appId:string):Job|null=>existsSync(file(appId))?JSON.parse(readFileSync(file(appId),'utf8')):null;
  const save=(job:Job)=>{const p=file(job.appId),tmp=`${p}.${randomUUID()}.tmp`;writeFileSync(tmp,JSON.stringify(job),{mode:0o600});renameSync(tmp,p);};
  return {
    forget(appId:string){if(!/^[A-Za-z0-9._-]+$/.test(appId))throw new LocalDetachError(400,'App ID 无效');if(existsSync(file(appId)))unlinkSync(file(appId));},
    revision(appId:string){const bot=current().find(bot=>bot.larkAppId===appId);return bot?localBotRevision(bot):undefined;},
    pending(){return readdirSync(directory).filter(name=>/^[A-Za-z0-9._-]+\.json$/.test(name)).flatMap(name=>{const appId=name.slice(0,-5),job=read(appId);return job&&!job.completed?[{appId,displayName:job.displayName,localRevision:job.revision,localDetachPending:true}]:[];});},
    async detach(appId:string,revision:unknown,confirmed:unknown,displayName:string){
      if(!/^[A-Za-z0-9._-]+$/.test(appId)||typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision)||confirmed!==true)throw new LocalDetachError(400,'请确认停止本地 Agent，并刷新机器人配置后重试');
      return withLocalInventoryLock(()=>withFileLock(join(directory,'operation'),async()=>{
        let config=current().find(bot=>bot.larkAppId===appId),job=read(appId);
        if(config){
          if(localBotRevision(config)!==revision)throw new LocalDetachError(409,'本地配置已变化，请刷新后确认');
          const allowedUsers=Array.isArray(config.allowedUsers)?config.allowedUsers.filter((v:unknown)=>typeof v==='string'&&v.trim()):[];
          if(!allowedUsers.length&&typeof config.ownerOpenId==='string'&&config.ownerOpenId.startsWith('ou_'))allowedUsers.push(config.ownerOpenId);
          if(!config.larkAppSecret||!allowedUsers.length)throw new LocalDetachError(409,'缺少现有凭据或已验证 owner，请先在本地 Bot 配置中补齐，未停止机器人');
          // Save an exact private recovery copy before stopping anything.
          job={appId,revision,requestId:job?.revision===revision&&!job.completed?job.requestId:randomUUID(),displayName,config:{...config,allowedUsers}};save(job);
          const stopped=await deps.stop(appId);
          if(!stopped.ok)throw new LocalDetachError(409,'本地停止未确认，保留占用，请重试');
        }else if(!job||job.revision!==revision)throw new LocalDetachError(409,'本地机器人记录已变化，请刷新');
        // Reacquire the native fleet mutation lock AFTER stop-bot exits. This
        // fences a concurrent start/restart before removing the roster entry.
        return withFileLock(join(dirname(deps.botsJsonPath),'pm2-fleet-mutation'),async()=>{
          if(!await deps.isStopped(appId))throw new LocalDetachError(409,'本地进程又启动或停止状态不可确认，保留占用，请重试');
          if(config)mutateBotsJsonAtomic(deps.botsJsonPath,bots=>{
            const live=bots.find(bot=>bot.larkAppId===appId);
            if(!live||localBotRevision(live)!==revision)throw new LocalDetachError(409,'停止期间配置已变化，保留占用，请刷新后重试');
            return bots.filter(bot=>bot.larkAppId!==appId);
          });
          // Fence native config writers too: adding the same App back while
          // releasing its reservation must not appear to complete a detach.
          return withFileLock(deps.botsJsonPath,async()=>{
            if(current().some(bot=>bot.larkAppId===appId))throw new LocalDetachError(409,'本地机器人已重新加入，请刷新');
            // A repeat after DB commit is safe; a DB failure keeps the private
            // job available even after removing the native fleet entry.
            const result=await deps.release({appId,requestId:job!.requestId,displayName:job!.displayName,
              brand:job!.config.brand==='lark'?'lark':'feishu',appSecret:job!.config.larkAppSecret,
              owner:{allowedUsers:job!.config.allowedUsers,ownerOpenId:job!.config.ownerOpenId}});
            if(result.status!==200||result.data.released!==true)throw new LocalDetachError(409,result.data.message||'本地已停止，入池尚未确认；请重试解绑，勿重新创建');
            save({...job!,completed:true});return {released:true};
          });
        });
      }));
    },
  };
}
