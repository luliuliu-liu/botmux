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
