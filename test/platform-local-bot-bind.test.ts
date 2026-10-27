import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalBotBinder,localInventoryEntries} from '../src/platform/management/local-bot-bind.js';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'local-bind-'));dirs.push(dir);const path=join(dir,'bots.json');writeFileSync(path,'[]');
 const config={larkAppId:'cli_target',larkAppSecret:'private-target',displayName:'cli_target',cliId:'codex',allowedUsers:['owner@example.com'],defaultWorkingDir:'/workspace'};
 const request=vi.fn(async(p:string,_m?:string,_b?:any)=>({status:200,data:p.endsWith('/inspect')?{revision:1,appliedRevision:0,ownerConfigured:true}:p.endsWith('/prepare')?{revision:2,requestId:'pending-id',config}:p.endsWith('/ack')?{accepted:true}:p.endsWith('/local-claims')?{bots:[{appId:'cli_target',action:'keep'}]}:{released:true}}));
 const stop=vi.fn(async()=>({ok:true})),start=vi.fn(async()=>({ok:true})),isStopped=vi.fn(async()=>true),busy=vi.fn(async()=>false),validateOwners=vi.fn(async()=>[] as string[]);
 const binder=createLocalBotBinder({botsJsonPath:path,gatewayId:'gateway',request,stop,start,isStopped,busy,validateOwners,
  runtime:async()=>({running:true,generation:'fixture-generation'})});
 const input={bindingRevision:1,cliId:'codex',confirmRestart:true};return {dir,path,config,request,stop,start,isStopped,busy,validateOwners,binder,input};
}
describe('database-owned native local Bot restore',()=>{
 it('restores only IM/CLI configuration, confirms start and ACK, and leaves global login/model files unchanged',async()=>{
  const f=fixture(),auth=join(f.dir,'auth.json');writeFileSync(auth,'global-oauth-token');
  f.start.mockImplementation(async()=>{expect(JSON.parse(readFileSync(f.path,'utf8'))).toEqual([f.config]);return {ok:true};});
  const result=await f.binder.bind('cli_target',f.input);expect(result).toEqual({applied:true,revision:2});
  expect(f.request.mock.calls.some(([p])=>p.endsWith('/ack'))).toBe(true);expect(f.request.mock.calls.at(-1)?.[0]).toContain('/local-claims');expect(JSON.stringify(result)).not.toContain('private-target');
  expect(readFileSync(auth,'utf8')).toBe('global-oauth-token');
  expect(localInventoryEntries(f.path)[0]).toMatchObject({appId:'cli_target'});
  expect(JSON.stringify(localInventoryEntries(f.path))).not.toContain('private-target');
 });
 it('does not overwrite or restart a busy existing Bot',async()=>{
  const f=fixture();writeFileSync(f.path,JSON.stringify([f.config]));f.busy.mockResolvedValue(true);f.isStopped.mockResolvedValue(false);
  await expect(f.binder.bind('cli_target',f.input)).rejects.toThrow('执行任务');expect(f.stop).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
 });
 it('never acknowledges an unconfirmed start or overwrites concurrent native changes',async()=>{
  const f=fixture();f.start.mockResolvedValue({ok:false});await expect(f.binder.bind('cli_target',f.input)).rejects.toThrow('启动未确认');
  expect(f.request.mock.calls.some(([p])=>p.endsWith('/ack'))).toBe(false);
  const other=fixture();writeFileSync(other.path,JSON.stringify([other.config]));other.stop.mockImplementation(async()=>{writeFileSync(other.path,JSON.stringify([{...other.config,displayName:'concurrent'}]));return {ok:true};});
  await expect(other.binder.bind('cli_target',other.input)).rejects.toThrow('并发修改');expect(other.start).not.toHaveBeenCalled();
 });
 it('requires stable target-app owner when a DB record lacks owner and never copies an open_id',async()=>{
  const f=fixture();delete (f.config as any).allowedUsers;
  f.request.mockImplementation(async(p)=>({status:200,data:p.endsWith('/inspect')?{revision:1,appliedRevision:0,ownerConfigured:false}:p.endsWith('/prepare')?{revision:2,requestId:'pending-id',config:f.config}:{accepted:true}}));
  await expect(f.binder.bind('cli_target',f.input)).rejects.toThrow('所有者');
  await expect(f.binder.bind('cli_target',{...f.input,owner:'ou_other_app'})).rejects.toThrow('open_id');
  expect(f.request.mock.calls.some(([p])=>p.endsWith('/prepare'))).toBe(false);
 });
 it('releases a missing roster entry only after exact process absence and preserves it on unconfirmed stop',async()=>{
  const f=fixture();expect(await f.binder.releaseMissing('cli_target',{bindingRevision:1,confirmLocalStop:true})).toEqual({released:true});
  expect(f.request.mock.calls.at(-1)?.[0]).toContain('/release');
  const other=fixture();other.isStopped.mockResolvedValue(false);other.stop.mockResolvedValue({ok:false});
  await expect(other.binder.releaseMissing('cli_target',{bindingRevision:1,confirmLocalStop:true})).rejects.toThrow('未确认');expect(other.request).not.toHaveBeenCalled();
 });
 it('CLI switching uses the DB prepare/ACK fence and adopts only this same native application owner',async()=>{
  const f=fixture();writeFileSync(f.path,JSON.stringify([{...f.config,cliId:'pi',allowedUsers:['ou_this_target']} ]));
  delete (f.config as any).allowedUsers;
  f.request.mockImplementation(async(p,_m,body)=>{
   if(p.endsWith('/inspect'))return {status:200,data:{revision:1,appliedRevision:0,ownerConfigured:false}} as any;
   if(p.endsWith('/prepare'))return {status:200,data:{revision:2,requestId:'pending-id',config:{...f.config,allowedUsers:body.owner.allowedUsers}}} as any;
   if(p.endsWith('/ack'))return {status:200,data:{accepted:true}} as any;
   return {status:200,data:{bots:[{appId:'cli_target',action:'keep'}]}} as any;
  });
  expect(await f.binder.switchCli('cli_target',{cliId:'codex',confirmRestart:true})).toEqual({changed:true});
  expect(f.validateOwners).toHaveBeenCalledWith('cli_target','private-target','feishu',['ou_this_target']);
  expect(f.request.mock.calls.find(([p])=>p.endsWith('/prepare'))?.[2]).toMatchObject({cliId:'codex',owner:{allowedUsers:['ou_this_target']}});
  expect(f.request.mock.calls.some(([p])=>p.endsWith('/ack'))).toBe(true);
 });
});
