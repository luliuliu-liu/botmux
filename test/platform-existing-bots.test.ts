import {describe,expect,it,vi} from 'vitest';
import {createExistingBotsManager} from '../src/platform/management/existing-bots.js';
const identity={userId:'private-user',tenantId:'private-tenant',userName:'Account',tenantName:'Company',email:'owner@example.com'};
function fixture(){
  const client={} as any;
  const connect=vi.fn(async()=>({client,identity})),list=vi.fn(async()=>[{clientId:'cli_one',name:'Canonical name'},{clientId:'cli_used',name:'Managed'}]);
  const secret=vi.fn(async()=> 'private-secret'),validateBot=vi.fn(async()=>{}),validateOwners=vi.fn(async()=>[] as string[]);
  const managed=vi.fn(async()=>[{appId:'cli_used',displayName:'Managed',usage:'sandbox'}]);
  const register=vi.fn(async()=>({ok:true})),refresh=vi.fn(async()=>({refreshed:true}));
  let now=0;
  const manager=createExistingBotsManager({connect,list,secret,validateBot,validateOwners,managed,register,refresh,now:()=>now});
  return {manager,connect,list,secret,validateBot,validateOwners,managed,register,refresh,expire:()=>{now=600001;}};
}
describe('existing Feishu Bot import and metadata refresh',()=>{
  it('lists only display fields, marks managed apps and never reads any secret',async()=>{
    const f=fixture(),result=await f.manager.list();
    expect(result.identity).toEqual({userName:'Account',tenantName:'Company',email:'owner@example.com'});
    expect(result.apps[1]).toMatchObject({registered:true,usage:'sandbox'});
    expect(JSON.stringify(result)).not.toMatch(/private|userId|tenantId|secret|cookie/);
    expect(f.secret).not.toHaveBeenCalled();expect(f.register).not.toHaveBeenCalled();
  });
  it('rereads membership/name, checks target-app owner and imports without exposing credentials',async()=>{
    const f=fixture(),selection=await f.manager.list();
    f.list.mockResolvedValue([{clientId:'cli_one',name:'Renamed in Feishu'}]);
    const result=await f.manager.import({appId:'cli_one',confirmationToken:selection.confirmationToken,displayName:'browser spoof',appSecret:'spoof'});
    expect(f.validateBot).toHaveBeenCalledWith('cli_one','private-secret');
    expect(f.validateOwners).toHaveBeenCalledWith('cli_one','private-secret','feishu',['owner@example.com']);
    expect(f.register).toHaveBeenCalledWith({appId:'cli_one',displayName:'Renamed in Feishu',appSecret:'private-secret',brand:'feishu',owner:{allowedUsers:['owner@example.com']},reimport:true});
    expect(result).toEqual({imported:true,appId:'cli_one',displayName:'Renamed in Feishu'});
    expect(JSON.stringify(result)).not.toContain('secret');
    await expect(f.manager.import({appId:'cli_one',confirmationToken:selection.confirmationToken})).rejects.toMatchObject({status:409});
  });
  it.each(['userId','tenantId'] as const)('rejects an account change in %s before reading credentials',async field=>{
    const f=fixture(),selection=await f.manager.list();f.connect.mockResolvedValue({client:{} as any,identity:{...identity,[field]:'changed'}});
    await expect(f.manager.import({appId:'cli_one',confirmationToken:selection.confirmationToken})).rejects.toMatchObject({code:'feishu_account_changed'});
    expect(f.secret).not.toHaveBeenCalled();expect(f.register).not.toHaveBeenCalled();
  });
  it('rejects expired/forged selections and apps no longer visible to the account',async()=>{
    const f=fixture(),selection=await f.manager.list();
    await expect(f.manager.import({appId:'cli_injected',confirmationToken:selection.confirmationToken})).rejects.toMatchObject({code:'selection_expired'});
    f.expire();await expect(f.manager.import({appId:'cli_one',confirmationToken:selection.confirmationToken})).rejects.toMatchObject({code:'selection_expired'});
    const other=fixture(),view=await other.manager.list();other.list.mockResolvedValue([]);
    await expect(other.manager.import({appId:'cli_one',confirmationToken:view.confirmationToken})).rejects.toMatchObject({code:'app_not_visible'});
    expect(other.secret).not.toHaveBeenCalled();
  });
  it('does not import or rotate an already managed local/Worker identity',async()=>{
    const f=fixture(),selection=await f.manager.list();
    await expect(f.manager.import({appId:'cli_used',confirmationToken:selection.confirmationToken})).rejects.toMatchObject({code:'bot_already_registered'});
    expect(f.secret).not.toHaveBeenCalled();expect(f.register).not.toHaveBeenCalled();
  });
  it.each(['ou_foreign','prefix','*'])('rejects unsafe owner %s before reading a secret',async owner=>{
    const f=fixture(),selection=await f.manager.list();
    await expect(f.manager.import({appId:'cli_one',confirmationToken:selection.confirmationToken,owner})).rejects.toMatchObject({status:400});
    expect(f.secret).not.toHaveBeenCalled();
  });
  it('does not register apps with unavailable Bot capability or unusable target-app owner',async()=>{
    const f=fixture(),selection=await f.manager.list();f.validateBot.mockRejectedValue(new Error('not a bot'));
    await expect(f.manager.import({appId:'cli_one',confirmationToken:selection.confirmationToken})).rejects.toThrow('not a bot');
    expect(f.register).not.toHaveBeenCalled();
    const other=fixture(),view=await other.manager.list();other.validateOwners.mockResolvedValue(['owner@example.com']);
    await expect(other.manager.import({appId:'cli_one',confirmationToken:view.confirmationToken})).rejects.toMatchObject({code:'owner_unavailable'});
    expect(other.register).not.toHaveBeenCalled();
  });
  it.each([true,false])('native credential/Bot capability verification admits only a usable Bot (%s)',async available=>{
    const f=fixture(),manager=createExistingBotsManager({...f,validateBot:undefined});
    const fetcher=vi.fn(async(url:any)=>String(url).includes('tenant_access_token')
      ?{ok:true,json:async()=>({code:0,tenant_access_token:'private-tenant-token'})}
      :{ok:true,json:async()=>({code:0,bot:available?{open_id:'ou_target_bot'}:{}})});
    vi.stubGlobal('fetch',fetcher);
    try{
      const selection=await manager.list(),request=manager.import({appId:'cli_one',confirmationToken:selection.confirmationToken});
      if(available){expect(await request).toMatchObject({imported:true});expect(f.register).toHaveBeenCalledTimes(1);}
      else{await expect(request).rejects.toMatchObject({code:'bot_unavailable'});expect(f.register).not.toHaveBeenCalled();}
      expect(fetcher).toHaveBeenCalledTimes(2);
    }finally{vi.unstubAllGlobals();}
  });
  it('refreshes a managed app from Feishu without reading/resetting its secret or changing owner',async()=>{
    const f=fixture();await f.manager.refresh('cli_used');
    expect(f.refresh).toHaveBeenCalledWith('cli_used','Managed');expect(f.secret).not.toHaveBeenCalled();expect(f.register).not.toHaveBeenCalled();
    await expect(f.manager.refresh('cli_one')).rejects.toMatchObject({code:'bot_not_registered'});
  });
});
