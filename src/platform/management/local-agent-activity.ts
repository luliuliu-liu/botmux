import {setTimeout as sleep} from 'node:timers/promises';
export type LocalAgentActivity='idle'|'busy'|'unavailable';
export class LocalAgentReadinessError extends Error{
 constructor(readonly state:'busy'|'unavailable'){super(state==='busy'?'本地 Agent 正在执行任务':'本地 Agent 重启后未就绪，已确认的配置保留，请稍后重试');}
}
/** 必须由认证daemon响应证明空闲；聚合列表空白、进程存在均不足以证明。 */
export async function probeLocalAgentActivity(ids:string[],read:(id:string)=>Promise<Response|null>):Promise<LocalAgentActivity>{
 let unavailable=false;
 for(const id of ids){
  try{
   const response=await read(id);if(!response?.ok){unavailable=true;continue;}
   const body=await response.json(),sessions=Array.isArray(body)?body:body?.sessions;
   if(!Array.isArray(sessions)||sessions.some(s=>!s||typeof s.status!=='string')){unavailable=true;continue;}
   if(sessions.some(s=>!['idle','closed','dormant','waiting'].includes(s.status)))return 'busy';
  }catch{unavailable=true;}
 }
 return unavailable?'unavailable':'idle';
}
export async function waitForLocalAgentReady(probe:()=>Promise<LocalAgentActivity>,options:{timeoutMs?:number;now?:()=>number;delay?:(ms:number)=>Promise<unknown>}={}):Promise<void>{
 const timeout=options.timeoutMs??10000,now=options.now??Date.now,delay=options.delay??sleep,start=now();
 for(;;){
  let timer:ReturnType<typeof setTimeout>|undefined;
  const left=timeout-(now()-start);if(left<=0)throw new LocalAgentReadinessError('unavailable');
  let state:LocalAgentActivity|'probe-timeout';
  try{state=await Promise.race([probe().catch(()=> 'unavailable' as const),new Promise<'probe-timeout'>(resolve=>{timer=setTimeout(()=>resolve('probe-timeout'),Math.min(2000,left));})]);}
  finally{if(timer)clearTimeout(timer);}
  // 一个探针卡住就结束本轮，不启动第二个与它重叠的请求。
  if(state==='probe-timeout')throw new LocalAgentReadinessError('unavailable');
  if(state==='idle')return;
  if(state==='busy')throw new LocalAgentReadinessError('busy');
  if(now()-start>=timeout)throw new LocalAgentReadinessError('unavailable');
  await delay(Math.min(200,timeout-(now()-start)));
 }
}
