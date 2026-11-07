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
import { ManagementPage,ContainerForm,CliConfigForm,CliSwitchForm,ModelForm,DeleteModel,UnbindBot,UnbindLocalBot,WorkspaceSettings,BindLocalBot,DeleteBot } from '../src/dashboard/web/platform/management-page.js';
import {LoginWorkbench} from '../src/dashboard/web/platform/worker-access.js';
import {ProxySelect} from '../src/dashboard/web/platform/proxies.js';
import {LocalControlAgent} from '../src/dashboard/web/platform/local-control-agent.js';
import {BrowserInstanceForm} from '../src/dashboard/web/platform/browser-instances.js';
import {AgentsManagement} from '../src/dashboard/web/platform/agents.js';
import {Configuration,WorkspacePage} from '../src/dashboard/web/platform/configuration.js';
import {AGENT_SECTIONS,CONFIGURATION_SECTIONS,managementSection} from '../src/dashboard/web/platform/management-layout.js';
import {clearManagementCache} from '../src/dashboard/web/platform/management-cache.js';
import {ConfigureAgent} from '../src/dashboard/web/platform/configure-agent.js';
import {syncAgentConfiguration} from '../src/dashboard/web/platform/agent-configuration.js';
import {AgentPoolPage} from '../src/dashboard/web/platform/agent-pools.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const current={containerId:'agent-1',displayName:'Agent One',agentType:'pi',image:'pi:test',sandboxId:'sandbox',status:'ready',revision:1,appliedRevision:1,authMethod:'api-key',modelProfileId:'old',modelName:'Old',modelId:'model-1',proxyProfileId:null,egressHosts:['example.com'],botId:'bot-1',botName:'Bot',workspaceClaim:'workspace',stateClaim:'state',lastError:null};
const models=['old','new'].map(profileId=>({profileId,displayName:profileId,provider:'test',baseUrl:'https://example.com/v1',modelId:profileId,apiKeyConfigured:true,enabled:true}));
const workspaceOptions={hostPathEnabled:true,tenantHome:'/tenant/home',defaultHostPath:'/tenant/home/project',hostRoots:['/tenant/home'],workspaces:[{kind:'volume',source:'custom-shared-volume',readOnly:false,useCount:0,shared:true},{kind:'volume',source:'old-workspace',readOnly:false,useCount:1},{kind:'hostpath',source:'/tenant/home/project',readOnly:true,useCount:1}]};
const data={bots:[{botId:'bot-1',displayName:'Bot',appId:'cli_test',usage:'sandbox',containerId:'agent-1',containerRevision:1,containerStatus:'ready',secretConfigured:true}],models,containers:[current],agents:[]};
async function memberMenu(r:TestRenderer.ReactTestRenderer,name:string){await act(async()=>r.root.findAllByProps({type:'button'}).find(b=>typeof b.props['aria-label']==='string'&&b.props['aria-label'].endsWith('池成员 的操作'))!.props.onClick());await act(async()=>button(r,name==='编辑'?'修改配置':name).props.onClick());}
async function poolMenu(r:TestRenderer.ReactTestRenderer,name:string){await act(async()=>r.root.findByProps({'aria-label':'工作区池 的操作',type:'button'}).props.onClick());await act(async()=>button(r,name).props.onClick());}
const renderers:TestRenderer.ReactTestRenderer[]=[];
let fetcher:ReturnType<typeof vi.fn>,failure=false;
beforeEach(()=>{vi.useFakeTimers();failure=false;fetcher=vi.fn(async(url:string,init?:any)=>{
  const path=url.replace('/api/platform','');
  if(path.startsWith('/mcp-targets/'))return {ok:true,json:async()=>({revision:0,serverIds:[],cliIds:['pi','codex','claude-code','zcode'],servers:[]})};
  if(path.endsWith('/clis'))return {ok:true,json:async()=>({clis:[{agentType:'pi',configured:true,active:true,revision:1,appliedRevision:1}]})};
  if(path==='/proxies')return {ok:true,json:async()=>({proxies:[]})};
  if(path==='/image-cache')return {ok:true,json:async()=>({images:[{id:'sha256:test',tags:['pi:test'],agents:['pi'],roles:['worker'],size:100}],remote:[],sources:[],updatedAt:null})};
  if(path==='/local-agent')return {ok:true,json:async()=>({name:'本地 Control Agent',controlId:'local-gateway',agents:[],bots:[]})};
  if(init?.method==='PUT')return {ok:!failure,status:failure?409:200,json:async()=>failure?{message:'Agent 正在执行任务'}:{container:{...current,modelProfileId:JSON.parse(init.body).modelProfileId,modelId:JSON.parse(init.body).modelId??current.modelId,revision:2,appliedRevision:2}}};
  return {ok:true,json:async()=>path==='/catalog'?{agents:[{id:'pi',name:'Pi',supported:true,version:'0.85.1',images:[{id:'runtime',label:'运行镜像',image:'pi:test'}]}]}:path==='/workspaces'?workspaceOptions:path==='/models'?{models:data.models,capabilities:{claudeModelRouting:true}}:{[path.slice(1)]:data[path.slice(1) as keyof typeof data]}};
});vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{for(const r of renderers.splice(0))act(()=>r.unmount());clearManagementCache();vi.unstubAllGlobals();vi.useRealTimers();});
async function mount(component:React.ReactElement){let r!:TestRenderer.ReactTestRenderer;await act(async()=>{r=TestRenderer.create(component);});renderers.push(r);return r;}
const button=(r:TestRenderer.ReactTestRenderer,text:string)=>r.root.findAllByType('button').find(b=>b.children.join('')===text)!;
const poolA={poolId:'pool-a',displayName:'A',workspaceKind:'volume',workspaceSource:'workspace-a'};
const poolB={poolId:'pool-b',displayName:'B',workspaceKind:'hostpath',workspaceSource:'/workspace-b'};
const poolMember={memberId:'member-a',poolId:'pool-a',containerId:'pool-container',displayName:'Member A',description:'Capability A',agentType:'pi',modelProfileId:'old',modelId:'old',cpu:2,memoryMiB:4096,taskCpu:1,taskMemoryMiB:2048,revision:1,enabled:true,quarantined:false,configurationPending:false,status:'ready',occupied:0};
function setupPools(){
 const responses:any={'/agent-pools':{pools:[poolA,poolB]},'/agent-pools/pool-a':{members:[{...poolMember}]},'/agent-pools/pool-b':{members:[{...poolMember,memberId:'member-b',displayName:'Member B',poolId:'pool-b'}]},'/catalog':{agents:[{id:'pi',name:'Pi',supported:true,protocols:['openai-completions']}]},'/models':{models},'/containers':{containers:[]},'/workspaces':{...workspaceOptions,globalReadOnlyHostPath:'/global'},'/workflow-resources':{jobs:[]}};
 clearManagementCache();fetcher.mockImplementation(async(url:string,init?:any)=>({ok:true,status:200,json:async()=>responses[url.replace('/api/platform','')]??{members:[]}}));return responses;
}
const formValues=(values:Record<string,string>)=>vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield* Object.entries(values);}});
const poolValues={displayName:'Edited',description:'Changed ability',taskCpu:'0.5',taskMemoryMiB:'1024',modelChoice:'["old","old"]'};
const submitPool=(r:TestRenderer.ReactTestRenderer)=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}});
const writes=()=>fetcher.mock.calls.filter(([,init])=>init?.method!=='GET');
describe('登录工作台关闭受理',()=>{
 it('关闭意图覆盖旧轮询响应，202 后保持关闭中直到列表确认消失',async()=>{
  const login={loginId:'close-fixture',containerId:'agent-1',profileId:'profile',state:'waiting',workerState:'waiting',expiresAt:'2099-01-01T00:00:00Z'};
  let closing=false,finished=false,hold=false,release!:(value:any)=>void;
  fetcher.mockImplementation(async(url:string,init?:any)=>{
   const path=url.replace('/api/platform','');
   if(path==='/logins/close-fixture'&&init?.method==='DELETE'){closing=true;return {ok:true,status:202,json:async()=>({closed:false,closing:true})};}
   if(path==='/logins/close-fixture')return {ok:true,json:async()=>({...login})};
   if(path==='/logins'){
    if(hold){hold=false;return new Promise(resolve=>release=resolve);}
    return {ok:true,json:async()=>({logins:finished?[]:[{...login,state:closing?'closing':'waiting'}]})};
   }
   return {ok:true,json:async()=>path==='/containers'?{containers:[]}:path==='/browser-profiles'?{profiles:[]}:{proxies:[]}};
  });
  const r=await mount(React.createElement(LoginWorkbench,{container:null,containers:[],onClose:()=>{}}));
  hold=true;await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  await act(async()=>button(r,'关闭工作台 · 保留数据').props.onClick());
  expect(button(r,'正在关闭…').props.disabled).toBe(true);
  await act(async()=>release({ok:true,json:async()=>({logins:[{...login}]})}));
  expect(button(r,'正在关闭…').props.disabled).toBe(true);
  const inspections=fetcher.mock.calls.filter(([url,init])=>url.endsWith('/logins/close-fixture')&&init?.method==='POST').length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(fetcher.mock.calls.filter(([url,init])=>url.endsWith('/logins/close-fixture')&&init?.method==='POST')).toHaveLength(inspections);
  finished=true;await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(r.root.findAllByType('article')).toHaveLength(0);
  expect(fetcher.mock.calls.filter(([url,init])=>url.endsWith('/logins/close-fixture')&&init?.method==='DELETE')).toHaveLength(1);
 });
});

describe('首次登记工作区池',()=>{
 const newId='11111111-1111-4111-8111-111111111111';
 function setupRegistration(){
  const responses=setupPools();responses['/agent-pools'].pools=[];responses['/models'].models=[];
  const fallback=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async(url:string,init?:any)=>{
   if(url==='/api/platform/agent-pools'&&init?.method==='POST'){
    const body=JSON.parse(init.body);const row={poolId:newId,displayName:body.displayName,workspaceKind:body.workspaceKind,workspaceSource:body.workspaceSource};
    responses['/agent-pools'].pools=[row];responses['/agent-pools/'+newId]={members:[]};return {ok:true,status:200,json:async()=>({poolId:newId,members:[]})};
   }
   return fallback(url,init);
  });return responses;
 }
 async function openRegistration(r:TestRenderer.ReactTestRenderer){await act(async()=>button(r,'创建工作区池').props.onClick());}
 async function choose(r:TestRenderer.ReactTestRenderer,kind:string,source:string,name='Test pool'){
  await act(async()=>{r.root.findByProps({name:'poolDisplayName'}).props.onChange({target:{value:name}});r.root.findByProps({name:'poolWorkspace'}).props.onChange({target:{value:JSON.stringify([kind,source])}});});
 }
 it('空池与空模型仍能从可见入口登记，并自动选中且允许成员操作',async()=>{
  setupRegistration();const r=await mount(React.createElement(AgentPoolPage));expect(button(r,'创建工作区池').props.disabled).toBe(false);
  await act(async()=>r.root.findByProps({'aria-label':'工作区池 的操作',type:'button'}).props.onClick());expect(button(r,'新建池成员').props.disabled).toBe(true);
  await act(async()=>r.root.findByProps({'aria-label':'工作区池 的操作',type:'button'}).props.onClick());
  await openRegistration(r);await choose(r,'volume','custom-shared-volume');await act(async()=>submitPool(r));
  expect(r.root.findAllByType('dialog')).toHaveLength(0);expect(r.root.findByProps({'aria-label':'Agent 池'}).props.value).toBe(newId);
  expect(writes()).toHaveLength(1);expect(writes()[0][0]).toBe('/api/platform/agent-pools');expect(JSON.parse(writes()[0][1].body)).toEqual({displayName:'Test pool',workspaceKind:'volume',workspaceSource:'custom-shared-volume'});
  await act(async()=>r.root.findByProps({'aria-label':'工作区池 的操作',type:'button'}).props.onClick());expect(button(r,'新建池成员').props.disabled).toBe(false);expect(button(r,'纳入已有 Agent').props.disabled).toBe(false);
 });
 it.each(['volume','hostpath'])('登记%s只提交工作区身份，不创建容器或纳入Agent',async kind=>{
  const responses=setupRegistration(),source=kind==='volume'?'custom-shared-volume':'/tenant/home/project';responses['/workspaces'].workspaces=[{kind,source,readOnly:false}];
  const r=await mount(React.createElement(AgentPoolPage));await openRegistration(r);await choose(r,kind,source);await act(async()=>submitPool(r));expect(writes()).toHaveLength(1);expect(JSON.parse(writes()[0][1].body)).toEqual({displayName:'Test pool',workspaceKind:kind,workspaceSource:source});
 });
 it.each(['empty','readonly','unknown','disabled-host'])('无可用工作区(%s)不给虚构选项且不发送写请求',async kind=>{
  const responses=setupRegistration();responses['/workspaces'].workspaces=kind==='empty'?[]:kind==='unknown'?[{kind:'unexpected',source:'bad',readOnly:false}]:[{kind:'hostpath',source:'/tenant/home/project',readOnly:kind==='readonly'}];if(kind==='disabled-host')responses['/workspaces'].hostPathEnabled=false;
  const r=await mount(React.createElement(AgentPoolPage));await openRegistration(r);expect(button(r,'登记工作区池').props.disabled).toBe(true);
  const options=r.root.findByProps({name:'poolWorkspace'}).findAllByType('option');expect(options.slice(1).every(o=>o.props.disabled)).toBe(true);
  expect(r.root.findAllByType('a').some(a=>a.props.href==='#/platform-configuration?section=workspaces')).toBe(true);
  await choose(r,'volume','invented');await act(async()=>submitPool(r));expect(writes()).toHaveLength(0);
 });
 it('重复提交只POST一次，失败后保留输入和工作区并可重试',async()=>{
  setupRegistration();const r=await mount(React.createElement(AgentPoolPage));await openRegistration(r);await choose(r,'volume','custom-shared-volume','Kept name');
  const fallback=fetcher.getMockImplementation()!;let release!:(value:any)=>void;
  fetcher.mockImplementation(async(url:string,init?:any)=>init?.method==='POST'?new Promise(resolve=>release=resolve):fallback(url,init));
  let pending!:Promise<void>;await act(async()=>{pending=submitPool(r);void submitPool(r);});expect(writes()).toHaveLength(1);expect(button(r,'正在登记…').props.disabled).toBe(true);
  await act(async()=>{release({ok:false,status:409,json:async()=>({message:'Workspace unavailable'})});await pending;});
  expect(r.root.findByProps({name:'poolDisplayName'}).props.value).toBe('Kept name');expect(r.root.findByProps({name:'poolWorkspace'}).props.value).toBe('["volume","custom-shared-volume"]');expect(button(r,'登记工作区池').props.disabled).toBe(false);expect(r.root.findByType('dialog').findAllByProps({role:'alert'})).toHaveLength(1);
  fetcher.mockImplementation(fallback);await act(async()=>submitPool(r));expect(writes()).toHaveLength(2);expect(writes()[0][1].body).toBe(writes()[1][1].body);
 });
 it.each([undefined,'invalid-pool-id','../unsafe'])('2xx缺失或非法池ID(%s)不假作完成，仍可核对和重试',async poolId=>{
  setupRegistration();const r=await mount(React.createElement(AgentPoolPage));await openRegistration(r);const fallback=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async(url:string,init?:any)=>init?.method==='POST'?{ok:true,json:async()=>({poolId,members:[]})}:fallback(url,init));await act(async()=>submitPool(r));
  expect(r.root.findAllByType('dialog')).toHaveLength(1);expect(r.root.findByType('dialog').findAllByProps({role:'alert'})).toHaveLength(1);expect(button(r,'登记工作区池').props.disabled).toBe(false);
 });
 it('POST成功但刷新失败明确已登记，刷新重试不重复POST',async()=>{
  setupRegistration();const r=await mount(React.createElement(AgentPoolPage));await openRegistration(r);let inserted=false,failRefresh=true;const fallback=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async(url:string,init?:any)=>{if(url==='/api/platform/agent-pools'&&init?.method==='POST'){inserted=true;return fallback(url,init);}if(url==='/api/platform/agent-pools'&&inserted&&failRefresh)return {ok:false,status:503,json:async()=>({message:'List unavailable'})};return fallback(url,init);});
  await act(async()=>submitPool(r));expect(r.root.findAllByType('dialog')).toHaveLength(0);expect(writes()).toHaveLength(1);expect(r.root.findAllByProps({role:'alert'}).some(a=>a.children.join('').includes('已登记'))).toBe(true);
  failRefresh=false;await act(async()=>button(r,'刷新').props.onClick());expect(writes()).toHaveLength(1);expect(r.root.findByProps({'aria-label':'Agent 池'}).props.value).toBe(newId);
 });
 it('同工作区返回已有池时选中它而不是列表首项，不另造成员',async()=>{
  const responses=setupRegistration(),existingId='22222222-2222-4222-8222-222222222222';responses['/agent-pools'].pools=[poolA,{...poolB,poolId:existingId}];responses['/agent-pools/'+existingId]={members:[]};const r=await mount(React.createElement(AgentPoolPage));await openRegistration(r);const fallback=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async(url:string,init?:any)=>init?.method==='POST'?{ok:true,json:async()=>({poolId:existingId,members:[]})}:fallback(url,init));await act(async()=>submitPool(r));expect(r.root.findByProps({'aria-label':'Agent 池'}).props.value).toBe(existingId);expect(writes()).toHaveLength(1);
 });
 it('旧的列表响应迟到不会覆盖已登记池的选中状态',async()=>{
  const responses=setupRegistration();const r=await mount(React.createElement(AgentPoolPage));let hold=true,release!:(value:any)=>void;const fallback=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async(url:string,init?:any)=>{if(url==='/api/platform/agent-pools'&&init?.method==='GET'&&hold){hold=false;return new Promise(resolve=>release=resolve);}return fallback(url,init);});
  await act(async()=>button(r,'刷新').props.onClick());await openRegistration(r);await act(async()=>submitPool(r));expect(r.root.findByProps({'aria-label':'Agent 池'}).props.value).toBe(newId);
  responses['/agent-pools/pool-a']={members:[]};await act(async()=>release({ok:true,json:async()=>({pools:[poolA]})}));expect(r.root.findByProps({'aria-label':'Agent 池'}).props.value).toBe(newId);
 });
 it('页面卸载后迟到的登记确认不继续刷新或改选中状态',async()=>{
  setupRegistration();const r=await mount(React.createElement(AgentPoolPage));await openRegistration(r);let release!:(value:any)=>void;const fallback=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async(url:string,init?:any)=>init?.method==='POST'?new Promise(resolve=>release=resolve):fallback(url,init));let pending!:Promise<void>;await act(async()=>{pending=submitPool(r);});
  const before=fetcher.mock.calls.length;await act(async()=>r.unmount());await act(async()=>{release({ok:true,json:async()=>({poolId:newId,members:[]})});await pending;});expect(fetcher.mock.calls).toHaveLength(before);
 });
});

describe('Agent pool behavior',()=>{
 it('loads the initial list and default detail once, and ignores a stale selected-pool response',async()=>{
  setupPools();const r=await mount(React.createElement(AgentPoolPage));
  expect(fetcher.mock.calls.filter(([url])=>url==='/api/platform/agent-pools')).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([url])=>url==='/api/platform/agent-pools/pool-a')).toHaveLength(1);
  const fallback=fetcher.getMockImplementation()!;let release!:(value:any)=>void;
  fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/pool-b')?new Promise(resolve=>release=resolve):fallback(url,init));
  await act(async()=>r.root.findByProps({'aria-label':'Agent 池'}).props.onChange({target:{value:'pool-b'}}));
  await act(async()=>r.root.findByProps({'aria-label':'Agent 池'}).props.onChange({target:{value:'pool-a'}}));
  await act(async()=>release({ok:true,json:async()=>({members:[{...poolMember,displayName:'Stale B'}]})}));
  expect(r.root.findByProps({'aria-label':'Agent 池'}).props.value).toBe('pool-a');
  expect(r.root.findAllByType('tbody')[0].findAllByType('strong')[0].findByProps({title:'Member A'}).children).toEqual(['Member A']);
 });
 it('loads a waiting job target independently and blocks submissions until pool B is ready',async()=>{
  const responses=setupPools();responses['/workflow-resources'].jobs=[{jobId:'job-b',poolId:'pool-b',runId:'run-b',waitReason:'capability'}];
  const r=await mount(React.createElement(AgentPoolPage));const fallback=fetcher.getMockImplementation()!;let release!:(value:any)=>void;
  fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/pool-b')?new Promise(resolve=>release=resolve):fallback(url,init));
  await act(async()=>button(r,'选择 / 补建 Agent').props.onClick());
  await act(async()=>r.root.findByProps({'aria-label':'处理方式'}).props.onChange({target:{value:'existing'}}));
  expect(button(r,'保存并继续').props.disabled).toBe(true);expect(r.root.findByProps({name:'memberId'}).findAllByType('option')).toHaveLength(0);
  formValues({memberId:'member-b'});await act(async()=>submitPool(r));expect(writes()).toHaveLength(0);
  await act(async()=>release({ok:true,json:async()=>responses['/agent-pools/pool-b']}));
  expect(r.root.findByProps({name:'memberId'}).findAllByType('option').map(node=>node.props.value)).toEqual(['member-b']);
  expect(JSON.stringify(r.toJSON())).toContain('/workspace-b');
  expect(r.root.findByProps({'aria-label':'Agent 池'}).props.value).toBe('pool-a');
  await act(async()=>submitPool(r));expect(JSON.parse(writes()[0][1].body)).toEqual({memberId:'member-b'});
  expect(writes()[0][0]).toBe('/api/platform/workflow-resources/run-b/job-b/resolve');
 });
 it('keeps target-load errors inline and retries, ignoring responses from a closed job',async()=>{
  const responses=setupPools();responses['/workflow-resources'].jobs=[{jobId:'job-b',poolId:'pool-b',runId:'run-b',waitReason:'capability'}];
  const r=await mount(React.createElement(AgentPoolPage));const fallback=fetcher.getMockImplementation()!;let fail=true,release!:(value:any)=>void;
  fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/pool-b')?fail?{ok:false,json:async()=>({message:'Unavailable pool'})}:new Promise(resolve=>release=resolve):fallback(url,init));
  await act(async()=>button(r,'选择 / 补建 Agent').props.onClick());
  expect(r.root.findByType('dialog').findAllByProps({role:'alert'})).toHaveLength(1);expect(button(r,'保存并继续').props.disabled).toBe(true);
  fail=false;await act(async()=>button(r,'重试加载').props.onClick());await act(async()=>r.root.findByType('dialog').findByProps({'aria-label':'关闭'}).props.onClick());
  await poolMenu(r,'新建池成员');
  await act(async()=>release({ok:true,json:async()=>responses['/agent-pools/pool-b']}));
  expect(r.root.findByType('dialog').findAllByProps({'aria-label':'处理方式'})).toHaveLength(0);
  expect(JSON.stringify(r.toJSON())).not.toContain('Unavailable pool');
 });
 it.each(['cpu','memoryMiB','mountGlobalReadOnly'])('requires explicit rebuild confirmation only for %s changes',async field=>{
  setupPools();const r=await mount(React.createElement(AgentPoolPage));await memberMenu(r,'编辑');formValues(poolValues);
  expect(button(r,'保存并继续').props.disabled).toBe(false);
  await act(async()=>r.root.findByProps({name:field}).props.onChange({target:field==='mountGlobalReadOnly'?{checked:true}:{value:field==='cpu'?'4':'8192'}}));
  expect(button(r,'保存并继续').props.disabled).toBe(true);await act(async()=>submitPool(r));expect(writes()).toHaveLength(0);
  await act(async()=>r.root.findByProps({name:'confirmRestart'}).props.onChange({target:{checked:true}}));
  await act(async()=>submitPool(r));expect(writes()).toHaveLength(1);expect(writes()[0][0]).toBe('/api/platform/agent-pools/pool-a/members/member-a/rebuild');
  expect(JSON.parse(writes()[0][1].body)).toMatchObject({displayName:'Edited',confirmRestart:true,revision:1});
 });
 it('allows ordinary edits without rebuild confirmation or enabled models',async()=>{
  const responses=setupPools();responses['/models'].models=[];
  const r=await mount(React.createElement(AgentPoolPage));await memberMenu(r,'编辑');formValues(poolValues);
  expect(r.root.findAllByProps({name:'confirmRestart'})).toHaveLength(0);expect(button(r,'保存并继续').props.disabled).toBe(false);
  await act(async()=>submitPool(r));expect(writes()[0][0]).toBe('/api/platform/agent-pools/pool-a/members/member-a');expect(writes()[0][1].method).toBe('PUT');
 });
 it('refreshes enroll candidates across tabs and excludes either pool ownership marker',async()=>{
  const responses=setupPools();const container={...current,botId:null,poolId:null,poolMemberId:null,workspaceClaim:'workspace-a'};
  responses['/containers'].containers=[container];const r=await mount(React.createElement(AgentPoolPage));
  responses['/containers'].containers=[{...container,containerId:'fresh'},{...container,containerId:'other-pool',poolId:'pool-b'},{...container,containerId:'marked',poolMemberId:'historical-member'},{...container,containerId:'readonly',workspaceReadOnly:true}];
  await poolMenu(r,'纳入已有 Agent');
  expect(r.root.findByProps({name:'containerId'}).findAllByType('option').map(node=>node.props.value)).toEqual(['fresh']);
  expect(fetcher.mock.calls.filter(([url])=>url==='/api/platform/containers')).toHaveLength(2);
 });
 it('explains an empty enrollment list instead of showing only a disabled form',async()=>{
  const responses=setupPools();responses['/containers'].containers=[{...current,botId:'bot-1',poolId:null,poolMemberId:null,workspaceClaim:'workspace-a'}];
  const r=await mount(React.createElement(AgentPoolPage));await poolMenu(r,'纳入已有 Agent');
  expect(button(r,'保存并继续').props.disabled).toBe(true);
  expect(r.root.findByType('dialog').findAll(node=>node.type==='p'&&node.props.role==='status').length).toBe(1);
  responses['/containers'].containers=[{...current,botId:null,poolId:null,poolMemberId:null,workspaceClaim:'workspace-a'}];
  await act(async()=>button(r,'取消').props.onClick());
  await poolMenu(r,'纳入已有 Agent');
  expect(r.root.findByType('dialog').findAll(node=>node.type==='p'&&node.props.role==='status')).toHaveLength(0);
  expect(button(r,'保存并继续').props.disabled).toBe(false);
 });
 it('rejects a per-task budget larger than the member quota before any request',async()=>{
  setupPools();const r=await mount(React.createElement(AgentPoolPage));await memberMenu(r,'编辑');
  const dialog=()=>r.root.findByType('dialog');
  expect(button(r,'保存并继续').props.disabled).toBe(false);
  await act(async()=>dialog().findByProps({name:'taskCpu'}).props.onChange({target:{value:String(poolMember.cpu*4)}}));
  expect(button(r,'保存并继续').props.disabled).toBe(true);
  expect(dialog().findAll(node=>node.type==='p'&&node.props.role==='alert')).toHaveLength(1);
  await act(async()=>dialog().findByProps({name:'taskCpu'}).props.onChange({target:{value:String(poolMember.cpu)}}));
  await act(async()=>dialog().findByProps({name:'taskMemoryMiB'}).props.onChange({target:{value:String(poolMember.memoryMiB+1)}}));
  expect(button(r,'保存并继续').props.disabled).toBe(true);
  await act(async()=>dialog().findByProps({name:'taskMemoryMiB'}).props.onChange({target:{value:String(poolMember.memoryMiB)}}));
  expect(button(r,'保存并继续').props.disabled).toBe(false);
  expect(writes()).toHaveLength(0);
 });
 it('blocks new members with no compatible model but allows selecting existing members',async()=>{
  const responses=setupPools();responses['/models'].models=[];responses['/workflow-resources'].jobs=[{jobId:'job',poolId:'pool-a',runId:'run',waitReason:'capability'}];
  const r=await mount(React.createElement(AgentPoolPage));await act(async()=>button(r,'选择 / 补建 Agent').props.onClick());
  expect(button(r,'保存并继续').props.disabled).toBe(true);expect(r.root.findByType('dialog').findByType('a').props.href).toBe('#/platform-configuration?section=models');
  await act(async()=>r.root.findByProps({'aria-label':'处理方式'}).props.onChange({target:{value:'existing'}}));expect(button(r,'保存并继续').props.disabled).toBe(false);
 });
 it('uses the empty model ID for dynamic protocols even with stale static IDs',async()=>{
  const responses=setupPools();responses['/catalog'].agents=[{id:'pi',name:'Pi',supported:true,protocols:['vercel-claude']}];responses['/models'].models=[{...models[0],protocol:'vercel-claude',modelIds:['stale'],modelId:'stale'}];
  const r=await mount(React.createElement(AgentPoolPage));await poolMenu(r,'新建池成员');
  const choice=r.root.findByProps({name:'modelChoice'}).findByType('option').props.value;expect(JSON.parse(choice)).toEqual(['old','']);
  formValues({...poolValues,modelChoice:choice});await act(async()=>submitPool(r));expect(JSON.parse(writes()[0][1].body).modelId).toBe('');
 });
 it('polls waiting resources without invalidation and manually refreshes changed models',async()=>{
  const responses=setupPools();responses['/workflow-resources'].jobs=[{jobId:'job',poolId:'pool-a',runId:'run',waitReason:'capacity'}];const r=await mount(React.createElement(AgentPoolPage));
  responses['/models'].models=[];await act(async()=>vi.advanceTimersByTimeAsync(5000));
  expect(fetcher.mock.calls.filter(([url])=>url==='/api/platform/models')).toHaveLength(1);expect(fetcher.mock.calls.filter(([url])=>url==='/api/platform/workflow-resources')).toHaveLength(2);
  await act(async()=>button(r,'刷新').props.onClick());expect(fetcher.mock.calls.filter(([url])=>url==='/api/platform/models')).toHaveLength(2);
  await poolMenu(r,'新建池成员');expect(button(r,'保存并继续').props.disabled).toBe(true);
 });
 it('locks synchronously, retains member inputs and stable request IDs after a delayed failure',async()=>{
  setupPools();const r=await mount(React.createElement(AgentPoolPage));await poolMenu(r,'新建池成员');formValues(poolValues);
  const fallback=fetcher.getMockImplementation()!;let release!:(value:any)=>void;
  fetcher.mockImplementation(async(url:string,init?:any)=>init?.method==='POST'?new Promise(resolve=>release=resolve):fallback(url,init));
  let pending!:Promise<void>;await act(async()=>{pending=submitPool(r);void submitPool(r);});expect(writes()).toHaveLength(1);expect(button(r,'处理中…').props.disabled).toBe(true);
  await act(async()=>{release({ok:false,json:async()=>({message:'Delayed rejection'})});await pending;});
  expect(r.root.findByType('dialog').findAllByProps({role:'alert'})).toHaveLength(1);expect(r.root.findByProps({name:'cpu'}).props.value).toBe(2);expect(button(r,'保存并继续').props.disabled).toBe(false);
  fetcher.mockImplementation(fallback);await act(async()=>submitPool(r));expect(JSON.parse(writes()[0][1].body).requestId).toBe(JSON.parse(writes()[1][1].body).requestId);
 });
 it.each(['remove','cancel'])('keeps %s dialogs open with inline error and releases busy on failed submission',async kind=>{
  const responses=setupPools();if(kind==='cancel')responses['/agent-pools/pool-a'].members[0].configurationPending=true;
  const r=await mount(React.createElement(AgentPoolPage));if(kind==='pool')await poolMenu(r,'新建工作区池');else await memberMenu(r,kind==='remove'?'移出':'撤销待确认配置');
  formValues({displayName:'Kept name',workspace:'["volume","workspace-a"]'});const fallback=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async(url:string,init?:any)=>init?.method==='GET'?fallback(url,init):{ok:false,json:async()=>({message:'Not confirmed'})});
  await act(async()=>submitPool(r));expect(r.root.findByType('dialog').findAllByProps({role:'alert'})).toHaveLength(1);
  expect(button(r,kind==='pool'?'保存':kind==='remove'?'确认移出':'确认撤销').props.disabled).toBe(false);
 });
 it('keeps cancellation busy until receipt and refuses a 2xx without cancelled=true',async()=>{
  const responses=setupPools();responses['/agent-pools/pool-a'].members[0].configurationPending=true;
  const r=await mount(React.createElement(AgentPoolPage));await memberMenu(r,'撤销待确认配置');formValues({});
  const fallback=fetcher.getMockImplementation()!;let release!:(value:any)=>void;fetcher.mockImplementation(async(url:string,init?:any)=>init?.method==='POST'?new Promise(resolve=>release=resolve):fallback(url,init));
  let pending!:Promise<void>;await act(async()=>{pending=submitPool(r);void submitPool(r);});expect(writes()).toHaveLength(1);
  expect(r.root.findByType('dialog').findByProps({'aria-label':'关闭'}).props.disabled).toBe(true);expect(r.root.findByProps({'aria-label':'Member A 池成员 的操作',type:'button'}).props.disabled).toBe(true);
  await act(async()=>{release({ok:true,json:async()=>({members:[poolMember]})});await pending;});expect(r.root.findAllByType('dialog')).toHaveLength(1);
  expect(JSON.parse(writes()[0][1].body)).toEqual({revision:1});
  fetcher.mockImplementation(async(url:string,init?:any)=>init?.method==='POST'?{ok:true,json:async()=>({cancelled:true})}:fallback(url,init));
  await act(async()=>submitPool(r));expect(r.root.findAllByType('dialog')).toHaveLength(0);
 });
 it('accepts an explicit confirmed removal receipt from configuration compensation',async()=>{
  const responses=setupPools();responses['/agent-pools/pool-a'].members[0].configurationPending=true;
  const fallback=fetcher.getMockImplementation()!;fetcher.mockImplementation(async(url:string,init?:any)=>init?.method==='POST'?{ok:true,json:async()=>({members:[],configurationConfirmed:true,removedMemberId:'member-a'})}:fallback(url,init));
  const r=await mount(React.createElement(AgentPoolPage));await memberMenu(r,'重试配置');expect(r.root.findAllByProps({role:'alert'})).toHaveLength(0);
 });
 it('does not treat an unconfirmed configuration retry as success and catches list errors',async()=>{
  const responses=setupPools();responses['/agent-pools/pool-a'].members[0].configurationPending=true;
  const r=await mount(React.createElement(AgentPoolPage));await memberMenu(r,'重试配置');
  expect(r.root.findAllByProps({role:'alert'})).toHaveLength(1);expect(r.root.findByProps({'aria-label':'Member A 池成员 的操作',type:'button'}).props.disabled).toBe(false);
  expect(writes()[0][0]).toBe('/api/platform/agent-pools/pool-a/members/member-a/configuration');
 });
});
describe('model and Agent management UI',()=>{
  function setupSingleConfiguration(agentType:'codex'|'zcode',authMethod:'api-key'|'oauth'='api-key'){
    const row={...current,agentType,image:agentType+':test',imageAgents:[agentType],authMethod,modelProfileId:authMethod==='oauth'?null:'old',modelId:authMethod==='oauth'?'native-old':'model-1'};
    const fallback=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(url:string,init?:any)=>{
      const path=url.replace('/api/platform','');
      if(path==='/containers'&&(!init?.method||init?.method==='GET'))return {ok:true,json:async()=>({containers:[row]})};
      if(path==='/models')return {ok:true,json:async()=>({models:[{...models[0],protocol:agentType==='codex'?'openai-responses':'zcode-coding-plan',modelIds:['model-1','api-new']} ]})};
      if(path.startsWith('/mcp-targets/'))return {ok:true,json:async()=>(init?.method==='POST'?{applied:true}:{revision:1,serverIds:[],cliIds:[agentType],servers:[]})};
      if(path.endsWith('/clis'))return {ok:true,json:async()=>({clis:[{agentType,configured:true,active:true,revision:1,appliedRevision:1}]})};
      if(path==='/containers/agent-1'&&init?.method==='PUT')return {ok:!failure,status:failure?409:200,json:async()=>failure?{message:'busy fixture'}:{container:{...row,...JSON.parse(init.body),revision:2,appliedRevision:2}}};
      return fallback(url,init);
    });return row;
  }
  it.each(['codex','zcode'] as const)('单CLI %s可从API Key切换OAuth，仅原地保存模型',async agentType=>{
    const row=setupSingleConfiguration(agentType),done=vi.fn(),r=await mount(React.createElement(ConfigureAgent,{container:row as any,onClose:()=>{},onDone:done}));
    const picker=r.root.findByProps({'aria-label':'配置模型'});expect(picker.props.value).toBe('["old","model-1"]');expect(picker.findAllByType('option').some(option=>option.props.value==='[null,null]')).toBe(true);
    await act(async()=>picker.props.onChange({target:{value:'[null,null]'}}));
    if(agentType==='codex')await act(async()=>r.root.findByProps({'aria-label':'配置 OAuth 模型'}).props.onChange({target:{value:' native-new '}}));
    else expect(r.root.findAllByProps({'aria-label':'配置 OAuth 模型'})).toHaveLength(0);
    expect(r.root.findByProps({'aria-label':'配置模型'}).props.value).toBe('[null,null]');await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    const writes=fetcher.mock.calls.filter(([,init])=>init?.method==='POST'||init?.method==='PUT');expect(writes.map(([url])=>url)).toEqual(['/api/platform/mcp-targets/agent-1','/api/platform/containers/agent-1']);
    expect(JSON.parse(writes[1][1].body)).toMatchObject({modelProfileId:null,modelId:agentType==='codex'?'native-new':null,authMethod:'oauth'});expect(JSON.parse(writes[1][1].body)).not.toHaveProperty('botId');expect(done).toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([url])=>url.includes('/upgrade')||url.includes('/login'))).toBe(false);
  });
  it('已有OAuth模型回填，失败保留输入，再切回API Key不重建',async()=>{
    const row=setupSingleConfiguration('codex','oauth'),done=vi.fn(),r=await mount(React.createElement(ConfigureAgent,{container:row as any,onClose:()=>{},onDone:done}));
    expect(r.root.findByProps({'aria-label':'配置模型'}).props.value).toBe('[null,null]');expect(r.root.findByProps({'aria-label':'配置 OAuth 模型'}).props.value).toBe('native-old');
    await act(async()=>r.root.findByProps({'aria-label':'配置 OAuth 模型'}).props.onChange({target:{value:'edited-native'}}));failure=true;await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    expect(done).not.toHaveBeenCalled();expect(r.root.findByProps({'aria-label':'配置 OAuth 模型'}).props.value).toBe('edited-native');
    failure=false;await act(async()=>r.root.findByProps({'aria-label':'配置模型'}).props.onChange({target:{value:'["old","api-new"]'}}));expect(r.root.findAllByProps({'aria-label':'配置 OAuth 模型'})).toHaveLength(0);
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));const [,request]=fetcher.mock.calls.filter(([,init])=>init?.method==='PUT').at(-1)!;
    expect(JSON.parse(request.body)).toMatchObject({modelProfileId:'old',modelId:'api-new',authMethod:'api-key'});expect(done).toHaveBeenCalled();expect(fetcher.mock.calls.some(([url])=>url.includes('/upgrade')||url.includes('/login'))).toBe(false);
  });
  it('shows API-key and OAuth credential status separately in the local Agent table',async()=>{
    const fallback=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/local-agent')?{ok:true,json:async()=>({agents:[
      {agentType:'claude-code',revision:1,appliedRevision:1,authMethod:'api-key',requiresLogin:false,credentialKind:'api-key',credentialPresent:true,status:'synced'},
      {agentType:'codex',revision:1,appliedRevision:1,authMethod:'oauth',requiresLogin:true,credentialKind:'oauth',credentialPresent:false,status:'synced'},
    ],bots:[]})}:fallback(url,init));
    const r=await mount(React.createElement(LocalControlAgent,{models:[]}));
    const rows=r.root.findAllByType('tbody')[0].findAllByType('tr');
    expect(rows[0].findAllByType('small').map(item=>item.children.join(''))).toContain('已配置 API Key');
    expect(rows[1].findAllByType('small').map(item=>item.children.join(''))).toContain('未发现登录凭据');
  });
  it('opens unified instance configuration without separate switch or MCP menu items',async()=>{
 const fallback=fetcher.getMockImplementation()!;fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/containers')&&init?.method==='GET'?{ok:true,json:async()=>({containers:[{...current,imageAgents:['pi','codex'],runtimeKind:'native-botmux'}]})}:fallback(url,init));
 const r=await mount(React.createElement(ManagementPage,{page:'agents'}));await act(async()=>r.root.findByProps({'aria-label':'Agent One 的操作',type:'button'}).props.onClick());
 expect(button(r,'切换 CLI')).toBeUndefined();expect(button(r,'MCP 管理')).toBeUndefined();expect(button(r,'同步配置')).toBeUndefined();await act(async()=>button(r,'修改配置').props.onClick());expect(r.root.findAllByType(ConfigureAgent)).toHaveLength(1);
 });
  it('switches a Dev instance with the local dropdown layout and the selected CLI revision',async()=>{
    const clis=[{agentType:'pi',active:true,configured:true,revision:2,appliedRevision:2},{agentType:'codex',configured:false,revision:0,appliedRevision:0},{agentType:'claude-code',configured:true,revision:4,appliedRevision:4}];
    fetcher.mockImplementation(async(_url:string,init?:any)=>({ok:true,json:async()=>({clis:init?.method==='POST'?clis.map(cli=>({...cli,active:cli.agentType==='claude-code'})):clis})}));
    const done=vi.fn(),r=await mount(React.createElement(CliSwitchForm,{container:current as any,agents:[{id:'pi',name:'Pi'},{id:'codex',name:'Codex'},{id:'claude-code',name:'Claude Code'}] as any,onClose:()=>{},onDone:done}));
    const picker=r.root.findByProps({'aria-label':'CLI'});
    expect(picker.props.value).toBe('pi');
    expect(picker.findAllByType('option').find(option=>option.props.value==='codex')?.props.disabled).toBe(true);
    expect(button(r,'确认切换').props.disabled).toBe(true);
    await act(async()=>picker.props.onChange({target:{value:'claude-code'}}));
    await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
    expect(button(r,'确认切换').props.disabled).toBe(false);
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    const [,request]=fetcher.mock.calls.find(([,init])=>init?.method==='POST')!;
    expect(JSON.parse(request.body)).toEqual({revision:4});expect(done).toHaveBeenCalled();
  });
  it('retains the instance picker and displays an error when the runtime rejects a switch',async()=>{
    const clis=[{agentType:'pi',active:true,configured:true,revision:2,appliedRevision:2},{agentType:'codex',configured:true,revision:3,appliedRevision:3}];
    fetcher.mockImplementation(async(_url:string,init?:any)=>init?.method==='POST'?{ok:false,json:async()=>({message:'Agent 正在执行任务'})}:{ok:true,json:async()=>({clis})});
    const done=vi.fn(),r=await mount(React.createElement(CliSwitchForm,{container:current as any,agents:[{id:'pi',name:'Pi'},{id:'codex',name:'Codex'}] as any,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByProps({'aria-label':'CLI'}).props.onChange({target:{value:'codex'}}));
    await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    expect(JSON.stringify(r.toJSON())).toContain('Agent 正在执行任务');expect(done).not.toHaveBeenCalled();
    expect(r.root.findByProps({'aria-label':'CLI'}).props.value).toBe('codex');
    expect(button(r,'确认切换').props.disabled).toBe(false);
  });
  it('keeps local CLI rows flat with per-CLI menus for login and Bot CLI switching',async()=>{
    const fallback=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/local-agent')?{ok:true,json:async()=>({agents:[
      {agentType:'pi',revision:2,appliedRevision:2,authMethod:'api-key',modelName:'fixture',currentModel:null,status:'synced',credentialPresent:true},
      {agentType:'codex',revision:2,appliedRevision:2,authMethod:'oauth',modelName:null,currentModel:null,status:'synced',credentialPresent:true},
      {agentType:'zcode',revision:2,appliedRevision:2,authMethod:'api-key',modelName:'fixture',currentModel:null,status:'synced',credentialPresent:false},
    ],bots:[{appId:'cli_fixture',displayName:'Fixture',cliId:'codex'},{appId:'cli_other',displayName:'Other',cliId:'pi'}]})}:url.endsWith('/control-proxy')?{ok:true,json:async()=>({revision:1,appliedRevision:1,proxyProfileId:null})}:url.endsWith('/control-upgrade')?{ok:true,json:async()=>({currentImage:'dev-agent:fixture'})}:fallback(url,init));
    const r=await mount(React.createElement(LocalControlAgent,{models:[]}));
    expect(r.root.findAllByType('details')).toHaveLength(0);expect(r.root.findAllByType('tbody')[0].findAllByType('tr')).toHaveLength(3);
    // No standalone switch buttons beside the runtime heading anymore.
    expect(r.root.findAllByType('button').some(b=>b.children.join('')==='切换 CLI')).toBe(false);
    expect(r.root.findAllByType('table')).toHaveLength(1);
    const rows=r.root.findAllByType('tbody')[0].findAllByType('tr');
    // react-test-renderer has no outside-pointer dismissal; assert menus by name.
    const menuByName=(label:string)=>r.root.findAllByProps({role:'menu'}).find(menu=>menu.props['aria-label']===label)!.findAllByProps({role:'menuitem'}).map(b=>b.children.join(''));
    await act(async()=>rows[0].findByProps({'aria-label':'Pi 的操作',type:'button'}).props.onClick());
    expect(menuByName('Pi 的操作')).toEqual(['修改模型']);
    await act(async()=>rows[2].findByProps({'aria-label':'ZCode 的操作',type:'button'}).props.onClick());
    // API-key ZCode has no OAuth action until OAuth is selected.
    expect(menuByName('ZCode 的操作')).toEqual(['修改模型']);
    await act(async()=>r.root.findByProps({'aria-label':'Dev Agent 运行环境 的操作',type:'button'}).props.onClick());
    expect(menuByName('Dev Agent 运行环境 的操作')).toEqual(['修改配置','登录 CLI','镜像升级']);
    await act(async()=>r.root.findAllByProps({role:'menu'}).find(menu=>menu.props['aria-label']==='Dev Agent 运行环境 的操作')!.findAllByProps({role:'menuitem'}).find(item=>item.children.join('')==='修改配置')!.props.onClick());expect(r.root.findAllByType('dialog')).toHaveLength(1);
    expect(fetcher.mock.calls.every(([,init])=>init.method==='GET')).toBe(true);
  });
  it('allows local-browser OAuth with no workbench profile',async()=>{
    const fallback=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/local-agent/zcode/login')?{ok:true,json:async()=>({oauth:{state:'waiting',authorizationUrl:'https://chat.z.ai/authorize',callbackPort:3456}})}:url.endsWith('/local-agent')?{ok:true,json:async()=>({agents:[{agentType:'zcode',revision:2,appliedRevision:2,authMethod:'oauth',requiresLogin:true,modelName:null,currentModel:null,status:'synced',credentialPresent:false}],bots:[]})}:url.endsWith('/browser-profiles')?{ok:true,json:async()=>({profiles:[]})}:url.endsWith('/control-proxy')?{ok:true,json:async()=>({revision:1,appliedRevision:1,proxyProfileId:null})}:url.endsWith('/control-upgrade')?{ok:true,json:async()=>({currentImage:'dev-agent:fixture'})}:fallback(url,init));
    const r=await mount(React.createElement(LocalControlAgent,{models:[]}));
    await act(async()=>r.root.findByProps({'aria-label':'ZCode 的操作',type:'button'}).props.onClick());
    await act(async()=>r.root.findAllByProps({role:'menu'}).find(menu=>menu.props['aria-label']==='ZCode 的操作')!.findAllByProps({role:'menuitem'}).find(b=>b.children.join('')==='原生 OAuth 登录')!.props.onClick());
    expect(r.root.findAllByType('a')).toHaveLength(0);
    expect(JSON.stringify(r.toJSON())).not.toContain('官方登录页面');
    expect(JSON.stringify(r.toJSON())).toContain('统一登录工作台');
    await act(async()=>r.root.findByProps({'aria-label':'登录方式'}).props.onChange({target:{value:'local'}}));
    expect(button(r,'发起原生登录').props.disabled).toBeFalsy();
    expect(JSON.stringify(r.toJSON())).not.toContain('请先在 Agent 管理 → 登录工作台新建浏览器配置');
    await act(async()=>button(r,'发起原生登录').props.onClick());
    expect(JSON.parse(fetcher.mock.calls.find(([url])=>url.endsWith('/local-agent/zcode/login'))![1].body)).toEqual({action:'start',browserMode:'local'});
    await act(async()=>r.root.findByProps({'aria-label':'授权后的本地回调地址'}).props.onChange({target:{value:'http://localhost:3456/callback?code=fixture'}}));
    await act(async()=>button(r,'提交回调地址').props.onClick());
    expect(JSON.parse(fetcher.mock.calls.filter(([url])=>url.endsWith('/local-agent/zcode/login')).at(-1)![1].body)).toEqual({action:'callback',callback:'http://localhost:3456/callback?code=fixture'});
  });
  it.each(['claude-code','zcode'])('offers the same model choices locally and in a Dev instance for %s',async agentType=>{
    const fallback=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/local-agent')?{ok:true,json:async()=>({agents:[{agentType,revision:0,appliedRevision:0,authMethod:'api-key',modelProfileId:null,modelId:'',modelName:null,currentModel:null,status:'unmanaged',credentialPresent:false}],bots:[]})}:url.endsWith('/control-proxy')?{ok:true,json:async()=>({revision:1,appliedRevision:1,proxyProfileId:null})}:url.endsWith('/control-upgrade')?{ok:true,json:async()=>({currentImage:'dev-agent:fixture'})}:fallback(url,init));
    const options=[{profileId:'anthropic',displayName:'Anthropic',provider:'anthropic',modelId:'claude-fixture',modelIds:['claude-fixture'],protocol:'anthropic-messages',authMethod:'api-key',enabled:true,apiKeyConfigured:false},
      {profileId:'vercel',displayName:'Vercel',provider:'vercel',modelId:'',modelIds:[],protocol:'vercel-claude',authMethod:'api-key',enabled:true,apiKeyConfigured:true},
      {profileId:'zai',displayName:'Zai',provider:'zai',modelId:'',modelIds:[],protocol:'zcode-coding-plan',authMethod:'api-key',enabled:true,apiKeyConfigured:true}];
    const local=await mount(React.createElement(LocalControlAgent,{models:options}));
    const name=agentType==='zcode'?'ZCode':'Claude Code';
    await act(async()=>local.root.findByProps({'aria-label':`${name} 的操作`,type:'button'}).props.onClick());
    await act(async()=>local.root.findByProps({role:'menu','aria-label':`${name} 的操作`}).findAllByProps({role:'menuitem'})[0].props.onClick());
    const instance=await mount(React.createElement(CliConfigForm,{data:{...data,models:options,agents:[{id:agentType,name,protocols:agentType==='zcode'?['zcode-coding-plan']:['anthropic-messages','vercel-claude'],authMethods:['api-key','oauth']}]},container:current,cli:{agentType,revision:0,appliedRevision:0},onClose:()=>{},onDone:()=>{}} as any));
    const values=(select:TestRenderer.ReactTestInstance)=>select.findAllByType('option').slice(1).map(o=>[o.props.value,o.children.join('')]);
    const localSelect=local.root.findByProps({'aria-label':'本地认证 / 模型'}),instanceSelect=instance.root.findByProps({'aria-label':'登录方式 / 模型'});
    expect(values(localSelect)).toEqual(values(instanceSelect));
    if(agentType==='claude-code'){
      expect(values(localSelect).some(([value])=>value==='[null,null]')).toBe(false);
      expect(values(localSelect).find(([value])=>value===JSON.stringify(['vercel','']))?.[1]).toContain('Vercel Key');
    }else{
      await act(async()=>localSelect.props.onChange({target:{value:'[null,null]'}}));
      expect(local.root.findAllByProps({name:'oauthModelId'})).toHaveLength(0);
    }
  });
  it('retries a pending Codex OAuth sync with the original request and no old model reference',async()=>{
    const fallback=fetcher.getMockImplementation()!,requestId='00000000-0000-4000-8000-000000000001';
    fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/local-agent/codex')&&init?.method==='PUT'?{ok:true,json:async()=>({applied:true,revision:20,restartedBots:0})}:url.endsWith('/local-agent')?{ok:true,json:async()=>({agents:[{agentType:'codex',revision:20,appliedRevision:19,requestId,authMethod:'oauth',modelProfileId:null,modelId:'',status:'pending',requiresLogin:true,credentialPresent:true}],bots:[]})}:url.endsWith('/control-proxy')?{ok:true,json:async()=>({revision:1,appliedRevision:1,proxyProfileId:null})}:url.endsWith('/control-upgrade')?{ok:true,json:async()=>({currentImage:'dev-agent:fixture'})}:fallback(url,init));
    const r=await mount(React.createElement(LocalControlAgent,{models:[]}));
    await act(async()=>r.root.findByProps({'aria-label':'Codex 的操作',type:'button'}).props.onClick());
    await act(async()=>r.root.findByProps({role:'menu','aria-label':'Codex 的操作'}).findAllByProps({role:'menuitem'}).find(b=>b.children.join('')==='修改模型')!.props.onClick());
    await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    expect(JSON.parse(fetcher.mock.calls.find(([url])=>url.endsWith('/local-agent/codex'))![1].body)).toMatchObject({revision:20,requestId,authMethod:'oauth',modelProfileId:null,modelId:null});
  });
  it('creates a manual browser without model, Bot or login-session parameters',async()=>{
    const fallback=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/image-cache')?{ok:true,json:async()=>({images:[{id:'browser-image',tags:['login-workbench:test'],agents:['browser'],roles:['browser'],size:10}]})}:fallback(url,init));
    const done=vi.fn(),r=await mount(React.createElement(BrowserInstanceForm,{container:null,onClose:()=>{},onDone:done}));
    expect(r.root.findAllByProps({name:'modelSelection'})).toHaveLength(0);expect(r.root.findAllByProps({name:'botId'})).toHaveLength(0);
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['displayName','Frontend browser'];yield ['image','browser-image'];yield ['proxyProfileId',''];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    const call=fetcher.mock.calls.find(([url,init])=>url==='/api/platform/browsers'&&init.method==='POST')!;
    expect(JSON.parse(call[1].body)).toMatchObject({displayName:'Frontend browser',image:'browser-image',storageKind:'volume',proxyProfileId:null});expect(done).toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([url])=>url.includes('/login'))).toBe(false);
  });
  it('offers retained browser volumes and submits the selected source',async()=>{
    const fallback=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/browsers/retained-volumes')?{ok:true,json:async()=>({volumes:[{containerId:'old-browser',displayName:'Old Chrome',source:'browser-volume',engine:'chromium',createdAt:'2026-10-27T00:00:00Z'}]})}:url.endsWith('/image-cache')?{ok:true,json:async()=>({images:[{id:'browser-image',tags:['browser-runtime-chrome:test'],agents:['browser'],roles:['browser'],size:10}]})}:fallback(url,init));
    const r=await mount(React.createElement(BrowserInstanceForm,{container:null,onClose:()=>{},onDone:()=>{}}));
    const storage=r.root.findAllByType('select').find(s=>s.props.value==='volume')!;
    await act(async()=>storage.props.onChange({target:{value:'reuse'}}));
    expect(r.root.findByProps({name:'reuseFrom'}).findAllByType('option').map(o=>o.children.join('')).join(' ')).toContain('Old Chrome');
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['displayName','Restored'];yield ['image','browser-image'];yield ['reuseFrom','old-browser'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    const call=fetcher.mock.calls.find(([url,init])=>url==='/api/platform/browsers'&&init.method==='POST')!;
    expect(JSON.parse(call[1].body)).toMatchObject({storageKind:'volume',reuseFrom:'old-browser'});
  });
  it('does not load a Skill library or offer Skill assignment during Agent creation',async()=>{
    const r=await mount(React.createElement(ContainerForm,{data:data as any,container:null,onClose:()=>{},onDone:()=>{}}));
    expect(JSON.stringify(r.toJSON())).not.toContain('Skill 分配');
    expect(fetcher.mock.calls.some(([url])=>url==='/api/skills'||url==='/api/skill-packs'||url.includes('/skill-assignments'))).toBe(false);
  });
  it('uses left navigation, nests Bots under Agents and keeps workspaces only in configuration',async()=>{
    const r=await mount(React.createElement(AgentsManagement,{initial:'bots'}));
    const nav=r.root.findByProps({'aria-label':'Agent 管理分类'});
    expect(nav.findAllByType('a').map(a=>a.props.href)).toEqual(AGENT_SECTIONS.map(section=>`#/platform-agents?section=${section.id}`));
    expect(nav.findAllByProps({'aria-current':'page'})[0].props.href).toContain('section=bots');
    expect(nav.findAllByType('strong').map(node=>node.children.join(''))).not.toContain('工作区设置');
    expect(r.root.findAllByProps({className:'pm-management-panel'})).toHaveLength(1);
    expect(button(r,'新建 Bot')).toBeDefined();expect(button(r,'创建 Agent')).toBeUndefined();
    expect(fetcher.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
    const config=await mount(React.createElement(Configuration,{initial:'workspaces'}));
    expect(config.root.findByProps({'aria-label':'密钥与配置管理分类'}).findAllByType('a').map(a=>a.props.href)).toEqual(CONFIGURATION_SECTIONS.map(section=>`#/platform-configuration?section=${section.id}`));
    expect(config.root.findAllByType('dialog')).toHaveLength(0);expect(config.root.findByProps({name:'hostPathRoot'})).toBeDefined();
  });
  it('resolves deep-linked sections and ignores unknown sections',()=>{
    expect(managementSection(AGENT_SECTIONS,'instances','#/platform-agents?section=bots')).toBe('bots');
    expect(managementSection(CONFIGURATION_SECTIONS,'models','#/platform-configuration?section=workspaces')).toBe('workspaces');
    expect(managementSection(AGENT_SECTIONS,'instances','#/platform-agents?section=unknown')).toBe('instances');
  });
  it('renders only the requested Agent section and does not create login resources on entry',async()=>{
    const local=await mount(React.createElement(AgentsManagement,{initial:'local'}));
    expect(local.root.findAllByProps({className:'pm-local-control'})).toHaveLength(1);
    expect(local.root.findAllByProps({className:'pm-agent-table'})).toHaveLength(0);
    const instances=await mount(React.createElement(AgentsManagement));
    expect(instances.root.findAllByProps({className:'pm-local-control'})).toHaveLength(0);
    expect(instances.root.findAllByProps({className:'pm-agent-table'})).toHaveLength(1);
    const fallback=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/browser-profiles')?{ok:true,json:async()=>({profiles:[]})}:url.endsWith('/logins')?{ok:true,json:async()=>({logins:[]})}:fallback(url,init));
    const logins=await mount(React.createElement(AgentsManagement,{initial:'logins'}));
    expect(logins.root.findAllByType('dialog')).toHaveLength(0);expect(button(logins,'Worker 发起登录')).toBeDefined();
    expect(fetcher.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
  });
  it('filters Bot rows by search and binding status without writing data',async()=>{
    const r=await mount(React.createElement(ManagementPage,{page:'bots'}));
    await act(async()=>r.root.findByProps({'aria-label':'搜索机器人'}).props.onChange({target:{value:'not-found'}}));
    expect(r.root.findAllByType('tbody')[0].findAllByType('tr')).toHaveLength(0);
    await act(async()=>r.root.findByProps({'aria-label':'搜索机器人'}).props.onChange({target:{value:'cli_test'}}));
    expect(r.root.findAllByType('tbody')[0].findAllByType('tr')).toHaveLength(1);
    await act(async()=>r.root.findByProps({'aria-label':'机器人绑定状态'}).props.onChange({target:{value:'free'}}));
    expect(r.root.findAllByType('tbody')[0].findAllByType('tr')).toHaveLength(0);
    expect(fetcher.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
  });
  it('saves workspace settings inline without touching existing containers',async()=>{
    const r=await mount(React.createElement(WorkspacePage));
    await act(async()=>r.root.findByProps({name:'hostPathRoot'}).props.onChange({target:{value:'/tenant/new'}}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    const writes=fetcher.mock.calls.filter(([,init])=>init?.method!=='GET');
    expect(writes).toHaveLength(1);expect(writes[0][0]).toBe('/api/platform/workspaces');
    expect(JSON.parse(writes[0][1].body)).toEqual({hostPathRoot:'/tenant/new'});
  });
  it('restores a DB local binding only after confirmation and submits no model or credential fields',async()=>{
    fetcher.mockResolvedValue({ok:true,json:async()=>({applied:true})});const done=vi.fn();
    const r=await mount(React.createElement(BindLocalBot,{bot:{...data.bots[0],usage:'local',bindingRevision:3,localCliId:'codex',ownerConfigured:true} as any,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));expect(fetcher).not.toHaveBeenCalled();
    await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({bindingRevision:3,cliId:'codex',confirmRestart:true});expect(done).toHaveBeenCalled();
  });
  it('allows explicit release even when the native roster is missing, fenced by DB revision',async()=>{
    fetcher.mockResolvedValue({ok:true,json:async()=>({released:true})});
    const r=await mount(React.createElement(UnbindLocalBot,{bot:{...data.bots[0],usage:'local',bindingRevision:4} as any,onClose:()=>{},onDone:()=>{}}));
    await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({bindingRevision:4,confirmLocalStop:true});
  });
  it('deletes only a confirmed platform record and does not call Feishu app deletion',async()=>{
    fetcher.mockResolvedValue({ok:true,json:async()=>({deleted:true})});const done=vi.fn();
    const r=await mount(React.createElement(DeleteBot,{bot:data.bots[0] as any,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));expect(fetcher).not.toHaveBeenCalled();
    await act(async()=>r.root.findByProps({name:'confirmBotAppId'}).props.onChange({target:{value:'cli_test'}}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    expect(fetcher.mock.calls[0][0]).toBe('/api/platform/bots/cli_test');expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({confirmAppId:'cli_test'});expect(done).toHaveBeenCalled();
  });
  it('offers existing-Bot import and puts remote refresh in each Bot action menu',async()=>{
    const r=await mount(React.createElement(ManagementPage,{page:'bots'}));
    expect(button(r,'导入已有 Bot')).toBeDefined();expect(button(r,'新建 Bot')).toBeDefined();
    expect(button(r,'刷新飞书配置')).toBeUndefined();
    await act(async()=>r.root.findByProps({'aria-label':'Bot（cli_test） 的操作',type:'button'}).props.onClick());
    expect(r.root.findAllByProps({role:'menuitem'}).map(b=>b.children.join(''))).toEqual(['刷新飞书配置','摘除绑定','删除记录']);
    fetcher.mockImplementation(async(url:string,init?:any)=>{
      if(url.endsWith('/refresh'))return {ok:true,json:async()=>({refreshed:true,runtimeSynced:false,message:'名称已刷新，Agent 同步未确认'})};
      const path=url.replace('/api/platform','');return {ok:true,json:async()=>path==='/catalog'?{agents:[]}:path==='/workspaces'?workspaceOptions:{[path.slice(1)]:data[path.slice(1) as keyof typeof data]}};
    });
    await act(async()=>button(r,'刷新飞书配置').props.onClick());await act(async()=>{});
    expect(fetcher.mock.calls.some(([url,init])=>url==='/api/platform/bots/cli_test/refresh'&&init.method==='POST')).toBe(true);
    expect(JSON.stringify(r.toJSON())).toContain('Agent 同步未确认');
  });
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
    expect(JSON.parse(fetcher.mock.calls.find(([,init])=>init?.method==='POST')![1].body)).toMatchObject({authMethod:'oauth',modelProfileId:null,modelId:null,agentType:'codex'});expect(done).toHaveBeenCalled();
  });
  it('does not offer OAuth in the model management form',async()=>{
    const r=await mount(React.createElement(ModelForm,{model:null,onClose:()=>{},onDone:()=>{}}));
    expect(r.root.findAllByProps({name:'authMethod'})).toHaveLength(0);
    expect(r.root.findAllByType('option').some(o=>o.props.value==='oauth')).toBe(false);
  });
  it('opens login workbench without creating credentials, a browser or storage until explicitly requested',async()=>{
    fetcher.mockImplementation(async(url:string)=>({ok:true,json:async()=>url.endsWith('/browser-profiles')?{profiles:[]}:url.endsWith('/containers')?{containers:[]}:{logins:[]}}));
    const r=await mount(React.createElement(LoginWorkbench,{container:null,containers:[],onClose:()=>{}}));
    expect(button(r,'Worker 发起登录').props.disabled).toBe(true);
    await act(async()=>button(r,'新建浏览器配置').props.onClick());
    expect(button(r,'保存浏览器配置').props.disabled).toBe(true);
    expect(fetcher.mock.calls.every(([,init])=>init.method==='GET')).toBe(true);
    expect(JSON.stringify(r.toJSON())).toContain('凭据只保留该 Worker');
  });
  it('edits the selected browser profile proxy instead of deployment environment',async()=>{
    const profile={profileId:'11111111-1111-4111-8111-111111111111',displayName:'SSO',storageKind:'volume',storageSource:'agent-browser-profile-11111111-1111-4111-8111-111111111111',proxyProfileId:null,revision:1};
    fetcher.mockImplementation(async(url:string,init?:any)=>{
      if(url.endsWith('/browser-profiles')&&(!init||init.method==='GET'))return {ok:true,json:async()=>({profiles:[profile]})};
      if(url.endsWith('/logins'))return {ok:true,json:async()=>({logins:[]})};
      if(url.endsWith('/containers'))return {ok:true,json:async()=>({containers:[]})};
      if(url.includes('/browser-profiles/')&&init?.method==='PUT')return {ok:true,json:async()=>({profile:{...profile,proxyProfileId:'vpn',revision:2}})};
      return {ok:true,json:async()=>({})};
    });
    const r=await mount(React.createElement(LoginWorkbench,{container:null,containers:[],onClose:()=>{}}));
    await act(async()=>r.root.findAllByType('select').find(s=>s.findAllByType('option').some(o=>o.props.value===profile.profileId))!.props.onChange({target:{value:profile.profileId}}));
    const proxy=r.root.findByProps({name:'proxyProfileId'});
    await act(async()=>proxy.props.onChange({target:{value:'vpn'}}));
    await act(async()=>button(r,'保存并同步').props.onClick());
    expect(fetcher.mock.calls.some(([url,init])=>url===`/api/platform/browser-profiles/${profile.profileId}`&&init.method==='PUT'&&JSON.parse(init.body).proxyProfileId==='vpn')).toBe(true);
  });
  it('keeps Vercel Claude API-key connections available in the native login workbench',async()=>{
    const claude={...current,displayName:'Claude',agentType:'claude-code',runtimeKind:'native-botmux',authMethod:'api-key',requiresLogin:true,revision:3,appliedRevision:3};
    const fallback=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/containers')?{ok:true,json:async()=>({containers:[claude]})}:url.endsWith('/browser-profiles')?{ok:true,json:async()=>({profiles:[]})}:url.endsWith('/logins')?{ok:true,json:async()=>({logins:[]})}:fallback(url,init));
    const r=await mount(React.createElement(ManagementPage,{page:'agents'}));
    await act(async()=>r.root.findByProps({'aria-label':'Claude 的操作',type:'button'}).props.onClick());
    await act(async()=>button(r,'Claude 订阅登录').props.onClick());
    expect(r.root.findByType(LoginWorkbench).props.containers).toContainEqual(claude);
    expect(r.root.findByProps({'aria-label':'登录目标 Agent 或 CLI'}).findAllByType('option').map(o=>o.props.value)).toContain(`${claude.containerId}:claude-code`);
  });
  it('refreshes the target revision before login and never sends an undefined revision for Vercel Claude',async()=>{
    const claude={...current,agentType:'claude-code',authMethod:'api-key',requiresLogin:true};
    let revision=3;
    fetcher.mockImplementation(async(url:string,init?:any)=>({ok:true,json:async()=>url.endsWith('/containers')?{containers:[{...claude,revision,appliedRevision:revision}]}:url.endsWith('/browser-profiles')?{profiles:[{profileId:'profile-1',displayName:'Browser',storageKind:'volume',revision:1}]}:url.endsWith('/login')?{loginId:'login-1',containerId:claude.containerId,state:'starting'}:{logins:[]}}));
    const r=await mount(React.createElement(LoginWorkbench,{container:claude,containers:[claude],onClose:()=>{}}));
    await act(async()=>r.root.findAllByType('select').find(s=>s.findAllByType('option').some(o=>o.props.value==='profile-1'))!.props.onChange({target:{value:'profile-1'}}));
    revision=4;
    await act(async()=>button(r,'Worker 发起登录').props.onClick());
    const request=fetcher.mock.calls.find(([url,init])=>url===`/api/platform/containers/${claude.containerId}/login`&&init.method==='POST');
    expect(JSON.parse(request![1].body)).toEqual({revision:4,profileId:'profile-1',agentType:'claude-code',browserMode:'workbench'});
  });
  it('local browser mode starts without a profile and shows the authorization link',async()=>{
    const claude={...current,agentType:'claude-code',authMethod:'api-key',requiresLogin:true,imageAgents:['pi','claude-code']};
    fetcher.mockImplementation(async(url:string,init?:any)=>({ok:true,json:async()=>url.endsWith('/containers')?{containers:[claude]}
      :url.includes('/clis')?{clis:[{agentType:'claude-code',active:true,configured:true,authMethod:'api-key',modelProtocol:'vercel-claude',revision:7,appliedRevision:7}]}
      :url.endsWith('/browser-profiles')?{profiles:[]}
      :url.endsWith('/login')?{loginId:'login-local',containerId:claude.containerId,agentType:'claude-code',browserMode:'local',state:'waiting',authorizationUrl:'https://claude.ai/oauth/authorize?state=fixture'}
      :{logins:[{loginId:'login-local',containerId:claude.containerId,agentType:'claude-code',browserMode:'local',profileId:null,state:'waiting',workerState:'waiting',expiresAt:new Date(Date.now()+600000).toISOString()}]}}));
    const r=await mount(React.createElement(LoginWorkbench,{container:claude,containers:[claude],onClose:()=>{}}));
    await act(async()=>{r.root.findByProps({'aria-label':'登录方式'}).props.onChange({target:{value:'local'}});});
    await act(async()=>{await button(r,'Worker 发起登录').props.onClick();});
    const post=fetcher.mock.calls.find(([url,init])=>String(url).endsWith('/login')&&(init as any).method==='POST');
    const body=JSON.parse((post![1] as any).body);
    expect(body).toMatchObject({revision:7,agentType:'claude-code',browserMode:'local'});
    expect(body.profileId).toBeUndefined();
    const link=r.root.findAllByType('a').find(a=>a.props.href?.startsWith('https://claude.ai/'));
    expect(link).toBeDefined();
  });
  it('does not start native login when the refreshed target has disappeared',async()=>{
    const claude={...current,agentType:'claude-code',authMethod:'api-key',requiresLogin:true};let removed=false;
    fetcher.mockImplementation(async(url:string)=>({ok:true,json:async()=>url.endsWith('/containers')?{containers:removed?[]:[claude]}:url.endsWith('/browser-profiles')?{profiles:[{profileId:'profile-1',displayName:'Browser',storageKind:'volume',revision:1}]}:{logins:[]}}));
    const r=await mount(React.createElement(LoginWorkbench,{container:claude,containers:[claude],onClose:()=>{}}));
    await act(async()=>r.root.findAllByType('select').find(s=>s.findAllByType('option').some(o=>o.props.value==='profile-1'))!.props.onChange({target:{value:'profile-1'}}));
    removed=true;
    await act(async()=>button(r,'Worker 发起登录').props.onClick());
    expect(fetcher.mock.calls.some(([url])=>url.endsWith('/login'))).toBe(false);
    expect(JSON.stringify(r.toJSON())).toContain('目标 Agent 不存在');
  });
  it('lists per-CLI login targets for multi-CLI instances and posts the CLI revision',async()=>{
    const dev={...current,agentType:'pi',runtimeKind:'native-botmux',imageAgents:['pi','codex','claude-code','zcode'],requiresLogin:false,authMethod:'api-key'};
    const fetchCalls:unknown[][]=[];
    fetcher.mockImplementation(async(url:string,init?:any)=>{fetchCalls.push([url,init]);return {ok:true,json:async()=>url.endsWith('/containers')?{containers:[dev]}
      :url.includes('/clis')?{clis:[{agentType:'pi',active:true,configured:true,authMethod:'api-key',revision:5,appliedRevision:5},{agentType:'codex',active:false,configured:true,authMethod:'oauth',revision:2,appliedRevision:2}]}
      :url.endsWith('/browser-profiles')?{profiles:[{profileId:'profile-1',displayName:'Browser',storageKind:'volume',revision:1}]}
      :url.endsWith('/login')?{loginId:'login-2',containerId:dev.containerId,agentType:'codex',state:'starting'}:{logins:[]}};});
    const r=await mount(React.createElement(LoginWorkbench,{container:dev,containers:[dev],onClose:()=>{}}));
    await act(async()=>r.root.findAllByType('select').find(s=>s.findAllByType('option').some(o=>o.props.value==='profile-1'))!.props.onChange({target:{value:'profile-1'}}));
    const target=r.root.findByProps({'aria-label':'登录目标 Agent 或 CLI'});
    expect(target.findAllByType('option').map(o=>o.props.value)).toEqual(['',`${dev.containerId}:codex`]);
    await act(async()=>target.props.onChange({target:{value:`${dev.containerId}:codex`}}));
    await act(async()=>button(r,'Worker 发起登录').props.onClick());
    const post=fetcher.mock.calls.find(([url,init])=>url===`/api/platform/containers/${dev.containerId}/login`&&init.method==='POST');
    expect(JSON.parse(post![1].body)).toEqual({revision:2,profileId:'profile-1',agentType:'codex',browserMode:'workbench'});
  });
  it('retains the saved proxy while options load asynchronously and allows an explicit direct selection',async()=>{
    let resolve!:(result:any)=>void;fetcher.mockImplementation(()=>new Promise(r=>{resolve=r;}));
    const r=await mount(React.createElement(ProxySelect,{defaultValue:'us-global'}));
    expect(r.root.findByType('select').props.value).toBe('us-global');
    expect(r.root.findAllByType('option').find(o=>o.props.value==='us-global')?.children.join('')).toContain('正在加载代理配置');
    await act(async()=>resolve({ok:true,json:async()=>({proxies:[{profileId:'us-global',displayName:'US',enabled:true,revision:3,configuration:{mode:'global'}}]})}));
    expect(r.root.findByType('select').props.value).toBe('us-global');
    expect(r.root.findByType('select').props.defaultValue).toBeUndefined();
    await act(async()=>r.root.findByType('select').props.onChange({target:{value:''}}));
    expect(r.root.findByType('select').props.value).toBe('');
  });
  it('groups Agent choices by connection and expands every configured model',async()=>{
    const r=await mount(React.createElement(ContainerForm,{data:{...data,models:[{...models[0],modelIds:['model-1','model-2']}]} as any,container:current,onClose:()=>{},onDone:()=>{}}));
    const select=r.root.findByProps({name:'modelSelection'});
    expect(select.props.value).toBe(JSON.stringify(['old','model-1']));
    expect(select.findByType('optgroup').findAllByType('option').map(o=>JSON.parse(o.props.value))).toEqual([['old','model-1'],['old','model-2']]);
  });
  it('saves multiple IDs without sending an empty replacement key and keeps a clone disabled',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(ModelForm,{model:{...models[0],enabled:false},onClose:()=>{},onDone:done}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['profileId','old'];yield ['displayName','Copy'];yield ['provider','test'];yield ['modelIds',' a\n b\na\n'];yield ['apiKey',''];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    const payload=JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload).toMatchObject({modelIds:['a','b'],modelId:'a',enabled:false});expect(payload).not.toHaveProperty('apiKey');expect(done).toHaveBeenCalled();
  });
  it('edits and submits per-model modalities, token limits and reasoning levels',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(ModelForm,{model:{...models[0],modelId:'vision',modelIds:['vision'],
      modelCapabilities:[{modelId:'vision',inputModalities:['text'],contextWindow:128000,maxTokens:8192,reasoningLevels:['low','medium'],defaultReasoningLevel:'medium'}]} as any,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByProps({'aria-label':'vision image 模态'}).props.onChange({target:{checked:true}}));
    await act(async()=>r.root.findByProps({'aria-label':'vision 上下文窗口'}).props.onChange({target:{value:'256000'}}));
    await act(async()=>r.root.findByProps({'aria-label':'vision 最大输出 Token'}).props.onChange({target:{value:'32000'}}));
    await act(async()=>r.root.findByProps({'aria-label':'vision high 思考级别'}).props.onChange({target:{checked:true}}));
    await act(async()=>r.root.findByProps({'aria-label':'vision 默认思考级别'}).props.onChange({target:{value:'high'}}));
    await act(async()=>r.root.findByProps({'aria-label':'vision 支持推理摘要'}).props.onChange({target:{checked:true}}));
    await act(async()=>r.root.findByProps({'aria-label':'vision 默认推理摘要'}).props.onChange({target:{value:'detailed'}}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['profileId','old'];yield ['displayName','Vision'];yield ['provider','test'];yield ['modelIds','vision'];yield ['enabled','on'];yield ['apiKey',''];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    const payload=JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload.modelCapabilities).toEqual([{modelId:'vision',inputModalities:['text','image'],contextWindow:256000,maxTokens:32000,
      reasoningLevels:['low','medium','high'],defaultReasoningLevel:'high',supportsReasoningSummaries:true,
      defaultReasoningSummary:'detailed'}]);expect(done).toHaveBeenCalled();
  });
  it('keeps Pi capabilities optional and collapsed for an Anthropic model connection',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(ModelForm,{model:{...models[0],protocol:'anthropic-messages',modelId:'chosen',modelIds:['chosen']} as any,onClose:()=>{},onDone:done}));
    const advanced=r.root.findAllByType('details').find(d=>d.findAllByType('summary').some(s=>s.children.join('').includes('Claude 无需填写')))!;
    expect(advanced.props.open).toBe(false);
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['profileId','old'];yield ['displayName','Claude'];yield ['provider','test'];yield ['modelIds','chosen'];yield ['enabled','on'];yield ['apiKey',''];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({protocol:'anthropic-messages',modelIds:['chosen']});expect(done).toHaveBeenCalled();
  });
  it('saves the main model and independent Claude aliases',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(ModelForm,{model:{...models[0],protocol:'anthropic-messages',modelId:'main',modelIds:['main','fast','large','agent']} as any,onClose:()=>{},onDone:done}));
    for(const [label,value] of [['Claude 默认主模型','large'],['Claude Haiku 模型','fast'],['Claude Sonnet 模型','large'],['Claude 子 Agent 模型','agent']])
      await act(async()=>r.root.findByProps({'aria-label':label}).props.onChange({target:{value}}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['profileId','old'];yield ['displayName','Claude'];yield ['provider','test'];yield ['modelIds','main\nfast\nlarge\nagent'];yield ['enabled','on'];yield ['apiKey',''];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(JSON.parse(fetcher.mock.calls.find(([,init])=>init?.method==='PUT')![1].body)).toMatchObject({modelId:'large',claudeModelRouting:{haiku:'fast',sonnet:'large',subagent:'agent'}});
    expect(done).toHaveBeenCalled();
  });
  it('omits empty Claude routing when cloning for compatibility with older control planes',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(ModelForm,{model:{...models[0],protocol:'anthropic-messages',modelId:'chosen',modelIds:['chosen']} as any,cloneSourceId:'old',onClose:()=>{},onDone:done}));
    fetcher.mockImplementation(async(_url:string,init:any)=>{const payload=JSON.parse(init.body);return {ok:!('claudeModelRouting' in payload),json:async()=>({message:'克隆包含不支持的配置字段'})};});
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['profileId','copy'];yield ['displayName','Copy'];yield ['modelIds','chosen'];yield ['enabled','on'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty('claudeModelRouting');expect(done).toHaveBeenCalled();
  });
  it('sends an explicit empty routing when clearing previously saved Claude aliases',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(ModelForm,{model:{...models[0],protocol:'anthropic-messages',modelId:'main',modelIds:['main','fast'],claudeModelRouting:{haiku:'fast'}} as any,cloneSourceId:'old',onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByProps({'aria-label':'Claude Haiku 模型'}).props.onChange({target:{value:''}}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['profileId','copy'];yield ['displayName','Copy'];yield ['modelIds','main\nfast'];yield ['enabled','on'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(JSON.parse(fetcher.mock.calls.find(([,init])=>init?.method==='POST')![1].body).claudeModelRouting).toEqual({});expect(done).toHaveBeenCalled();
  });
  it('refuses to save independently configured Claude models on an older control plane',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(ModelForm,{model:{...models[0],protocol:'anthropic-messages',modelId:'main',modelIds:['main','fast']} as any,cloneSourceId:'old',onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByProps({'aria-label':'Claude Haiku 模型'}).props.onChange({target:{value:'fast'}}));
    fetcher.mockResolvedValue({ok:true,json:async()=>({models:[]})});
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['profileId','copy'];yield ['displayName','Copy'];yield ['modelIds','main\nfast'];yield ['enabled','on'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(fetcher.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
    expect(JSON.stringify(r.toJSON())).toContain('请先升级控制面');expect(done).not.toHaveBeenCalled();
  });
  it('cleans protocol-specific fields on switch and restores each draft on return',async()=>{
    const r=await mount(React.createElement(ModelForm,{model:{...models[0],protocol:'anthropic-messages',modelId:'main',modelIds:['main','fast'],claudeModelRouting:{haiku:'fast'}} as any,cloneSourceId:'old',onClose:()=>{},onDone:()=>{}}));
    await act(async()=>r.root.findByProps({name:'protocol'}).props.onChange({target:{value:'zcode-coding-plan'}}));
    expect(r.root.findAllByProps({name:'modelIds'})).toHaveLength(0);
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['profileId','copy'];yield ['displayName','Copy'];yield ['enabled','on'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    const payload=JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload).toMatchObject({protocol:'zcode-coding-plan',provider:'zai',baseUrl:'https://api.z.ai',modelId:'',modelIds:[],modelCapabilities:[]});
    expect(payload).not.toHaveProperty('claudeModelRouting');
    await act(async()=>r.root.findByProps({name:'protocol'}).props.onChange({target:{value:'anthropic-messages'}}));
    expect(r.root.findByProps({name:'modelIds'}).props.value).toBe('main\nfast');
    expect(r.root.findByProps({name:'baseUrl'}).props.value).toBe('https://example.com/v1');
    expect(r.root.findByProps({'aria-label':'Claude Haiku 模型'}).props.value).toBe('fast');
    await act(async()=>r.root.findByProps({name:'protocol'}).props.onChange({target:{value:'openai-responses'}}));
    await act(async()=>r.root.findByProps({name:'modelIds'}).props.onChange({target:{value:'different'}}));
    await act(async()=>r.root.findByProps({name:'protocol'}).props.onChange({target:{value:'anthropic-messages'}}));
    expect(r.root.findByProps({name:'modelIds'}).props.value).toBe('main\nfast');
    expect(r.root.findByProps({'aria-label':'Claude Haiku 模型'}).props.value).toBe('fast');
    await act(async()=>r.root.findByProps({name:'protocol'}).props.onChange({target:{value:'openai-responses'}}));
    expect(r.root.findByProps({name:'modelIds'}).props.value).toBe('different');
  });
  it('creates an Anthropic connection without manually entering a Pi provider or capabilities',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(ModelForm,{model:null,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByProps({name:'protocol'}).props.onChange({target:{value:'anthropic-messages'}}));
    await act(async()=>r.root.findByProps({name:'baseUrl'}).props.onChange({target:{value:'https://gateway.example'}}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['profileId','claude-gateway'];yield ['displayName','Gateway'];yield ['modelIds','chosen'];yield ['enabled','on'];yield ['apiKey','fixture-key'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({provider:'claude-gateway',protocol:'anthropic-messages',baseUrl:'https://gateway.example',modelIds:['chosen']});expect(done).toHaveBeenCalled();
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
    const r=await mount(React.createElement(WorkspaceSettings,{options:{...workspaceOptions,hostPathMode:'unrestricted'} as any,onClose:()=>{},onDone:()=>{}}));expect(JSON.stringify(r.toJSON())).toContain('hostPath 范围');expect(r.root.findAllByProps({className:'pm-approved-roots'})).toHaveLength(0);
  });
  it('shows model connections without Agent creation controls',async()=>{
    const r=await mount(React.createElement(ManagementPage,{page:'models'}));expect(r.root.findByType('h1').children).toEqual(['模型管理']);expect(button(r,'添加模型连接')).toBeDefined();expect(button(r,'创建 Agent')).toBeUndefined();
  });
  it('keeps unchanged bindings on the configuration helper and reports runtime ACK',async()=>{
 const api=vi.fn(async()=>({container:{...current,revision:2,appliedRevision:2}}));expect(await syncAgentConfiguration(api,current,'old','bot-1','model-1')).toMatchObject({appliedRevision:2});expect(api.mock.calls[0][2]).not.toHaveProperty('botId');
 });
 it('does not report success on a configuration failure',async()=>{const api=vi.fn(async()=>{throw Error('Agent 正在执行任务');});await expect(syncAgentConfiguration(api,current,'old')).rejects.toThrow('正在执行任务');});
  it('saves a newly selected model through the runtime sync path',async()=>{
    const done=vi.fn();const r=await mount(React.createElement(ContainerForm,{data:data as any,container:current,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByProps({name:'modelSelection'}).props.onChange({target:{value:JSON.stringify(['new','new'])}}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['modelSelection',JSON.stringify(['new','new'])];yield ['botId','bot-1'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(done).toHaveBeenCalledWith(expect.stringContaining('已同步'));
    expect(JSON.parse(fetcher.mock.calls.find(([,init])=>init?.method==='PUT')![1].body)).toEqual({revision:1,modelProfileId:'new',authMethod:'api-key',modelId:'new',proxyProfileId:null});
  });
  it('does not hide compatible model endpoints for an unrestricted Agent',async()=>{
    const r=await mount(React.createElement(ContainerForm,{data:{...data,models:[{...models[1],baseUrl:'https://new-endpoint.example/v1'}]} as any,container:{...current,networkMode:'unrestricted',egressHosts:[]},onClose:()=>{},onDone:()=>{}}));
    expect(JSON.stringify(r.toJSON())).toContain('不使用 Proxy · 直连');
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
    await act(async()=>r.root.findByProps({name:'modelSelection'}).props.onChange({target:{value:JSON.stringify(['old','old'])}}));
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
    await act(async()=>r.root.findByProps({name:'modelSelection'}).props.onChange({target:{value:JSON.stringify(['old','old'])}}));
    await act(async()=>r.root.findByProps({'aria-label':'数据卷'}).props.onChange({target:{value:'old-workspace'}}));
    await act(async()=>r.root.findByProps({'aria-label':'工作区类型'}).props.onChange({target:{value:'hostpath'}}));
    vi.stubGlobal('FormData',class{*[Symbol.iterator](){yield ['modelSelection',JSON.stringify(['old','old'])];yield ['workspaceSource','/chosen/path'];yield ['hostPathConfirmed','on'];}});
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toMatchObject({workspace:'hostpath',workspaceSource:'/chosen/path',workspaceReadOnly:true,hostPathConfirmed:true});
    await act(async()=>r.root.findByProps({'aria-label':'工作区类型'}).props.onChange({target:{value:'volume'}}));
    expect(r.root.findByProps({'aria-label':'数据卷'}).props.value).toBe('old-workspace');expect(r.root.findAllByProps({name:'hostPathConfirmed'})).toHaveLength(0);
  });
  it('shows capability rows without folding them, expands only image versions and keeps instance actions in a menu',async()=>{
    const r=await mount(React.createElement(ManagementPage,{page:'agents'}));
    expect(r.root.findAllByType('details')).toHaveLength(0);
    const imageToggle=r.root.findByProps({className:'pm-image-toggle'});expect(imageToggle.props['aria-expanded']).toBe(false);
    await act(async()=>imageToggle.props.onClick());expect(r.root.findByProps({className:'pm-image-toggle'}).props['aria-expanded']).toBe(true);
    expect(r.root.findAllByProps({'data-tip':'pi · pi:test'})).toHaveLength(1);expect(button(r,'删除')).toBeUndefined();
    await act(async()=>r.root.findByProps({'aria-label':'Agent One 的操作',type:'button'}).props.onClick());
    expect(r.root.findAllByProps({role:'menuitem'})).toHaveLength(4);expect(button(r,'登录 CLI')).toBeDefined();
    await act(async()=>button(r,'修改配置').props.onClick());expect(r.root.findAllByProps({role:'menu'})).toHaveLength(0);
    expect(r.root.findAll(node=>typeof node.props['data-tip']==='string').length).toBeGreaterThan(0);
  });
  it('offers workspace settings without changing existing mounts and submits only the default path',async()=>{
    const done=vi.fn(),r=await mount(React.createElement(WorkspaceSettings,{options:workspaceOptions as any,onClose:()=>{},onDone:done}));
    await act(async()=>r.root.findByProps({name:'hostPathRoot'}).props.onChange({target:{value:'/tenant/home/other'}}));
    await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
    expect(fetcher.mock.calls[0][0]).toBe('/api/platform/workspaces');expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({hostPathRoot:'/tenant/home/other'});expect(done).toHaveBeenCalled();
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
it('shows failed runtime health instead of ready configuration as available',async()=>{
 const fallback=fetcher.getMockImplementation()!;
 fetcher.mockImplementation(async(url:string,init?:any)=>url.endsWith('/containers')&&(!init||init.method==='GET')?{ok:true,json:async()=>({containers:[{...current,runtimeHealth:'unhealthy',lastError:'Worker service recovery pending'}]})}:fallback(url,init));
 let r:TestRenderer.ReactTestRenderer;await act(async()=>{r=TestRenderer.create(React.createElement(ManagementPage,{page:'agents'}));});renderers.push(r!);
 expect(JSON.stringify(r!.toJSON())).toContain('服务恢复未确认');
});
