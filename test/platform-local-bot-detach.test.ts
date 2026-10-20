import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,readFileSync,statSync,writeFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalBotDetacher,localBotRevision } from '../src/platform/management/local-bot-detach.js';
import { withLocalInventoryLock } from '../src/platform/management/local-inventory-lock.js';
const directories:string[]=[];
afterEach(()=>{for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'local-detach-'));directories.push(dir);const path=join(dir,'bots.json');
  const bot={larkAppId:'cli_local',larkAppSecret:'private-test-secret',allowedUsers:['ou_same_app_owner'],name:'local'},other={larkAppId:'cli_other',larkAppSecret:'other-secret'};
  writeFileSync(path,JSON.stringify([bot,other]));
  const stop=vi.fn(async(_id:string)=>({ok:true})),release=vi.fn(async(_body:unknown)=>({status:200,data:{released:true}}));
  const isStopped=vi.fn(async()=>true);const detacher=createLocalBotDetacher({botsJsonPath:path,stop,release,isStopped});return {dir,path,bot,other,stop,release,isStopped,detacher};
}
describe('explicit local Bot release',()=>{
  it('stops exact app, preserves unrelated settings and retains a private recovery copy before releasing',async()=>{
    const f=fixture();expect(f.detacher.revision('cli_local')).toBe(localBotRevision(f.bot));
    f.release.mockImplementation(async()=>{expect(existsSync(`${f.path}.lock`)).toBe(true);expect(existsSync(join(f.dir,'pm2-fleet-mutation.lock'))).toBe(true);return {status:200,data:{released:true}};});
    await expect(f.detacher.detach('cli_local',localBotRevision(f.bot),true,'Local Bot')).resolves.toEqual({released:true});
    expect(f.stop).toHaveBeenCalledWith('cli_local');expect(JSON.parse(readFileSync(f.path,'utf8'))).toEqual([f.other]);expect(f.detacher.pending()).toEqual([]);
    const backup=join(f.dir,'platform','local-detach','cli_local.json');expect(statSync(backup).mode&0o777).toBe(0o600);
    expect(f.release.mock.calls[0][0]).toMatchObject({appId:'cli_local',appSecret:'private-test-secret',owner:{allowedUsers:['ou_same_app_owner']}});
  });
  it('never stops without explicit confirmation or after a config revision changes',async()=>{
    const f=fixture();await expect(f.detacher.detach('cli_local',localBotRevision(f.bot),false,'test')).rejects.toThrow('确认');
    await expect(f.detacher.detach('cli_local','f'.repeat(64),true,'test')).rejects.toThrow('变化');expect(f.stop).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
  });
  it('does not release or remove the roster when native stop is unconfirmed',async()=>{
    const f=fixture();f.stop.mockResolvedValue({ok:false});await expect(f.detacher.detach('cli_local',localBotRevision(f.bot),true,'test')).rejects.toThrow('停止未确认');
    expect(JSON.parse(readFileSync(f.path,'utf8'))).toEqual([f.bot,f.other]);expect(f.release).not.toHaveBeenCalled();expect(f.detacher.pending()[0].localDetachPending).toBe(true);
  });
  it('retries DB finalization after roster removal and process restart, using the same operation identity',async()=>{
    const f=fixture();f.release.mockResolvedValueOnce({status:503,data:{released:false}});
    await expect(f.detacher.detach('cli_local',localBotRevision(f.bot),true,'test')).rejects.toThrow('尚未确认');
    const restarted=createLocalBotDetacher({botsJsonPath:f.path,stop:f.stop,release:f.release,isStopped:f.isStopped});expect(restarted.pending()).toHaveLength(1);
    await restarted.detach('cli_local',localBotRevision(f.bot),true,'test');expect(f.stop).toHaveBeenCalledTimes(1);
    expect((f.release.mock.calls[0][0] as any).requestId).toBe((f.release.mock.calls[1][0] as any).requestId);expect(restarted.pending()).toEqual([]);
  });
  it('preserves concurrent native edits instead of releasing a changed Bot',async()=>{
    const f=fixture();f.stop.mockImplementation(async()=>{writeFileSync(f.path,JSON.stringify([{...f.bot,name:'changed'},f.other]));return {ok:true};});
    await expect(f.detacher.detach('cli_local',localBotRevision(f.bot),true,'test')).rejects.toThrow('配置已变化');expect(f.release).not.toHaveBeenCalled();expect(JSON.parse(readFileSync(f.path,'utf8'))[0].name).toBe('changed');
  });
  it('does not release a Bot restarted between native stop and fleet lock reacquisition',async()=>{
    const f=fixture();f.isStopped.mockResolvedValue(false);await expect(f.detacher.detach('cli_local',localBotRevision(f.bot),true,'test')).rejects.toThrow('停止状态不可确认');expect(f.release).not.toHaveBeenCalled();expect(JSON.parse(readFileSync(f.path,'utf8'))).toHaveLength(2);
  });
  it('rejects missing owner before stopping and serializes stale inventory ahead of release',async()=>{
    const f=fixture();writeFileSync(f.path,JSON.stringify([{...f.bot,allowedUsers:[]},f.other]));
    await expect(f.detacher.detach('cli_local',localBotRevision({...f.bot,allowedUsers:[]}),true,'test')).rejects.toThrow('owner');expect(f.stop).not.toHaveBeenCalled();
    const order:string[]=[];let unblock!:()=>void;
    const inventory=withLocalInventoryLock(async()=>{order.push('inventory');await new Promise<void>(resolve=>{unblock=resolve;});});
    await Promise.resolve();const release=withLocalInventoryLock(async()=>{order.push('release');});expect(order).toEqual(['inventory']);unblock();await inventory;await release;expect(order).toEqual(['inventory','release']);
  });
});
