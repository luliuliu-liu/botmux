/** Worker-only fleet pause during native OAuth. Does not alter IM credentials. */
import {join} from 'node:path';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import {withFileLock} from '../../utils/file-lock.js';

export async function nativeWorkerLogin(input:{action:string;loginId:string;expiresAt?:number},deps:{home:string;busy:()=>Promise<boolean>;stop:(id:string)=>Promise<{ok:boolean}>;start:(id:string)=>Promise<{ok:boolean}>;fleet:()=>{rows:Array<{appId:string;alive:boolean;status:string}>}}){
 if(!/^[0-9a-f-]{36}$/.test(input.loginId))throw new Error('invalid_login_id');
 const directory=join(deps.home,'.botmux','platform');mkdirSync(directory,{recursive:true,mode:0o700});
 const file=join(directory,'oauth-fleet.json');
 return withFileLock(join(directory,'native-configuration'),async()=>{
  const previous=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
  if(input.action==='login-pause'){
   if(previous?.active&&previous.loginId!==input.loginId)throw new Error('login_already_active');
   if(await deps.busy())throw new Error('agent_busy');
   const bots=JSON.parse(readFileSync(join(deps.home,'.botmux','bots.json'),'utf8'));
   const ids=bots.map((b:any)=>String(b.larkAppId));
   // Persist before stop so an interrupted request can resume exactly this roster.
   atomicWriteFileSync(file,JSON.stringify({loginId:input.loginId,active:true,ids,expiresAt:input.expiresAt}),{mode:0o600});
   for(const id of ids)if(!(await deps.stop(id)).ok)throw new Error('native_stop_unconfirmed');
   if(deps.fleet().rows.some(r=>ids.includes(r.appId)&&r.alive))throw new Error('native_stop_unconfirmed');
   return {paused:true};
  }
  if(!previous?.active)return {resumed:true};
  if(previous.loginId!==input.loginId)throw new Error('login_identity_mismatch');
  for(const id of previous.ids)if(!(await deps.start(id)).ok)throw new Error('native_start_unconfirmed');
  atomicWriteFileSync(file,JSON.stringify({...previous,active:false}),{mode:0o600});return {resumed:true};
 });
}
