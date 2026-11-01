import { describe,expect,it,vi } from 'vitest';
import { NAV_ITEMS } from '../src/dashboard/web/nav-items.js';
import { findDashboardRoute } from '../src/dashboard/web/dashboard-routes.js';
import { syncAgentConfiguration,saveCliConfiguration } from '../src/dashboard/web/platform/agent-configuration.js';
const current={containerId:'agent-1',status:'ready',revision:1,appliedRevision:1,modelProfileId:'old',botId:'bot-1'};
describe('platform Agent model sync',()=>{
  it('requires a per-CLI ACK to match the requested model, connection and authentication',async()=>{
    const cli={agentType:'codex',revision:2,appliedRevision:2};
    const observed={...cli,revision:3,appliedRevision:3,modelProfileId:null,modelId:null,authMethod:'oauth'};
    await expect(saveCliConfiguration(async()=>({clis:[observed]}),'agent-1',cli,null,null)).resolves.toMatchObject({revision:3});
    for(const patch of [{modelProfileId:'other'},{modelId:'other'},{authMethod:'api-key'},{appliedRevision:2}]){
      await expect(saveCliConfiguration(async()=>({clis:[{...observed,...patch}]}),'agent-1',cli,null,null)).rejects.toThrow('尚未确认');
    }
  });
  it('switches to native OAuth without a model record and validates the authentication ACK',async()=>{
    const oauth={...current,authMethod:'oauth',modelProfileId:null,modelId:null,revision:2,appliedRevision:2};
    const api=vi.fn(async()=>({container:oauth}));
    await syncAgentConfiguration(api,current,null,current.botId,null);
    expect(api).toHaveBeenCalledWith('/containers/agent-1','PUT',{revision:1,modelProfileId:null,authMethod:'oauth',modelId:null});
    await expect(syncAgentConfiguration(async()=>({container:{...oauth,authMethod:'api-key'}}),current,null,current.botId,null)).rejects.toThrow('尚未确认');
  });
  it('selects a non-default model in the same connection and rejects an ACK with another ID',async()=>{
    const api=vi.fn(async()=>({container:{...current,modelId:'second',revision:2,appliedRevision:2}}));
    await syncAgentConfiguration(api,{...current,modelId:'first'},'old',current.botId,'second');
    expect(api).toHaveBeenCalledWith('/containers/agent-1','PUT',{revision:1,modelProfileId:'old',modelId:'second'});
    await expect(syncAgentConfiguration(api,{...current,modelId:'first'},'old',current.botId,'first')).rejects.toThrow('尚未确认');
  });
  it('switches model and requires the exact runtime-applied revision without rebinding the Bot',async()=>{
    const api=vi.fn(async()=>({container:{...current,revision:2,appliedRevision:2,modelProfileId:'new'}}));
    expect(await syncAgentConfiguration(api,current,'new')).toMatchObject({revision:2});
    expect(api).toHaveBeenCalledWith('/containers/agent-1','PUT',{revision:1,modelProfileId:'new'});
  });
  it('resends the same model connection for newly saved credentials and includes only changed Bot bindings',async()=>{
    const api=vi.fn(async()=>({container:{...current,revision:2,appliedRevision:2,botId:null}}));
    await syncAgentConfiguration(api,current,'old',null);
    expect(api).toHaveBeenCalledWith('/containers/agent-1','PUT',{revision:1,modelProfileId:'old',botId:null});
  });
  it.each([{},{status:'error'},{appliedRevision:1},{revision:1,appliedRevision:1},{modelProfileId:'other'},{botId:null},{containerId:'other'}])('does not claim sync succeeded on a missing or mismatching ACK (%j)',async patch=>{
    const container=Object.keys(patch).length?{...current,revision:2,appliedRevision:2,...patch}:undefined;
    await expect(syncAgentConfiguration(async()=>({container}),current,'old')).rejects.toThrow('尚未确认');
  });
  it('preserves backend busy, stale revision and network-policy errors',async()=>{
    await expect(syncAgentConfiguration(async()=>{throw new Error('Agent 正在执行任务');},current,'new')).rejects.toThrow('正在执行任务');
  });
  it('separates model and Agent menus/routes and keeps the legacy OpenSandbox bookmark',()=>{
    expect(NAV_ITEMS.find(item=>item.id==='platform-configuration')).toMatchObject({href:'#/platform-configuration',manage:true});
    expect(NAV_ITEMS.find(item=>item.id==='platform-agents')).toMatchObject({href:'#/platform-agents',manage:true});
    expect(NAV_ITEMS.some(item=>item.id==='opensandbox')).toBe(false);
    expect(findDashboardRoute('#/platform-models')?.id).toBe('platform-models');
    expect(findDashboardRoute('#/opensandbox')?.id).toBe('opensandbox');
  });
});
