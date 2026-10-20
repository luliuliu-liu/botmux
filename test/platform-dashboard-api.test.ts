import { describe,expect,it,vi } from 'vitest';
import { platformManagementEnabled, createPlatformDashboardApi } from '../src/platform/management/dashboard-api.js';
import { readFileSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
describe('v2 platform boundaries',()=>{
  it('shows missing local configuration without exposing inventory secrets and fences record deletion on process absence',async()=>{
    const names=['BOTMUX_PLATFORM_MANAGED','CONTROL_PLANE_URL','CONTROL_PLANE_SYNC_KEY'] as const;
    const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
    const dir=mkdtempSync(join(tmpdir(),'platform-lifecycle-')),path=join(dir,'bots.json');writeFileSync(path,'[]');
    let stopped=false;
    const fetcher=vi.fn(async(url:string)=>({status:200,json:async()=>url.endsWith('/bots')?{bots:[{appId:'cli_lifecycle',botId:'cli_lifecycle',usage:'local',bindingRevision:1,localAppliedRevision:0,secretConfigured:true}]}:url.endsWith('/cli_free')?{deleted:true}:{ok:true}}));
    try{
      process.env.BOTMUX_PLATFORM_MANAGED='true';process.env.CONTROL_PLANE_URL='http://resource.invalid';process.env.CONTROL_PLANE_SYNC_KEY='fixture-key';vi.stubGlobal('fetch',fetcher);
      const api=createPlatformDashboardApi({botsJsonPath:path,localOnboarding:{} as any,listLocalBots:()=>[],isLocalBotStopped:async()=>stopped,
        localBotRuntime:async()=>({running:true,generation:'dashboard-generation'})});
      const call=async(suffix:string,method='GET',authorized=true)=>{
        let status=0,body='';await api({method,headers:{host:'localhost',origin:'http://localhost','content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify({confirmAppId:'cli_free'});}} as any,
          {writeHead:(v:number)=>status=v,end:(v:string)=>body=v} as any,new URL('http://localhost/api/platform'+suffix),authorized);return {status,body};
      };
      expect(JSON.parse((await call('/bots')).body).bots[0]).toMatchObject({localConfigured:false,localState:'missing'});
      expect((await call('/bots/cli_free','DELETE',false)).status).toBe(401);
      expect((await call('/bots/cli_free','DELETE')).status).toBe(409);
      expect(fetcher.mock.calls.some(([url])=>url.endsWith('/cli_free'))).toBe(false);
      stopped=true;expect(await call('/bots/cli_free','DELETE')).toEqual({status:200,body:JSON.stringify({deleted:true})});
      writeFileSync(path,JSON.stringify([{larkAppId:'cli_native',larkAppSecret:'private-inventory-secret',cliId:'pi'}]));
      expect((await call('/bots')).body).not.toContain('private-inventory-secret');
      const inventory=fetcher.mock.calls.findLast(([url])=>url.endsWith('/local-claims'));
      expect((inventory as any)?.[1].body).not.toContain('private-inventory-secret');
      expect(JSON.parse((inventory as any)?.[1].body).bots[0].digest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse((inventory as any)?.[1].body).bots[0]).toMatchObject({runtimeRunning:true,runtimeGeneration:'dashboard-generation'});
    }finally{vi.unstubAllGlobals();for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}rmSync(dir,{recursive:true,force:true});}
  });
  it('protects existing-app listing/import/refresh with management auth and same-origin JSON',async()=>{
    const old=process.env.BOTMUX_PLATFORM_MANAGED;process.env.BOTMUX_PLATFORM_MANAGED='true';
    const existingBots={list:vi.fn(async()=>({apps:[]})),import:vi.fn(async()=>({imported:true})),refresh:vi.fn(async()=>({refreshed:true}))};
    try{
      const api=createPlatformDashboardApi({botsJsonPath:'/tmp/platform-api-boundary-test/bots.json',localOnboarding:{} as any,listLocalBots:()=>[],existingBots});
      const call=async(path:string,method:string,authorized=true,origin='http://localhost')=>{
        let status=0;await api({method,headers:{host:'localhost',origin,'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify({appId:'cli_one'});}} as any,
          {writeHead:(code:number)=>status=code,end:()=>{}} as any,new URL('http://localhost/api/platform'+path),authorized);return status;
      };
      expect(await call('/feishu-apps','GET',false)).toBe(401);expect(existingBots.list).not.toHaveBeenCalled();
      expect(await call('/bots/import','POST',true,'http://worker.localhost')).toBe(403);expect(existingBots.import).not.toHaveBeenCalled();
      expect(await call('/feishu-apps','GET')).toBe(200);expect(await call('/bots/import','POST')).toBe(201);
      expect(await call('/bots/cli_one/refresh','POST')).toBe(200);expect(existingBots.refresh).toHaveBeenCalledWith('cli_one');
    }finally{if(old===undefined)delete process.env.BOTMUX_PLATFORM_MANAGED;else process.env.BOTMUX_PLATFORM_MANAGED=old;}
  });
  it('proxies model create, save-clone and delete only through authenticated management JSON routes',async()=>{
    const names=['BOTMUX_PLATFORM_MANAGED','CONTROL_PLANE_URL','CONTROL_PLANE_SYNC_KEY'] as const;
    const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
    const fetcher=vi.fn(async(url:string)=>({status:url.endsWith('/local-claims')?200:url.endsWith('/clone')?201:200,json:async()=>({ok:true})}));
    try{
      process.env.BOTMUX_PLATFORM_MANAGED='true';process.env.CONTROL_PLANE_URL='http://resource.invalid';process.env.CONTROL_PLANE_SYNC_KEY='fixture-key';vi.stubGlobal('fetch',fetcher);
      const api=createPlatformDashboardApi({botsJsonPath:'/tmp/platform-api-boundary-test/bots.json',localOnboarding:{} as any,listLocalBots:()=>[]});
      for(const [path,method] of [['/models/chosen','POST'],['/models/source/clone','POST'],['/models/source','DELETE']]){
        let status=0;
        const req={method,headers:{host:'127.0.0.1:7891',origin:'http://127.0.0.1:7891','content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify({profileId:'chosen'});}};
        await api(req as any,{writeHead:(value:number)=>status=value,end:()=>{}} as any,new URL(`http://127.0.0.1:7891/api/platform${path}`),true);
        expect(status).toBe(path.endsWith('/clone')?201:200);
        expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`http://resource.invalid/internal/v1/platform${path}`);
      }
    }finally{vi.unstubAllGlobals();for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}}
  });
  it('does not let a mutable worker env impersonate the immutable image role',()=>{
    const role=process.env.BOTMUX_AGENT_ROLE, managed=process.env.BOTMUX_PLATFORM_MANAGED;
    try {
      process.env.BOTMUX_AGENT_ROLE='worker';process.env.BOTMUX_PLATFORM_MANAGED='true';
      expect(platformManagementEnabled()).toBe(true);
    } finally {
      if(role===undefined)delete process.env.BOTMUX_AGENT_ROLE;else process.env.BOTMUX_AGENT_ROLE=role;
      if(managed===undefined)delete process.env.BOTMUX_PLATFORM_MANAGED;else process.env.BOTMUX_PLATFORM_MANAGED=managed;
    }
  });
  it('requires explicit opt-in and never changes native bot forms into remote configuration',()=>{
    const old=process.env.BOTMUX_PLATFORM_MANAGED;
    try{delete process.env.BOTMUX_PLATFORM_MANAGED;expect(platformManagementEnabled()).toBe(false);
      process.env.BOTMUX_PLATFORM_MANAGED='true';expect(platformManagementEnabled()).toBe(true);
    }finally{if(old===undefined)delete process.env.BOTMUX_PLATFORM_MANAGED;else process.env.BOTMUX_PLATFORM_MANAGED=old;}
    const source=readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx',import.meta.url),'utf8');
    expect(source.match(/disabled=\{onboardingBusy \|\| ui.platformManaged \|\| ui.platformWorker\}/g)).toHaveLength(2);
    expect(source).not.toContain('containerId');
  });
  it('checks shared Feishu login independently of the database and keeps the management auth boundary',async()=>{
    const old=process.env.BOTMUX_PLATFORM_MANAGED;process.env.BOTMUX_PLATFORM_MANAGED='true';
    let checked=0,forced=false;
    try{
      const api=createPlatformDashboardApi({botsJsonPath:'/tmp/platform-api-boundary-test/bots.json',localOnboarding:{} as any,listLocalBots:()=>[],
        readFeishuSession:async force=>{checked++;forced=!!force;return {status:'missing',checkedAt:1};}});
      const call=async(canManage:boolean)=>{
        let status=0,body='';
        await api({method:'GET'} as any,{writeHead:(v:number)=>{status=v;},end:(v:string)=>{body=v;}} as any,
          new URL('http://localhost/api/platform/feishu-session?refresh=1'),canManage);
        return {status,body};
      };
      expect((await call(false)).status).toBe(401);expect(checked).toBe(0);
      const result=await call(true);expect(result.status).toBe(200);expect(JSON.parse(result.body)).toEqual({session:{status:'missing',checkedAt:1}});
      expect(checked).toBe(1);expect(forced).toBe(true);
    }finally{if(old===undefined)delete process.env.BOTMUX_PLATFORM_MANAGED;else process.env.BOTMUX_PLATFORM_MANAGED=old;}
  });
  it('moves the shared QR entry into Bot management without changing unmanaged native behavior',()=>{
    const page=readFileSync(new URL('../src/dashboard/web/platform/management-page.tsx',import.meta.url),'utf8');
    const panel=readFileSync(new URL('../src/dashboard/web/platform/feishu-session-panel.tsx',import.meta.url),'utf8');
    const native=readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx',import.meta.url),'utf8');
    const entry=readFileSync(new URL('../src/dashboard/web/platform/feishu-login-entry.tsx',import.meta.url),'utf8');
    expect(page).toContain("page==='bots'?<FeishuSessionPanel/>");
    expect(panel).toContain('FeishuLoginModal');expect(panel).toContain('refresh(true)');
    expect(panel).toContain('aria-label="当前飞书账号"');
    expect(panel).toContain('identity.userName');expect(panel).toContain('identity.tenantName');expect(panel).toContain('identity.email');
    expect(entry).toContain('ui.platformManaged');expect(entry).toContain('href="#/platform-bots"');
    expect(native).toContain('status && !(ui.platformManaged && loginVisible)');
    expect(native).toContain('export function FeishuLoginModal');
    const server=readFileSync(new URL('../src/dashboard.ts',import.meta.url),'utf8');
    expect(server).toContain('displayName:bot.displayName||online.get(bot.larkAppId)||persisted.get(bot.larkAppId)||bot.name');
  });
  it('rejects unauthenticated access and never proxies secret dispatch or raw bot registration to browsers',async()=>{
    const old=process.env.BOTMUX_PLATFORM_MANAGED;
    process.env.BOTMUX_PLATFORM_MANAGED='true';
    try {
      const api=createPlatformDashboardApi({botsJsonPath:'/tmp/platform-api-boundary-test/bots.json',localOnboarding:{} as any,listLocalBots:()=>[]});
      const call=async(path:string,method:string,canManage:boolean)=>{
        let status=0,body='';
        const res={writeHead:(value:number)=>{status=value;},end:(value:string)=>{body=value;}} as any;
        await api({method} as any,res,new URL(`http://localhost/api/platform${path}`),canManage);
        return {status,body};
      };
      expect((await call('/bots','GET',false)).status).toBe(401);
      expect((await call('/workspaces','PUT',false)).status).toBe(401);
      expect((await call('/models/source/clone','POST',false)).status).toBe(401);
      expect((await call('/models/source','POST',false)).status).toBe(401);
      expect((await call('/models/source','DELETE',false)).status).toBe(401);
      expect((await call('/local-bots/cli_test/unbind','POST',false)).status).toBe(401);
      expect((await call('/local-release','POST',true)).status).toBe(404);
      expect((await call('/workspaces','DELETE',true)).status).toBe(405);
      expect((await call('/bots','POST',true)).status).toBe(405);
      expect((await call('/dispatch-targets','GET',true)).status).toBe(404);
      expect((await call('/dispatch/any/prompt','POST',true)).status).toBe(404);
    }finally{if(old===undefined)delete process.env.BOTMUX_PLATFORM_MANAGED;else process.env.BOTMUX_PLATFORM_MANAGED=old;}
  });
  it('rejects a sibling Worker Origin and simple form posts before any mutation',async()=>{
    const old=process.env.BOTMUX_PLATFORM_MANAGED;process.env.BOTMUX_PLATFORM_MANAGED='true';
    try{
      const api=createPlatformDashboardApi({botsJsonPath:'/tmp/platform-api-boundary-test/bots.json',localOnboarding:{} as any,listLocalBots:()=>[]});
      for(const headers of [
        {host:'control.example.com',origin:'https://worker.example.com','content-type':'application/json'},
        {host:'control.example.com',origin:'https://control.example.com','content-type':'text/plain'},
        {host:'127.0.0.1:7891',origin:'http://127.0.0.1:7892','content-type':'application/json'},
        {host:'control.example.com','sec-fetch-site':'same-site','content-type':'application/json'},
      ]){
        let status=0;
        await api({method:'POST',headers} as any,{writeHead:(v:number)=>status=v,end:()=>{}} as any,new URL('http://control.example.com/api/platform/containers'),true);
        expect(status).toBe(403);
      }
    }finally{if(old===undefined)delete process.env.BOTMUX_PLATFORM_MANAGED;else process.env.BOTMUX_PLATFORM_MANAGED=old;}
  });
});
