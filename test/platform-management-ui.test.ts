import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
vi.mock('../src/dashboard/web/ui.js',()=>({ui:{platformManaged:true}}));
vi.mock('../src/dashboard/web/react-mount.js',()=>({mountReactPage:vi.fn()}));
vi.mock('../src/dashboard/web/dashboard-components.js',()=>({
  CreateActionButton:({children,...props}:any)=>React.createElement('button',props,children),
  RefreshIconButton:({label,onClick}:any)=>React.createElement('button',{onClick},label),
}));
vi.mock('../src/dashboard/web/platform/feishu-session-panel.js',()=>({FeishuSessionPanel:()=>null}));
vi.mock('../src/dashboard/web/platform/bot-create.js',()=>({PlatformBotCreate:()=>null}));
import { ManagementPage,ContainerForm,UnbindBot } from '../src/dashboard/web/platform/management-page.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const current={containerId:'agent-1',displayName:'Agent One',agentType:'pi',image:'pi:test',sandboxId:'sandbox',status:'ready',revision:1,appliedRevision:1,modelProfileId:'old',modelName:'Old',modelId:'model-1',egressHosts:['example.com'],botId:'bot-1',botName:'Bot',workspaceClaim:'workspace',stateClaim:'state',lastError:null};
const models=['old','new'].map(profileId=>({profileId,displayName:profileId,provider:'test',baseUrl:'https://example.com/v1',modelId:profileId,apiKeyConfigured:true,enabled:true}));
const workspaceOptions={hostPathEnabled:true,tenantHome:'/tenant/home',hostRoots:['/tenant/home'],workspaces:[{kind:'volume',source:'old-workspace',readOnly:false,useCount:1},{kind:'hostpath',source:'/tenant/home/project',readOnly:true,useCount:1}]};
const data={bots:[{botId:'bot-1',displayName:'Bot',appId:'cli_test',usage:'sandbox',containerId:'agent-1',containerRevision:1,containerStatus:'ready',secretConfigured:true}],models,containers:[current],agents:[]};
const renderers:TestRenderer.ReactTestRenderer[]=[];
let fetcher:ReturnType<typeof vi.fn>,failure=false;
beforeEach(()=>{vi.useFakeTimers();failure=false;fetcher=vi.fn(async(url:string,init?:any)=>{
  const path=url.replace('/api/platform','');
  if(init?.method==='PUT')return {ok:!failure,status:failure?409:200,json:async()=>failure?{message:'Agent 正在执行任务'}:{container:{...current,modelProfileId:JSON.parse(init.body).modelProfileId,revision:2,appliedRevision:2}}};
  return {ok:true,json:async()=>path==='/catalog'?{agents:[]}:path==='/workspaces'?workspaceOptions:{[path.slice(1)]:data[path.slice(1) as keyof typeof data]}};
});vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{for(const r of renderers.splice(0))act(()=>r.unmount());vi.unstubAllGlobals();vi.useRealTimers();});
async function mount(component:React.ReactElement){let r!:TestRenderer.ReactTestRenderer;await act(async()=>{r=TestRenderer.create(component);});renderers.push(r);return r;}
const button=(r:TestRenderer.ReactTestRenderer,text:string)=>r.root.findAllByType('button').find(b=>b.children.join('')===text)!;
describe('model and Agent management UI',()=>{
  it('shows model connections without Agent creation controls',async()=>{
    const r=await mount(React.createElement(ManagementPage,{page:'models'}));expect(r.root.findByType('h1').children).toEqual(['模型管理']);expect(button(r,'添加模型连接')).toBeDefined();expect(button(r,'创建 Agent')).toBeUndefined();
  });
  it('syncs the same model connection, leaves Bot binding unchanged and reports runtime ACK',async()=>{
    const r=await mount(React.createElement(ManagementPage,{page:'agents'}));expect(r.root.findByType('h1').children).toEqual(['Agent 管理']);
    await act(async()=>button(r,'同步配置').props.onClick());
    const put=fetcher.mock.calls.find(([,init])=>init?.method==='PUT')!;
    expect(JSON.parse(put[1].body)).toEqual({revision:1,modelProfileId:'old'});
    expect(JSON.stringify(r.toJSON())).toContain('Agent 配置已同步');
  });
  it('retains sync errors after the list is refreshed and never reports success',async()=>{
    failure=true;const r=await mount(React.createElement(ManagementPage,{page:'agents'}));await act(async()=>button(r,'同步配置').props.onClick());
    // The click handler intentionally fires asynchronously.
    await act(async()=>{});expect(JSON.stringify(r.toJSON())).toContain('Agent 正在执行任务');expect(JSON.stringify(r.toJSON())).not.toContain('Agent 配置已同步');
  });
  it('saves a newly selected model through the runtime sync path',async()=>{
    const done=vi.fn();const r=await mount(React.createElement(ContainerForm,{data:data as any,container:current,onClose:()=>{},onDone:done}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['modelProfileId','new'];yield ['botId','bot-1'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(done).toHaveBeenCalledWith(expect.stringContaining('已同步'));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({revision:1,modelProfileId:'new'});
  });
  it('offers historical volumes and confirmed hostPath exposure, defaulting hostPath to tenant home and read-only',async()=>{
    const r=await mount(React.createElement(ContainerForm,{data:{...data,workspaceOptions} as any,container:null,onClose:()=>{},onDone:()=>{}}));
    const selector=()=>r.root.findByProps({name:'workspace'});
    await act(async()=>selector().props.onChange({target:{value:'volume'}}));expect(r.root.findByProps({name:'workspaceSource'}).findAllByType('option').map(o=>o.props.value)).toContain('old-workspace');
    await act(async()=>selector().props.onChange({target:{value:'hostpath'}}));expect(r.root.findByProps({name:'workspaceSource'}).props.defaultValue).toBe('/tenant/home');
    expect(r.root.findByProps({name:'hostPathConfirmed'}).props.required).toBe(true);
    expect(r.root.findAllByType('input').find(i=>i.props.type==='checkbox'&&!i.props.name)?.props.checked).toBe(true);
    expect(r.root.findByType('datalist').findByType('option').props.value).toBe('/tenant/home/project');
  });
  it('keeps a Bot reserved when container unbind is not acknowledged',async()=>{
    fetcher.mockResolvedValue({ok:true,json:async()=>({container:{...current,revision:2,appliedRevision:2}})});
    const done=vi.fn(),r=await mount(React.createElement(UnbindBot,{bot:data.bots[0] as any,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));expect(done).not.toHaveBeenCalled();expect(JSON.stringify(r.toJSON())).toContain('摘除未确认');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({containerId:'agent-1',revision:1});
  });
  it('reports successful detach only when the exact container acknowledges null binding',async()=>{
    fetcher.mockResolvedValue({ok:true,json:async()=>({container:{...current,revision:2,appliedRevision:2,botId:null}})});
    const done=vi.fn(),r=await mount(React.createElement(UnbindBot,{bot:data.bots[0] as any,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));expect(done).toHaveBeenCalledWith(expect.stringContaining('配置已同步'));
  });
});
