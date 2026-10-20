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
import { ManagementPage,ContainerForm,ModelForm,DeleteModel,UnbindBot,UnbindLocalBot,WorkspaceSettings } from '../src/dashboard/web/platform/management-page.js';
import {NetworkRules,LoginWorkbench} from '../src/dashboard/web/platform/worker-access.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const current={containerId:'agent-1',displayName:'Agent One',agentType:'pi',image:'pi:test',sandboxId:'sandbox',status:'ready',revision:1,appliedRevision:1,modelProfileId:'old',modelName:'Old',modelId:'model-1',egressHosts:['example.com'],botId:'bot-1',botName:'Bot',workspaceClaim:'workspace',stateClaim:'state',lastError:null};
const models=['old','new'].map(profileId=>({profileId,displayName:profileId,provider:'test',baseUrl:'https://example.com/v1',modelId:profileId,apiKeyConfigured:true,enabled:true}));
const workspaceOptions={hostPathEnabled:true,tenantHome:'/tenant/home',defaultHostPath:'/tenant/home/project',hostRoots:['/tenant/home'],workspaces:[{kind:'volume',source:'custom-shared-volume',readOnly:false,useCount:0,shared:true},{kind:'volume',source:'old-workspace',readOnly:false,useCount:1},{kind:'hostpath',source:'/tenant/home/project',readOnly:true,useCount:1}]};
const data={bots:[{botId:'bot-1',displayName:'Bot',appId:'cli_test',usage:'sandbox',containerId:'agent-1',containerRevision:1,containerStatus:'ready',secretConfigured:true}],models,containers:[current],agents:[]};
const renderers:TestRenderer.ReactTestRenderer[]=[];
let fetcher:ReturnType<typeof vi.fn>,failure=false;
beforeEach(()=>{vi.useFakeTimers();failure=false;fetcher=vi.fn(async(url:string,init?:any)=>{
  const path=url.replace('/api/platform','');
  if(init?.method==='PUT')return {ok:!failure,status:failure?409:200,json:async()=>failure?{message:'Agent 正在执行任务'}:{container:{...current,modelProfileId:JSON.parse(init.body).modelProfileId,modelId:JSON.parse(init.body).modelId??current.modelId,revision:2,appliedRevision:2}}};
  return {ok:true,json:async()=>path==='/catalog'?{agents:[{id:'pi',name:'Pi',supported:true,version:'0.85.1',images:[{id:'runtime',label:'运行镜像',image:'pi:test'}]}]}:path==='/workspaces'?workspaceOptions:{[path.slice(1)]:data[path.slice(1) as keyof typeof data]}};
});vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{for(const r of renderers.splice(0))act(()=>r.unmount());vi.unstubAllGlobals();vi.useRealTimers();});
async function mount(component:React.ReactElement){let r!:TestRenderer.ReactTestRenderer;await act(async()=>{r=TestRenderer.create(component);});renderers.push(r);return r;}
const button=(r:TestRenderer.ReactTestRenderer,text:string)=>r.root.findAllByType('button').find(b=>b.children.join('')===text)!;
describe('model and Agent management UI',()=>{
  it('offers native OAuth by Agent capability without any OAuth model record, and submits a native default',async()=>{
    const agents=[{id:'pi',name:'Pi',supported:true,version:'test',authMethods:['api-key'],protocols:['openai-completions'],images:[{id:'native',image:'pi:test',label:'Pi'}]},
      {id:'codex',name:'Codex',supported:true,version:'test',authMethods:['api-key','oauth'],protocols:['openai-responses'],images:[{id:'native',image:'codex:test',label:'Codex'}]}];
    const done=vi.fn(),r=await mount(React.createElement(ContainerForm,{data:{...data,agents} as any,container:null,onClose:()=>{},onDone:done}));
    const options=()=>r.root.findByProps({name:'modelSelection'}).findAllByType('option');
    expect(options().some(o=>o.props.value==='[null,null]')).toBe(false);
    await act(async()=>r.root.findByProps({'aria-label':'Agent 类型'}).props.onChange({target:{value:'codex'}}));
    expect(options().some(o=>o.props.value==='[null,null]')).toBe(true);
    await act(async()=>r.root.findByProps({name:'modelSelection'}).props.onChange({target:{value:'[null,null]'}}));
    expect(r.root.findByProps({name:'oauthModelId'}).props.required).toBeUndefined();
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['modelSelection','[null,null]'];yield ['oauthModelId',''];yield ['displayName','OAuth'];yield ['imageProfile','native'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({authMethod:'oauth',modelProfileId:null,modelId:null,agentType:'codex'});expect(done).toHaveBeenCalled();
  });
  it('does not offer OAuth in the model management form',async()=>{
    const r=await mount(React.createElement(ModelForm,{model:null,onClose:()=>{},onDone:()=>{}}));
    expect(r.root.findAllByProps({name:'authMethod'})).toHaveLength(0);
    expect(r.root.findAllByType('option').some(o=>o.props.value==='oauth')).toBe(false);
  });
  it('requires network disruption confirmation and keeps failed readback visible',async()=>{
    const configuration={schemaVersion:1,networkPolicy:{defaultAction:'deny',egress:[]}};
    fetcher.mockResolvedValueOnce({ok:true,json:async()=>({revision:1,appliedRevision:1,inSync:true,configuration,observed:configuration})});
    const r=await mount(React.createElement(NetworkRules,{container:current,onClose:()=>{}}));
    expect(button(r,'保存并应用').props.disabled).toBe(true);
    await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
    fetcher.mockResolvedValueOnce({ok:true,json:async()=>({revision:2,appliedRevision:1,inSync:false,configuration,observed:configuration})});
    fetcher.mockResolvedValueOnce({ok:false,json:async()=>({message:'网络策略未确认完全生效'})});
    await act(async()=>button(r,'保存并应用').props.onClick());
    expect(fetcher.mock.calls.slice(-2).map(([url,init])=>[url,init.method])).toEqual([['/api/platform/containers/agent-1/network','PUT'],['/api/platform/containers/agent-1/network/apply','POST']]);
    expect(JSON.stringify(r.toJSON())).toContain('网络策略未确认完全生效');expect(JSON.stringify(r.toJSON())).toContain('待应用 / 实际规则有差异');
  });
  it('opens login workbench without creating credentials, a browser or storage until explicitly requested',async()=>{
    fetcher.mockImplementation(async(url:string)=>({ok:true,json:async()=>url.endsWith('/browser-profiles')?{profiles:[]}:{logins:[]}}));
    const r=await mount(React.createElement(LoginWorkbench,{container:null,containers:[],onClose:()=>{}}));
    expect(button(r,'Worker 发起登录').props.disabled).toBe(true);
    await act(async()=>button(r,'新建浏览器配置').props.onClick());
    expect(button(r,'保存浏览器配置').props.disabled).toBe(true);
    expect(fetcher.mock.calls.every(([,init])=>init.method==='GET')).toBe(true);
    expect(JSON.stringify(r.toJSON())).toContain('OAuth 凭据只保留在目标 Worker');
  });
  it('groups Agent choices by connection and expands every configured model',async()=>{
    const r=await mount(React.createElement(ContainerForm,{data:{...data,models:[{...models[0],modelIds:['model-1','model-2']}]} as any,container:current,onClose:()=>{},onDone:()=>{}}));
    const select=r.root.findByProps({name:'modelSelection'});
    expect(select.props.defaultValue).toBe(JSON.stringify(['old','model-1']));
    expect(select.findByType('optgroup').findAllByType('option').map(o=>JSON.parse(o.props.value))).toEqual([['old','model-1'],['old','model-2']]);
  });
  it('saves multiple IDs without sending an empty replacement key and keeps a clone disabled',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(ModelForm,{model:{...models[0],enabled:false},onClose:()=>{},onDone:done}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['profileId','old'];yield ['displayName','Copy'];yield ['provider','test'];yield ['modelIds',' a\n b\na\n'];yield ['apiKey',''];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    const payload=JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload).toMatchObject({modelIds:['a','b'],modelId:'a',enabled:false});expect(payload).not.toHaveProperty('apiKey');expect(done).toHaveBeenCalled();
  });
  it('hides model actions behind the menu and prefills a cancellable clone draft without any writes',async()=>{
    const r=await mount(React.createElement(ManagementPage,{page:'models'}));
    expect(button(r,'克隆')).toBeUndefined();expect(button(r,'编辑连接')).toBeUndefined();expect(button(r,'删除')).toBeUndefined();
    await act(async()=>r.root.findByProps({'aria-label':'old（old） 的操作',type:'button'}).props.onClick());
    expect(r.root.findAllByProps({role:'menuitem'}).map(b=>b.children.join(''))).toEqual(['编辑连接','克隆','删除']);
    await act(async()=>button(r,'克隆').props.onClick());await act(async()=>{});
    expect(fetcher.mock.calls.filter(([,init])=>init?.method!=='GET')).toHaveLength(0);
    expect(r.root.findByProps({name:'profileId'}).props.defaultValue).toBe('old-copy');
    expect(r.root.findByProps({name:'profileId'}).props.readOnly).toBe(false);
    expect(r.root.findByProps({name:'enabled'}).props.defaultChecked).toBe(false);
    expect(r.root.findByProps({name:'apiKey'}).props.required).toBe(false);
    await act(async()=>button(r,'取消').props.onClick());
    expect(r.root.findAllByType('dialog')).toHaveLength(0);
    expect(fetcher.mock.calls.filter(([,init])=>init?.method!=='GET')).toHaveLength(0);
  });
  it('submits the edited clone ID and configuration once, only on save',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(ModelForm,{model:{...models[0],enabled:false},cloneSourceId:'old',onClose:()=>{},onDone:done}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['profileId','chosen-id'];yield ['displayName','Chosen'];yield ['provider','other'];yield ['modelIds','x\ny'];yield ['enabled','on'];yield ['apiKey',''];}});
    expect(fetcher).not.toHaveBeenCalled();
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(fetcher.mock.calls[0][0]).toBe('/api/platform/models/old/clone');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({profileId:'chosen-id',provider:'other',modelIds:['x','y'],enabled:true});expect(done).toHaveBeenCalled();
  });
  it('requires the exact model ID before deleting and keeps reference conflicts visible',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(DeleteModel,{model:models[0],onClose:()=>{},onDone:done}));
    const submit=()=>r.root.findByType('form').props.onSubmit({preventDefault(){}});
    await act(async()=>submit());expect(fetcher).not.toHaveBeenCalled();
    await act(async()=>r.root.findByProps({name:'confirmProfileId'}).props.onChange({target:{value:'old'}}));
    fetcher.mockResolvedValueOnce({ok:false,json:async()=>({message:'仍被 Agent 引用'})});
    await act(async()=>submit());expect(done).not.toHaveBeenCalled();expect(JSON.stringify(r.toJSON())).toContain('仍被 Agent 引用');
    fetcher.mockResolvedValueOnce({ok:true,json:async()=>({ok:true})});
    await act(async()=>submit());expect(fetcher.mock.calls[0][0]).toBe('/api/platform/models/old');expect(fetcher.mock.calls[0][1].method).toBe('DELETE');expect(done).toHaveBeenCalled();
  });
  it('requires explicit local stop confirmation, sends an exact revision and reports only acknowledged release',async()=>{
    const done=vi.fn();fetcher.mockResolvedValue({ok:true,json:async()=>({released:true})});
    const r=await mount(React.createElement(UnbindLocalBot,{bot:{...data.bots[0],usage:'local',localRevision:'a'.repeat(64)} as any,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));expect(fetcher).not.toHaveBeenCalled();
    await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    expect(fetcher.mock.calls[0][0]).toBe('/api/platform/local-bots/cli_test/unbind');expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({localRevision:'a'.repeat(64),confirmLocalStop:true});expect(done).toHaveBeenCalled();
  });
  it('displays unrestricted hostPath mode instead of an allowlist in workspace settings',async()=>{
    const r=await mount(React.createElement(WorkspaceSettings,{options:{...workspaceOptions,hostPathMode:'unrestricted'} as any,onClose:()=>{},onDone:()=>{}}));expect(JSON.stringify(r.toJSON())).toContain('当前不限制目录范围');expect(r.root.findAllByProps({className:'pm-approved-roots'})).toHaveLength(0);
  });
  it('shows model connections without Agent creation controls',async()=>{
    const r=await mount(React.createElement(ManagementPage,{page:'models'}));expect(r.root.findByType('h1').children).toEqual(['模型管理']);expect(button(r,'添加模型连接')).toBeDefined();expect(button(r,'创建 Agent')).toBeUndefined();
  });
  it('syncs the same model connection, leaves Bot binding unchanged and reports runtime ACK',async()=>{
    const r=await mount(React.createElement(ManagementPage,{page:'agents'}));expect(r.root.findByType('h1').children).toEqual(['Agent 管理']);
    await act(async()=>r.root.findByProps({'aria-label':'Agent One 的操作',type:'button'}).props.onClick());
    await act(async()=>button(r,'同步配置').props.onClick());
    const put=fetcher.mock.calls.find(([,init])=>init?.method==='PUT')!;
    expect(JSON.parse(put[1].body)).toEqual({revision:1,modelProfileId:'old',modelId:'model-1'});
    expect(JSON.stringify(r.toJSON())).toContain('Agent 配置已同步');
  });
  it('retains sync errors after the list is refreshed and never reports success',async()=>{
    failure=true;const r=await mount(React.createElement(ManagementPage,{page:'agents'}));await act(async()=>r.root.findByProps({'aria-label':'Agent One 的操作',type:'button'}).props.onClick());await act(async()=>button(r,'同步配置').props.onClick());
    // The click handler intentionally fires asynchronously.
    await act(async()=>{});expect(JSON.stringify(r.toJSON())).toContain('Agent 正在执行任务');expect(JSON.stringify(r.toJSON())).not.toContain('Agent 配置已同步');
  });
  it('saves a newly selected model through the runtime sync path',async()=>{
    const done=vi.fn();const r=await mount(React.createElement(ContainerForm,{data:data as any,container:current,onClose:()=>{},onDone:done}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['modelSelection',JSON.stringify(['new','new'])];yield ['botId','bot-1'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(done).toHaveBeenCalledWith(expect.stringContaining('已同步'));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({revision:1,modelProfileId:'new',modelId:'new'});
  });
  it('does not hide compatible model endpoints for an unrestricted Agent',async()=>{
    const r=await mount(React.createElement(ContainerForm,{data:{...data,models:[{...models[1],baseUrl:'https://new-endpoint.example/v1'}]} as any,container:{...current,networkMode:'unrestricted',egressHosts:[]},onClose:()=>{},onDone:()=>{}}));
    expect(JSON.stringify(r.toJSON())).toContain('网络：直连，不限制出口');
    expect(r.root.findAllByType('option').some(o=>o.props.value===JSON.stringify(['new','new']))).toBe(true);
  });
  it('offers only storage types first, then a new/existing volume or confirmed hostPath directory',async()=>{
    const r=await mount(React.createElement(ContainerForm,{data:{...data,workspaceOptions} as any,container:null,onClose:()=>{},onDone:()=>{}}));
    const selector=()=>r.root.findByProps({'aria-label':'工作区类型'});
    expect(selector().findAllByType('option').map(o=>o.props.value)).toEqual(['volume','hostpath']);
    expect(r.root.findByProps({'aria-label':'数据卷'}).findAllByType('option').map(o=>o.props.value)).toEqual(['','custom-shared-volume','old-workspace']);
    expect(r.root.findByProps({label:'已有 volume'}).props.label).toBe('已有 volume');expect(JSON.stringify(r.toJSON())).toContain('平台共享卷');
    await act(async()=>selector().props.onChange({target:{value:'hostpath'}}));expect(r.root.findByProps({name:'workspaceSource'}).props.defaultValue).toBe('/tenant/home/project');
    expect(r.root.findByProps({name:'hostPathConfirmed'}).props.required).toBe(true);
    expect(r.root.findAllByType('input').find(i=>i.props.type==='checkbox'&&!i.props.name)?.props.checked).toBe(true);
    expect(r.root.findByType('datalist').findByType('option').props.value).toBe('/tenant/home/project');
  });
  it('maps new and existing volume choices to compatible creation requests, with no separate shared mode',async()=>{
    const r=await mount(React.createElement(ContainerForm,{data:{...data,workspaceOptions} as any,container:null,onClose:()=>{},onDone:()=>{}}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['displayName','test'];yield ['modelSelection',JSON.stringify(['old','old'])];yield ['workspaceSource','stale-source'];yield ['hostPathConfirmed','on'];}});
    const submit=()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}});
    await act(async()=>submit());let payload=JSON.parse(fetcher.mock.calls.at(-1)![1].body);expect(payload.workspace).toBe('new');expect(payload.workspaceSource).toBeUndefined();expect(payload.hostPathConfirmed).toBe(false);
    for(const source of ['custom-shared-volume','old-workspace']){
      await act(async()=>r.root.findByProps({'aria-label':'数据卷'}).props.onChange({target:{value:source}}));
      await act(async()=>submit());payload=JSON.parse(fetcher.mock.calls.at(-1)![1].body);expect(payload).toMatchObject({workspace:'volume',workspaceSource:source,workspaceReadOnly:false,hostPathConfirmed:false});
    }
  });
  it('preserves selected volume when switching storage types, without leaking it into hostPath submission',async()=>{
    const r=await mount(React.createElement(ContainerForm,{data:{...data,workspaceOptions} as any,container:null,onClose:()=>{},onDone:()=>{}}));
    await act(async()=>r.root.findByProps({'aria-label':'数据卷'}).props.onChange({target:{value:'old-workspace'}}));
    await act(async()=>r.root.findByProps({'aria-label':'工作区类型'}).props.onChange({target:{value:'hostpath'}}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['modelSelection',JSON.stringify(['old','old'])];yield ['workspaceSource','/chosen/path'];yield ['hostPathConfirmed','on'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toMatchObject({workspace:'hostpath',workspaceSource:'/chosen/path',workspaceReadOnly:true,hostPathConfirmed:true});
    await act(async()=>r.root.findByProps({'aria-label':'工作区类型'}).props.onChange({target:{value:'volume'}}));
    expect(r.root.findByProps({'aria-label':'数据卷'}).props.value).toBe('old-workspace');expect(r.root.findAllByProps({name:'hostPathConfirmed'})).toHaveLength(0);
  });
  it('collapses each supported Agent by default, truncates metadata and hides actions until opened',async()=>{
    const r=await mount(React.createElement(ManagementPage,{page:'agents'}));
    expect(r.root.findByType('details').props.open).toBeUndefined();expect(r.root.findByType('summary').findAllByType('button')).toHaveLength(0);
    expect(r.root.findAllByProps({'data-tip':'pi · pi:test'})).toHaveLength(1);expect(button(r,'删除')).toBeUndefined();
    await act(async()=>r.root.findByProps({'aria-label':'Agent One 的操作',type:'button'}).props.onClick());
    expect(r.root.findAllByProps({role:'menuitem'})).toHaveLength(3);
    await act(async()=>button(r,'修改模型 / 配置').props.onClick());expect(r.root.findAllByProps({role:'menu'})).toHaveLength(0);
    expect(r.root.findAll(node=>typeof node.props['data-tip']==='string').length).toBeGreaterThan(0);
  });
  it('offers workspace settings without changing existing mounts and submits only the default path',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(WorkspaceSettings,{options:workspaceOptions as any,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByProps({name:'defaultHostPath'}).props.onChange({target:{value:'/tenant/home/other'}}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    expect(fetcher.mock.calls[0][0]).toBe('/api/platform/workspaces');expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({defaultHostPath:'/tenant/home/other'});expect(done).toHaveBeenCalled();
  });
  it('keeps rejected default settings visible without reporting success',async()=>{
    fetcher.mockResolvedValue({ok:false,json:async()=>({message:'路径不在管理员批准的 hostPath 根目录内'})});
    const done=vi.fn(),r=await mount(React.createElement(WorkspaceSettings,{options:workspaceOptions as any,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));expect(done).not.toHaveBeenCalled();expect(JSON.stringify(r.toJSON())).toContain('路径不在管理员批准');
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
