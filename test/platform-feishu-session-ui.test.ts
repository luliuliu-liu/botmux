import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuSessionStatus } from '../src/platform/management/feishu-session.js';

vi.mock('../src/dashboard/web/bot-defaults-page.js',()=>({
  FeishuLoginModal:({onSuccess}:{onSuccess:()=>void})=>React.createElement('button',{'data-login-complete':true,onClick:onSuccess},'模拟扫码完成'),
}));
import { FeishuSessionPanel } from '../src/dashboard/web/platform/feishu-session-panel.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;

const ready:FeishuSessionStatus={status:'ready',checkedAt:1,identity:{userName:'Test User',tenantName:'Test Org',email:'user@example.com'}};
const renderers:TestRenderer.ReactTestRenderer[]=[];
let response:FeishuSessionStatus;
let fetcher:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  response=ready;
  vi.stubGlobal('window',{setInterval:vi.fn(()=>1),clearInterval:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()});
  fetcher=vi.fn(async()=>({ok:true,json:async()=>({session:response})}));vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());vi.unstubAllGlobals();});
async function mount(){
  let renderer!:TestRenderer.ReactTestRenderer;
  await act(async()=>{renderer=TestRenderer.create(React.createElement(FeishuSessionPanel));});
  renderers.push(renderer);return renderer;
}
const action=(r:TestRenderer.ReactTestRenderer,name:string)=>r.root.findByProps({'data-action':`feishu-session-${name}`});
const details=(r:TestRenderer.ReactTestRenderer)=>r.root.findByProps({className:'pm-session-details'});

describe('compact Feishu account disclosure',()=>{
  it('starts collapsed, exposes details accessibly, and never refetches just for disclosure',async()=>{
    const renderer=await mount();
    expect(action(renderer,'toggle').props['aria-expanded']).toBe(false);
    expect(details(renderer).props.hidden).toBe(true);
    expect(action(renderer,'toggle').props['aria-controls']).toBe(details(renderer).props.id);
    expect(JSON.stringify(renderer.toJSON())).toContain('Test User');
    await act(async()=>action(renderer,'toggle').props.onClick());
    expect(details(renderer).props.hidden).toBe(false);expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async()=>action(renderer,'refresh').props.onClick());
    expect(fetcher.mock.calls[1][0]).toContain('?refresh=1');expect(details(renderer).props.hidden).toBe(false);
    await act(async()=>action(renderer,'toggle').props.onClick());expect(details(renderer).props.hidden).toBe(true);
  });
  it('opens missing-login actions automatically but respects an explicit collapse on repeated checks',async()=>{
    response={status:'missing',checkedAt:1};const renderer=await mount();
    expect(details(renderer).props.hidden).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).toContain('未登录');
    expect(renderer.root.findAllByProps({'data-login-complete':true})).toHaveLength(0);
    await act(async()=>action(renderer,'toggle').props.onClick());
    await act(async()=>action(renderer,'refresh').props.onClick());
    expect(details(renderer).props.hidden).toBe(true);
  });
  it('clears the old account and opens diagnostics when health becomes inconclusive',async()=>{
    const renderer=await mount();response={status:'unknown',checkedAt:2};
    await act(async()=>action(renderer,'refresh').props.onClick());
    expect(details(renderer).props.hidden).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('user@example.com');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Test User');
    expect(JSON.stringify(renderer.toJSON())).toContain('状态待确认');
  });
  it('reuses the QR modal then revalidates the new account and collapses on success',async()=>{
    const renderer=await mount();
    await act(async()=>action(renderer,'toggle').props.onClick());
    await act(async()=>action(renderer,'login').props.onClick());
    response={status:'ready',checkedAt:3,identity:{userName:'New Account',tenantName:'New Org'}};
    await act(async()=>renderer.root.findByProps({'data-login-complete':true}).props.onClick());
    expect(details(renderer).props.hidden).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('New Account');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Test User');
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain('?refresh=1');
    expect(renderer.root.findAllByProps({'data-login-complete':true})).toHaveLength(0);
  });
});
