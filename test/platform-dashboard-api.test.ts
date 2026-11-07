import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { platformManagementEnabled, createPlatformDashboardApi, localBotDisplayNames } from '../src/platform/management/dashboard-api.js';
import {WorkerDashboardEntryError} from '../src/platform/management/worker-dashboard-proxy.js';
// Management fixtures explicitly select Control; a Dev image defaults to Worker.
beforeEach(()=>vi.stubEnv('BOTMUX_AGENT_ROLE','control'));
afterEach(()=>vi.unstubAllEnvs());
import { readFileSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import { FeishuLoginEntry } from '../src/dashboard/web/platform/feishu-login-entry.js';
import { findDashboardRoute } from '../src/dashboard/web/dashboard-routes.js';
import { ui } from '../src/dashboard/web/ui.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import {join} from 'node:path';
import {tmpdir} from 'node:os';
describe('pool proxy boundaries',()=>{
 it('uses exact paths, methods, management auth and gateway credentials for all pool operations',async()=>{
  const names=['BOTMUX_PLATFORM_MANAGED','CONTROL_PLANE_URL','CONTROL_PLANE_SYNC_KEY','BOTMUX_PLATFORM_GATEWAY_ID','BOTMUX_PLATFORM_GATEWAY_KEY'];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]])),dir=mkdtempSync(join(tmpdir(),'pool-proxy-'));
  const fetcher=vi.fn(async()=>({status:200,json:async()=>({cancelled:true,members:[]})}));
  const pool='/agent-pools/11111111-1111-4111-8111-111111111111',member=pool+'/members/22222222-2222-4222-8222-222222222222';
  try{
   Object.assign(process.env,{BOTMUX_PLATFORM_MANAGED:'true',CONTROL_PLANE_URL:'http://resource.invalid',CONTROL_PLANE_SYNC_KEY:'fixture-sync',BOTMUX_PLATFORM_GATEWAY_ID:'fixture-gateway',BOTMUX_PLATFORM_GATEWAY_KEY:'fixture-key'});vi.stubGlobal('fetch',fetcher);
   const api=createPlatformDashboardApi({botsJsonPath:join(dir,'bots.json'),localOnboarding:{} as any,listLocalBots:()=>[]});
   const call=async(path:string,method:string,authorized=true,origin='http://localhost',contentType='application/json')=>{let status=0;await api({method,headers:{host:'localhost',origin,'content-type':contentType},async *[Symbol.asyncIterator](){yield '{"revision":7}';}} as any,{writeHead:(code:number)=>status=code,end:()=>{}} as any,new URL('http://localhost/api/platform'+path),authorized);return status;};
   const allowed:Array<[string,string[]]>=[['/mcp-servers',['GET','POST']],['/mcp-servers/11111111-1111-4111-8111-111111111111',['PUT','DELETE']],['/host-mounts',['GET','POST']],['/host-mounts/11111111-1111-4111-8111-111111111111',['PUT','DELETE']],['/report-settings',['GET','PUT']],['/workflow-retention/capacity',['GET']],['/workflow-retention/preview?successLogDays=7&limit=1',['GET']],['/agent-pools',['GET','POST']],[pool,['GET','DELETE']],[pool+'/members',['POST']],[pool+'/enroll',['POST']],[member,['PUT','DELETE']],...[ '/rebuild','/reconcile','/configuration','/configuration/cancel'].map(suffix=>[member+suffix,['POST']] as [string,string[]]),['/workflow-resources',['GET']],['/workflow-resources/run',['GET']],['/workflow-resources/run/22222222-2222-4222-8222-222222222222/resolve',['POST']],['/workflow-resources/run/22222222-2222-4222-8222-222222222222/cancel',['POST']]];
   for(const [path,methods] of allowed){
    for(const method of ['GET','POST','PUT','PATCH','DELETE']){
     fetcher.mockClear();expect(await call(path,method,false)).toBe(401);expect(fetcher).not.toHaveBeenCalled();
     if(method!=='GET'){expect(await call(path,method,true,'http://worker.localhost')).toBe(403);expect(await call(path,method,true,'http://localhost','text/plain')).toBe(403);expect(fetcher).not.toHaveBeenCalled();}
     expect(await call(path,method)).toBe(methods.includes(method)?200:405);
     if(methods.includes(method)){
      expect(fetcher).toHaveBeenCalledOnce();const [url,request]=fetcher.mock.calls[0] as any;
      expect(url).toBe('http://resource.invalid/internal/v1/platform'+path);expect(request.method).toBe(method);
      expect(request.headers).toMatchObject({'x-api-key':'fixture-sync','x-platform-gateway-id':'fixture-gateway','x-platform-gateway-key':'fixture-key'});
      expect(request.body).toBe(method==='GET'?undefined:'{"revision":7}');
     }else expect(fetcher).not.toHaveBeenCalled();
    }
   }
   for(const path of ['/mcp-targets/control/ack','/mcp-targets/control/restore','/mcp-servers/not-a-uuid','/mcp-targets/control/extra','/host-mounts/not-a-uuid','/host-mounts/11111111-1111-4111-8111-111111111111/extra','/report-settings/extra','/report-deliveries','/report-deliveries/run/claim',member+'/configuration/cancel/extra',member+'/configuration/cancelled',member+'/configuration/retry',member+'/reconcile/cancel',member+'/rebuild/cancel',pool+'/enroll/22222222-2222-4222-8222-222222222222/configuration','/agent-pools/'+ '-'.repeat(36)+'/members',member+'/configuration/']){
    fetcher.mockClear();expect(await call(path,'POST')).toBe(404);expect(fetcher).not.toHaveBeenCalled();
   }
   process.env.BOTMUX_PLATFORM_MANAGED='false';fetcher.mockClear();expect(await call(member+'/configuration','POST')).toBe(404);expect(fetcher).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}rmSync(dir,{recursive:true,force:true});}
 });
});
describe('v2 platform boundaries',()=>{
  it('工作台未配置远程域名时返回明确诊断，保留管理登录与CSRF守卫',async()=>{
    vi.stubEnv('BOTMUX_PLATFORM_MANAGED','true');
    const dir=mkdtempSync(join(tmpdir(),'workbench-domain-'));
    try{
      const open=vi.fn(async()=>{throw new WorkerDashboardEntryError('worker_dashboard_domain_required','请配置实例泛域名');});
      const api=createPlatformDashboardApi({botsJsonPath:join(dir,'bots.json'),localOnboarding:{} as any,listLocalBots:()=>[],openWorkerDashboard:open});
      const path='/api/platform/containers/11111111-1111-4111-8111-111111111111/dashboard';
      const call=async(authorized:boolean,origin='http://10.37.47.13:17891')=>{let status=0,body='';
        await api({method:'POST',headers:{host:'10.37.47.13:17891',origin,'content-type':'application/json'},async *[Symbol.asyncIterator](){yield '{}';}} as any,
          {writeHead:(value:number)=>status=value,end:(value:string)=>body=value} as any,new URL('http://10.37.47.13:17891'+path),authorized);
        return {status,body:JSON.parse(body)};
      };
      expect((await call(false)).status).toBe(401);expect(open).not.toHaveBeenCalled();
      expect((await call(true,'http://worker.localhost')).status).toBe(403);expect(open).not.toHaveBeenCalled();
      expect(await call(true)).toMatchObject({status:409,body:{error:'worker_dashboard_domain_required',message:'请配置实例泛域名'}});
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it('routes authenticated local ZCode login requests to the native-login handler',async()=>{
    const old=process.env.BOTMUX_PLATFORM_MANAGED,dir=mkdtempSync(join(tmpdir(),'local-zcode-route-'));
    process.env.BOTMUX_PLATFORM_MANAGED='true';
    try{
      const api=createPlatformDashboardApi({botsJsonPath:join(dir,'bots.json'),localOnboarding:{} as any,listLocalBots:()=>[]});
      let status=0,body='';
      await api({method:'POST',headers:{host:'localhost',origin:'http://localhost','content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify({action:'invalid'});}} as any,
        {writeHead:(value:number)=>status=value,end:(value:string)=>body=value} as any,new URL('http://localhost/api/platform/local-agent/zcode/login'),true);
      expect(status).toBe(400);expect(JSON.parse(body).error).toBe('local_agent_failed');
    }finally{if(old===undefined)delete process.env.BOTMUX_PLATFORM_MANAGED;else process.env.BOTMUX_PLATFORM_MANAGED=old;rmSync(dir,{recursive:true,force:true});}
  });
  it('gates image-cache and manual-browser operations behind management authentication and same-origin JSON',async()=>{
    const keys=['BOTMUX_PLATFORM_MANAGED','CONTROL_PLANE_URL','CONTROL_PLANE_SYNC_KEY'],before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
    const fetcher=vi.fn(async()=>({status:200,json:async()=>({ok:true})}));
    try{
      process.env.BOTMUX_PLATFORM_MANAGED='true';process.env.CONTROL_PLANE_URL='http://resource.invalid';process.env.CONTROL_PLANE_SYNC_KEY='fixture';vi.stubGlobal('fetch',fetcher);
      const api=createPlatformDashboardApi({botsJsonPath:'/tmp/platform-browser-boundary/bots.json',localOnboarding:{} as any,listLocalBots:()=>[]});
      const call=async(path:string,authorized:boolean,origin:string)=>{let status=0;await api({method:'POST',headers:{host:'localhost',origin,'content-type':'application/json'},async *[Symbol.asyncIterator](){yield '{}';}} as any,{writeHead:(s:number)=>status=s,end:()=>{}} as any,new URL('http://localhost/api/platform'+path),authorized);return status;};
      for(const path of ['/image-cache/registry','/image-cache/refresh','/image-cache/pull','/image-cache/pull-latest','/image-cache/remove','/browsers']){
        expect(await call(path,false,'http://localhost')).toBe(401);expect(await call(path,true,'http://other.localhost')).toBe(403);
        expect(await call(path,true,'http://localhost')).toBe(200);expect(fetcher.mock.calls.at(-1)?.[0]).toBe('http://resource.invalid/internal/v1/platform'+path);
      }
    }finally{vi.unstubAllGlobals();for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}}
  });
  it('protects Worker Skill sync with owner authentication and same-origin JSON',async()=>{
    const names=['BOTMUX_PLATFORM_MANAGED','CONTROL_PLANE_URL','CONTROL_PLANE_SYNC_KEY'] as const;
    const before=Object.fromEntries(names.map(name=>[name,process.env[name]])),fetcher=vi.fn(async()=>({status:200,json:async()=>({workers:[]})}));
    try{
      process.env.BOTMUX_PLATFORM_MANAGED='true';process.env.CONTROL_PLANE_URL='http://resource.invalid';process.env.CONTROL_PLANE_SYNC_KEY='fixture';vi.stubGlobal('fetch',fetcher);
      const api=createPlatformDashboardApi({botsJsonPath:'/tmp/skill-sync-boundary/bots.json',localOnboarding:{} as any,listLocalBots:()=>[]});
      const call=async(path:string,method:string,authorized=true,origin='http://localhost')=>{
        let status=0;await api({method,headers:{host:'localhost',origin,'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify({names:[]});}} as any,{writeHead:(code:number)=>status=code,end:()=>{}} as any,new URL('http://localhost/api/platform'+path),authorized);return status;
      };
      expect(await call('/skill-sync','GET',false)).toBe(401);expect(fetcher).not.toHaveBeenCalled();
      expect(await call('/skill-sync/11111111-1111-4111-8111-111111111111','POST',true,'http://worker.localhost')).toBe(403);expect(fetcher).not.toHaveBeenCalled();
      expect(await call('/skill-sync','GET')).toBe(200);
      expect(await call('/skill-sync/11111111-1111-4111-8111-111111111111','POST')).toBe(400);
      expect(fetcher).toHaveBeenCalledOnce();
    }finally{vi.unstubAllGlobals();for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}}
  });
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
  it('immutable Worker stays unprivileged and Dev requires an explicit Control role',()=>{
    const role=process.env.BOTMUX_AGENT_ROLE, managed=process.env.BOTMUX_PLATFORM_MANAGED,dir=mkdtempSync(join(tmpdir(),'image-role-boundary-')),path=join(dir,'role');
    try {
      process.env.BOTMUX_PLATFORM_MANAGED='true';process.env.BOTMUX_AGENT_ROLE='control';
      writeFileSync(path,'worker');expect(platformManagementEnabled(path)).toBe(false);
      writeFileSync(path,'dev');expect(platformManagementEnabled(path)).toBe(true);
      process.env.BOTMUX_AGENT_ROLE='worker';expect(platformManagementEnabled(path)).toBe(false);
      expect(platformManagementEnabled(join(dir,'not-installed'))).toBe(true);
    } finally {
      rmSync(dir,{recursive:true,force:true});
      if(role===undefined)delete process.env.BOTMUX_AGENT_ROLE;else process.env.BOTMUX_AGENT_ROLE=role;
      if(managed===undefined)delete process.env.BOTMUX_PLATFORM_MANAGED;else process.env.BOTMUX_PLATFORM_MANAGED=managed;
    }
  });
  it('requires explicit opt-in for platform management',()=>{
    const old=process.env.BOTMUX_PLATFORM_MANAGED;
    try{delete process.env.BOTMUX_PLATFORM_MANAGED;expect(platformManagementEnabled()).toBe(false);
      process.env.BOTMUX_PLATFORM_MANAGED='true';expect(platformManagementEnabled()).toBe(true);
    }finally{if(old===undefined)delete process.env.BOTMUX_PLATFORM_MANAGED;else process.env.BOTMUX_PLATFORM_MANAGED=old;}
  });
  // 源码结构护栏(K2)：克隆 / 新建 Bot 的按钮在 BotDefaultsPage 内部渲染，该页依赖整套 bot 数据与
  // 接口、无法单独挂载；守的是安全不变量「平台托管 / Worker 上不能走本地 onboarding 绕过 Control
  // 的 Bot 生命周期」，以及本地 Bot 表单不得出现容器绑定字段。
  it('keeps local bot onboarding disabled on managed and worker dashboards',()=>{
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
    const previous=ui.platformManaged,onClick=vi.fn();
    const render=()=>{let renderer!:TestRenderer.ReactTestRenderer;
      act(()=>{renderer=TestRenderer.create(React.createElement(FeishuLoginEntry,{action:'login',onClick},'扫码登录'));});
      const node=renderer.root.findByProps({'data-action':'login'});const result={type:node.type,href:node.props.href,click:node.props.onClick};act(()=>renderer.unmount());return result;};
    try{
      ui.platformManaged=true;
      const managed=render();expect(managed).toMatchObject({type:'a',href:'#/platform-bots'});expect(managed.click).toBeUndefined();
      ui.platformManaged=false;
      const native=render();expect(native.type).toBe('button');expect(native.href).toBeUndefined();native.click();expect(onClick).toHaveBeenCalledTimes(1);
    }finally{ui.platformManaged=previous;}
    expect(findDashboardRoute('#/platform-bots')?.id).toBe('platform-bots');
  });
  it('names local bots from config, then the live registry, then the persisted name',()=>{
    const bots=[{larkAppId:'a',displayName:'Configured',name:'file-a'},{larkAppId:'b',name:'file-b'},{larkAppId:'c',name:'file-c'},{larkAppId:'d',name:'file-d'},{larkAppId:'e'}];
    const named=localBotDisplayNames(bots,new Map([['a','Live A'],['b','Live B']]),new Map([['b','Saved B'],['c','Saved C']]));
    expect(named.map(bot=>bot.displayName)).toEqual(['Configured','Live B','Saved C','file-d',undefined]);
    expect(named[1]).toMatchObject({larkAppId:'b',name:'file-b'});
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
