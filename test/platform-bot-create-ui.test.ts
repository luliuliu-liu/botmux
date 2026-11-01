import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformBotCreate } from '../src/dashboard/web/platform/bot-create.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const renderers:TestRenderer.ReactTestRenderer[]=[];
afterEach(()=>{for(const r of renderers.splice(0))act(()=>r.unmount());vi.unstubAllGlobals();});
const ready={status:'ready',confirmationToken:'opaque-test-token',identity:{userName:'Account',tenantName:'Org',email:'user@example.com'}};
async function mount(session:any=ready,job:any={id:'job',status:'needs_owner',suggestedOwner:'suggested@example.com'}){
  const api=vi.fn(async(path:string,..._args:any[])=>{if(path==='/onboarding/session'){if(session instanceof Error)throw session;return {session};}return {job};});
  let r!:TestRenderer.ReactTestRenderer;await act(async()=>{r=TestRenderer.create(React.createElement(PlatformBotCreate,{api,onClose:()=>{},onDone:()=>{}}));});renderers.push(r);return {r,api};
}
const button=(r:TestRenderer.ReactTestRenderer,text:string)=>r.root.findAllByType('button').find(b=>b.children.join('')===text)!;
async function submit(r:TestRenderer.ReactTestRenderer){
  vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['name','Test Bot'];}});
  await act(async()=>{await r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}});});
}
describe('platform Bot creation account UI',()=>{
  it('shows the confirmed account, submits reuse without QR, and prefills native owner suggestion',async()=>{
    const {r,api}=await mount();expect(JSON.stringify(r.toJSON())).toContain('Account');expect(button(r,'使用此账号创建').props.disabled).toBe(false);
    expect(api).toHaveBeenCalledTimes(1);await submit(r);
    expect(api).toHaveBeenCalledWith('/onboarding','POST',{name:'Test Bot',target:'pool',sessionMode:'reuse',confirmationToken:'opaque-test-token'});
    expect(r.root.findByProps({name:'owner'}).props.defaultValue).toBe('suggested@example.com');
  });
  it('only selects fresh QR after explicit account switching, and allows switching back',async()=>{
    const {r,api}=await mount();await act(async()=>button(r,'更换账号 / 扫码登录').props.onClick());
    expect(button(r,'创建并扫码登录')).toBeDefined();await act(async()=>button(r,'使用当前账号').props.onClick());
    expect(button(r,'使用此账号创建')).toBeDefined();await act(async()=>button(r,'更换账号 / 扫码登录').props.onClick());await submit(r);
    expect(api).toHaveBeenCalledWith('/onboarding','POST',{name:'Test Bot',target:'pool',sessionMode:'qr'});
  });
  it('offers QR for a missing session but does not submit or start QR on open',async()=>{
    const {r,api}=await mount({status:'scan_required'});expect(button(r,'创建并扫码登录').props.disabled).toBe(false);expect(api).toHaveBeenCalledTimes(1);
  });
  it.each([new Error('offline'),{status:'unknown'}])('does not silently turn an inconclusive check into QR creation (%s)',async session=>{
    const {r,api}=await mount(session);expect(button(r,'创建并扫码登录').props.disabled).toBe(true);expect(api).toHaveBeenCalledTimes(1);
    await act(async()=>button(r,'改用扫码登录').props.onClick());expect(button(r,'创建并扫码登录').props.disabled).toBe(false);
  });
  it('rechecks confirmation errors without automatically submitting again',async()=>{
    const {r,api}=await mount();api.mockRejectedValueOnce(new Error('账号已变化，未创建应用'));
    await submit(r);expect(api).toHaveBeenCalledTimes(3);expect(JSON.stringify(r.toJSON())).toContain('账号已变化');expect(button(r,'使用此账号创建')).toBeDefined();
  });
  it('shows native permission warnings and remaining manual steps',async()=>{
    const {r}=await mount(ready,{id:'job',status:'completed',permission:{ok:true,scopeCount:10,versionId:'1.0.0',redirectWarning:'redirect warning',scopeWarning:'scope warning'},remainingSteps:[{title:'开放平台',url:'https://open.feishu.cn/app/test'}]});
    await submit(r);const view=JSON.stringify(r.toJSON());expect(view).toContain('redirect warning');expect(view).toContain('scope warning');expect(view).toContain('1.0.0');expect(r.root.findByType('a').props.href).toBe('https://open.feishu.cn/app/test');
  });
  it('does not describe a failed local start as an online Bot',async()=>{
    const {r}=await mount(ready,{id:'job',status:'completed',liveStarted:false,liveStartMessage:'start failed'});
    await act(async()=>r.root.findByType('select').props.onChange({target:{value:'local'}}));await submit(r);
    expect(JSON.stringify(r.toJSON())).toContain('本地 Bot 未成功启动');expect(JSON.stringify(r.toJSON())).toContain('start failed');
  });
});
