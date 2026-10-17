import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOnboardingSessionConfirmation } from '../src/platform/management/onboarding-session.js';
import { createPlatformDashboardApi } from '../src/platform/management/dashboard-api.js';
import { BotOnboardingManager, type BotOnboardingSessionStatus } from '../src/dashboard/bot-onboarding.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ready:BotOnboardingSessionStatus={status:'ready',source:'botmux_cache',identity:{userId:'private-user',tenantId:'private-tenant',userName:'Account',tenantName:'Org',email:'user@example.com'}};
const dirs:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
describe('platform onboarding account confirmation',()=>{
  it('distinguishes expired credentials from inconclusive native inspection',async()=>{
    expect(await createOnboardingSessionConfirmation(async()=>({status:'scan_required',reason:'network'})).inspect()).toEqual({status:'unknown'});
    expect(await createOnboardingSessionConfirmation(async()=>({status:'scan_required',reason:'identity_unavailable'})).inspect()).toEqual({status:'unknown'});
    expect(await createOnboardingSessionConfirmation(async()=>({status:'scan_required',reason:'invalid_session'})).inspect()).toEqual({status:'scan_required'});
  });
  it('returns only display fields and a single-use, expiring opaque confirmation',async()=>{
    let now=1;const confirmation=createOnboardingSessionConfirmation(async()=>ready,()=>now);
    const view=await confirmation.inspect();expect(view.status).toBe('ready');
    expect(JSON.stringify(view)).not.toMatch(/private|userId|tenantId|source/);
    if(view.status!=='ready')throw new Error('ready expected');
    expect(await confirmation.consume(view.confirmationToken)).toEqual({userId:'private-user',tenantId:'private-tenant'});
    expect(await confirmation.consume(view.confirmationToken)).toBeUndefined();
    const expired=await confirmation.inspect();now+=600_001;
    expect(await confirmation.consume('confirmationToken' in expired?expired.confirmationToken:'')).toBeUndefined();
  });
  it.each(['account','tenant','expired','network'])('fails closed if %s changed after display',async kind=>{
    let current=ready;const confirmation=createOnboardingSessionConfirmation(async()=>{if(kind==='network'&&current!==ready)throw new Error('offline');return current;});
    const view=await confirmation.inspect();if(view.status!=='ready')throw new Error('ready expected');
    current=kind==='expired'||kind==='network'?{status:'scan_required'}:{...ready,identity:{...ready.identity,...(kind==='account'?{userId:'other'}:{tenantId:'other'})}};
    if(kind==='network')await expect(confirmation.consume(view.confirmationToken)).rejects.toThrow('offline');
    else expect(await confirmation.consume(view.confirmationToken)).toBeUndefined();
  });
  async function fixture(){
    vi.stubEnv('BOTMUX_PLATFORM_MANAGED','true');vi.stubEnv('CONTROL_PLANE_URL','http://control-plane.test');vi.stubEnv('CONTROL_PLANE_SYNC_KEY','test-only');
    const fetcher=vi.fn(async()=>({status:200,json:async()=>({ok:true})}));vi.stubGlobal('fetch',fetcher);
    const start=vi.spyOn(BotOnboardingManager.prototype,'start').mockReturnValue({id:'job-1',done:Promise.resolve()} as any);
    vi.spyOn(BotOnboardingManager.prototype,'get').mockReturnValue({id:'job-1',status:'starting',createdAt:1,updatedAt:1});
    const local={sessionStatus:vi.fn(async()=>ready),start:vi.fn(()=>({id:'local-1'})),get:()=>({id:'local-1',status:'starting'})};
    const dir=mkdtempSync(join(tmpdir(),'platform-onboarding-'));dirs.push(dir);
    const api=createPlatformDashboardApi({botsJsonPath:join(dir,'bots.json'),localOnboarding:local as any,listLocalBots:()=>[]});
    const call=async(path:string,method='GET',body?:unknown,auth=true)=>{
      let status=0,raw='';await api({method,async *[Symbol.asyncIterator](){yield JSON.stringify(body||{});}} as any,
        {writeHead:(s:number)=>{status=s;},end:(b:string)=>{raw=b;}} as any,new URL(`http://localhost/api/platform${path}`),auth);
      return {status,data:JSON.parse(raw)};
    };return {call,start,local,fetcher};
  }
  it.each(['pool','local'])('passes confirmed identity to native %s creation, never forced QR',async target=>{
    const {call,start,local}=await fixture();const view=await call('/onboarding/session');
    expect(view.status).toBe(200);expect(JSON.stringify(view.data)).not.toMatch(/private-user|private-tenant|userId|tenantId/);
    const input={name:'Test Bot',target,sessionMode:'reuse',confirmationToken:view.data.session.confirmationToken};
    expect((await call('/onboarding','POST',input)).status).toBe(202);
    const selected=target==='pool'?start:local.start;
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({sessionMode:'reuse',expectedIdentity:{userId:'private-user',tenantId:'private-tenant'},cliId:'pi'}));
    expect((await call('/onboarding','POST',input)).status).toBe(409);expect(selected).toHaveBeenCalledTimes(1);
  });
  it('blocks changed identity and unauthorized inspection before any app creation',async()=>{
    const {call,start,local,fetcher}=await fixture();
    expect((await call('/onboarding/session','GET',undefined,false)).status).toBe(401);expect(local.sessionStatus).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
    const view=await call('/onboarding/session');local.sessionStatus.mockResolvedValueOnce({...ready,identity:{...ready.identity,tenantId:'other'}});
    expect((await call('/onboarding','POST',{name:'Test',target:'pool',sessionMode:'reuse',confirmationToken:view.data.session.confirmationToken})).status).toBe(409);
    expect(start).not.toHaveBeenCalled();expect(local.start).not.toHaveBeenCalled();
  });
  it('requires an explicit mode and retains explicit QR for a different account',async()=>{
    const {call,start}=await fixture();expect((await call('/onboarding','POST',{name:'Test',target:'pool'})).status).toBe(400);
    expect(start).not.toHaveBeenCalled();
    expect((await call('/onboarding','POST',{name:'Test',target:'pool',sessionMode:'qr'})).status).toBe(202);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({sessionMode:'qr'}));expect(start.mock.calls[0][0]).not.toHaveProperty('expectedIdentity');
  });
});
