import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {PlatformBotImport} from '../src/dashboard/web/platform/bot-import.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const views:TestRenderer.ReactTestRenderer[]=[];
afterEach(()=>{for(const view of views.splice(0))act(()=>view.unmount());});
const response={identity:{userName:'Account',tenantName:'Company',email:'owner@example.com'},confirmationToken:'opaque-selection',apps:[
  {appId:'cli_one',displayName:'Available',registered:false},{appId:'cli_used',displayName:'Managed',registered:true,usage:'sandbox'}]};
async function mount(api:any,onDone=vi.fn()){
  let view!:TestRenderer.ReactTestRenderer;await act(async()=>{view=TestRenderer.create(React.createElement(PlatformBotImport,{api,onDone,onClose:()=>{}}));});views.push(view);return view;
}
describe('existing Bot import dialog',()=>{
  it('displays the account, disables managed apps and only writes after confirmation',async()=>{
    const api=vi.fn(async(path:string)=>path==='/feishu-apps'?response:{imported:true,displayName:'Available'}),done=vi.fn(),view=await mount(api,done);
    expect(JSON.stringify(view.toJSON())).toContain('Account');
    const choices=view.root.findAllByProps({name:'existingAppId'});expect(choices[1].props.disabled).toBe(true);
    expect(view.root.findByProps({name:'existingBotOwner'}).props.value).toBe('owner@example.com');
    expect(api.mock.calls).toEqual([['/feishu-apps']]);
    await act(async()=>choices[0].props.onChange());
    await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){}}));
    expect(api.mock.calls[1]).toEqual(['/bots/import','POST',{appId:'cli_one',confirmationToken:'opaque-selection',owner:'owner@example.com'}]);
    expect(done).toHaveBeenCalledWith(expect.stringContaining('未启动或绑定 Agent'));
  });
  it('filters by name or App ID and never creates an application',async()=>{
    const api=vi.fn(async()=>response),view=await mount(api);
    await act(async()=>view.root.findByProps({'aria-label':'搜索已有应用'}).props.onChange({target:{value:'cli_used'}}));
    expect(view.root.findAllByProps({name:'existingAppId'})).toHaveLength(1);
    expect(api).toHaveBeenCalledTimes(1);
  });
  it('keeps login/import errors visible and requires reloading a consumed selection',async()=>{
    const api=vi.fn(async(path:string)=>{if(path==='/feishu-apps')return response;throw new Error('飞书账号已变化');}),done=vi.fn(),view=await mount(api,done);
    await act(async()=>view.root.findAllByProps({name:'existingAppId'})[0].props.onChange());
    await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){}}));
    expect(JSON.stringify(view.toJSON())).toContain('飞书账号已变化');expect(done).not.toHaveBeenCalled();
    expect(view.root.findAllByProps({name:'existingAppId'})[0].props.checked).toBe(false);
  });
});
