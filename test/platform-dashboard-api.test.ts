import { describe,expect,it } from 'vitest';
import { platformManagementEnabled, createPlatformDashboardApi } from '../src/platform/management/dashboard-api.js';
import { readFileSync } from 'node:fs';
describe('v2 platform boundaries',()=>{
  it('requires explicit opt-in and never changes native bot forms into remote configuration',()=>{
    const old=process.env.BOTMUX_PLATFORM_MANAGED;
    try{delete process.env.BOTMUX_PLATFORM_MANAGED;expect(platformManagementEnabled()).toBe(false);
      process.env.BOTMUX_PLATFORM_MANAGED='true';expect(platformManagementEnabled()).toBe(true);
    }finally{if(old===undefined)delete process.env.BOTMUX_PLATFORM_MANAGED;else process.env.BOTMUX_PLATFORM_MANAGED=old;}
    const source=readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx',import.meta.url),'utf8');
    expect(source.match(/disabled=\{onboardingBusy \|\| ui.platformManaged\}/g)).toHaveLength(2);
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
      expect((await call('/bots','POST',true)).status).toBe(405);
      expect((await call('/dispatch-targets','GET',true)).status).toBe(404);
      expect((await call('/dispatch/any/prompt','POST',true)).status).toBe(404);
    }finally{if(old===undefined)delete process.env.BOTMUX_PLATFORM_MANAGED;else process.env.BOTMUX_PLATFORM_MANAGED=old;}
  });
});
