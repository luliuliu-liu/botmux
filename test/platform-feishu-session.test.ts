import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuSessionReader } from '../src/platform/management/feishu-session.js';
import { writeStoredCookiesToSessionFile } from '../src/setup/open-platform-automation.js';

const dirs:string[]=[];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'platform-feishu-session-'));dirs.push(dir);return join(dir,'session.json');}
function save(file:string,value='private-cookie'){
  writeStoredCookiesToSessionFile(file,[{name:'session',value,domain:'.feishu.cn',path:'/',secure:true,httpOnly:true,hostOnly:false}]);
}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});vi.unstubAllGlobals();});
describe('platform Feishu shared session health',()=>{
  it('reports missing/expired without starting login or inspecting a nonexistent session',async()=>{
    const file=fixture(),inspect=vi.fn();const read=createFeishuSessionReader({sessionFile:file,inspect});
    expect((await read()).status).toBe('missing');
    writeFileSync(file,'{"cookies":[]}');expect((await read()).status).toBe('expired');
    expect(inspect).not.toHaveBeenCalled();
  });
  it('projects health only, caches checks, and revalidates when the native login file changes',async()=>{
    const file=fixture();save(file);
    const inspect=vi.fn(async()=>({ok:true as const,source:'botmux_cache' as const,sessionFile:file,
      identity:{userId:'private-user',userName:'private-name',tenantId:'private-tenant',tenantName:'private-org'}}));
    const read=createFeishuSessionReader({sessionFile:file,inspect,now:()=>1000});
    expect(await read()).toEqual({status:'ready',checkedAt:1000});await read();expect(inspect).toHaveBeenCalledTimes(1);
    save(file,'new-private-cookie-with-new-length');await read();expect(inspect).toHaveBeenCalledTimes(2);
    await read(true);expect(inspect).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(await read())).not.toMatch(/private|sessionFile|identity|cookies/);
  });
  it('separates rejected credentials from inconclusive network errors',async()=>{
    const file=fixture();save(file);
    const expired=createFeishuSessionReader({sessionFile:file,inspect:async()=>({ok:false,reason:'invalid_session',message:'private error'})});
    expect((await expired()).status).toBe('expired');
    const unavailable=createFeishuSessionReader({sessionFile:file,inspect:async()=>{throw new Error('private error');}});
    expect((await unavailable()).status).toBe('unknown');
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('offline');}));
    const swallowed=createFeishuSessionReader({sessionFile:file,inspect:async opts=>{
      await opts!.fetchImpl!('https://example.com').catch(()=>{});
      return {ok:false,reason:'invalid_session',message:'upstream hides a network failure'};
    }});
    expect((await swallowed()).status).toBe('unknown');
  });
});
