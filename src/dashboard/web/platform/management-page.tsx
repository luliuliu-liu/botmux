import {ConfigureAgent} from './configure-agent.js';
import {McpSelection} from './mcp.js';
import {HostMountSettings,HostMountSelection,type NamedMount} from './host-mounts.js';
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { mountReactPage } from '../react-mount.js';
import { ui } from '../ui.js';
import { CreateActionButton, RefreshIconButton } from '../dashboard-components.js';
import { FeishuSessionPanel } from './feishu-session-panel.js';
import { PlatformBotCreate } from './bot-create.js';
import { PlatformBotImport } from './bot-import.js';
import { syncAgentConfiguration,saveCliConfiguration,activateCliConfiguration,syncInstanceBinding,type CliConfigurationRecord } from './agent-configuration.js';
import {CliSwitchFields} from './cli-switch-fields.js';
import { AgentActions, CompactText, Parameter, PlatformSwitch,ConfigHelp,collectModalHelp} from './compact-controls.js';
import { hostFirst, imageOptionLabel } from './image-utils.js';
import {LoginWorkbench} from './worker-access.js';
import {ImageUpgrade} from './image-upgrade.js';
import {ProxySelect} from './proxies.js';
import {LocalControlAgent} from './local-control-agent.js';
import {ImageCatalog,type CachedImage} from './image-catalog.js';
import {BrowserInstanceForm,DeleteBrowserInstance} from './browser-instances.js';
import {cachedManagementGet,clearManagementCache} from './management-cache.js';
import {CliLoginDialog} from './cli-logins.js';
import {configuredModelSelection,dynamicModel,idsOf,normalizeModelSelection,modelSelectionForCreate} from './model-options.js';
import {ModelAuthSelector} from './model-auth-selector.js';
import {newPlatformRequestId} from './request-id.js';

type Bot={botId:string;displayName:string;appId:string;usage:'local'|'free'|'sandbox';localRevision?:string;localDetachPending?:boolean;localConfigured?:boolean;localOwned?:boolean;localState?:string;bindingRevision?:number;localCliId?:string;ownerConfigured?:boolean;containerId?:string;containerName?:string;containerRevision?:number;containerStatus?:string;detachPending?:boolean;secretConfigured:boolean};
type ModelCapability={modelId:string;inputModalities:Array<'text'|'image'>;contextWindow:number;maxTokens:number;reasoningLevels:string[];defaultReasoningLevel:string|null;
  supportsReasoningSummaries:boolean;defaultReasoningSummary:'none'|'auto'|'concise'|'detailed'};
type ClaudeModelRouting={haiku?:string;sonnet?:string;opus?:string;subagent?:string};
type Model={profileId:string;displayName:string;provider:string;baseUrl:string;modelId:string;modelIds?:string[];modelCapabilities?:ModelCapability[];claudeModelRouting?:ClaudeModelRouting;apiKeyConfigured:boolean;enabled:boolean;protocol?:string;authMethod?:string;revision?:number};
const reasoningLevels=['low','medium','high','xhigh','max','ultra'];
const defaultCapability=(modelId:string):ModelCapability=>({modelId,inputModalities:['text'],contextWindow:128000,maxTokens:8192,
  reasoningLevels:['low','medium','high','xhigh'],defaultReasoningLevel:'medium',
  supportsReasoningSummaries:false,defaultReasoningSummary:'none'});
const capabilitiesOf=(model:Model)=>dynamicModel(model)?[]:idsOf(model).map(modelId=>model.modelCapabilities?.find(item=>item.modelId===modelId)||defaultCapability(modelId));
export type Container={runtimeHealth?:'unknown'|'healthy'|'unhealthy';runtimeHealthCheckedAt?:string|null;hostMounts?:NamedMount[];hostMountLayout?:string;containerId:string;displayName:string;agentType:string;image:string;imageLabel?:string;imageAgents?:string[];sandboxId:string|null;authMethod?:string;modelProfileId:string|null;modelName:string;modelId:string|null;
  cpu?:number;memoryMiB?:number;globalReadOnlyHostPath?:string|null;previousImage?:string|null;upgradeState?:string|null;pendingAgentType?:string|null;requiresLogin?:boolean;proxyProfileId?:string|null;status:string;revision:number;appliedRevision:number;botId:string|null;botName:string|null;poolId:string|null;poolMemberId:string|null;workspaceClaim:string;workspaceKind?:string;workspaceReadOnly?:boolean;detachPending?:boolean;stateClaim:string;lastError:string|null;runtimeKind?:string;createdAt?:string};
type Agent={id:string;name:string;supported:boolean;version:string|null;protocols?:string[];authMethods?:string[];images:Array<{id:string;image:string;label:string}>};
type WorkspaceOptions={hostPathRoot?:string|null;globalReadOnlyMounts?:NamedMount[];globalReadOnlyHostPath?:string|null;hostPathEnabled:boolean;hostPathMode?:'unrestricted'|'restricted';tenantHome?:string|null;defaultHostPath?:string|null;hostRoots:string[];workspaces:Array<{kind:'volume'|'hostpath';source:string;readOnly:boolean;useCount:number;shared?:boolean}>};
type Data={bots:Bot[];models:Model[];containers:Container[];agents:Agent[];workspaceOptions?:WorkspaceOptions};
const initial:Data={bots:[],models:[],containers:[],agents:[]};
const labels:Record<string,string>={creating:'配置中',ready:'就绪',error:'异常',deleting:'删除待确认',deleted:'已删除'};
const loginStates:Record<string,string>={starting:'登录启动中',waiting:'等待浏览器授权',succeeded:'登录成功',failed:'登录未完成',cancelled:'已取消',closing:'关闭待确认',interrupted:'登录进程中断'};
export async function platformApi(path:string,method='GET',body?:unknown){
  const load=async()=>{const response=await fetch(`/api/platform${path}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();if(response.status===401)clearManagementCache();if(!response.ok)throw new Error(result.message||result.error||`HTTP ${response.status}`);return result;};
  if(method.toUpperCase()==='GET')return cachedManagementGet(path,load);
  clearManagementCache();try{return await load();}finally{clearManagementCache();}
}
export function Modal({title,children,onClose,busy=false}:{title:string;children:ReactNode;onClose:()=>void;busy?:boolean}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{ref.current?.showModal();},[]);
  const help=collectModalHelp(children);
  return <dialog ref={ref} className="pm-dialog" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}><header><h2>{title}{help.help?<ConfigHelp>{help.help}</ConfigHelp>:null}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="关闭">×</button></header>{help.content}</dialog>;
}
export function ManagementPage({page,embedded=false,agentSection='all'}:{page:'bots'|'models'|'agents';embedded?:boolean;agentSection?:string}){
  const [configureTarget,setConfigureTarget]=useState<Container|null>(null);
  const [data,setData]=useState<Data>(initial),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
  const [modal,setModal]=useState<'bot'|'import-bot'|'bind-local'|'delete-bot'|'container'|'browser'|'model'|'delete-model'|'delete'|'unbind'|'upgrade'|'logins'|'cli-login'|null>(null),[selected,setSelected]=useState<Container|null>(null),[model,setModel]=useState<Model|null>(null),[selectedBot,setSelectedBot]=useState<Bot|null>(null);
  const [query,setQuery]=useState(''),[botUsage,setBotUsage]=useState('all');
  const [instanceQuery,setInstanceQuery]=useState('');
  const [cloneSourceId,setCloneSourceId]=useState<string|null>(null);
  const [cliRows,setCliRows]=useState<Record<string,CliConfigurationRecord[]|null>>({});
  const [expandedIds,setExpandedIds]=useState<Record<string,boolean>>({});
  const [cliTarget,setCliTarget]=useState<{container:Container;cli:CliConfigurationRecord}|null>(null);
  const [switchTarget,setSwitchTarget]=useState<Container|null>(null);
  const [activateTarget,setActivateTarget]=useState<{container:Container;cli:CliConfigurationRecord}|null>(null);
  const [loginCli,setLoginCli]=useState<string|undefined>(undefined);
  const expandedRef=useRef<Set<string>>(new Set());
  const mounted=useRef(true);
  const [syncingId]=useState<string|null>(null);
  const refreshingBot=useRef(false),[refreshingBotId,setRefreshingBotId]=useState<string|null>(null);
  const clone=(source:Model)=>{
    setCloneSourceId(source.profileId);
    setModel({...source,profileId:`${source.profileId.slice(0,95)}-copy`,displayName:`${source.displayName.slice(0,190)} 副本`,enabled:false});
    setModal('model');setError('');setNotice('');
  };
  const loadClis=async(ids:string[])=>{await Promise.all(ids.map(async id=>{try{const result=await platformApi(`/containers/${id}/clis`);if(mounted.current)setCliRows(rows=>({...rows,[id]:result.clis??null}));}catch{if(mounted.current)setCliRows(rows=>({...rows,[id]:rows[id]??null}));}}));};
  const refresh=async()=>{
    try{
      // Resolve image capabilities before reading rows so Dev instances expose
      // their CLI list on the first render as well as subsequent refreshes.
      await platformApi('/image-cache').catch(()=>{});
      const [bots,models,containers,catalog,workspaces]=await Promise.all(['/bots','/models','/containers','/catalog','/workspaces'].map(p=>platformApi(p)));
      if(mounted.current){setData({bots:bots.bots,models:models.models.filter((m:Model)=>m.authMethod!=='oauth'),containers:containers.containers,agents:catalog.agents,workspaceOptions:workspaces});setError('');}
      }
    catch(error){if(mounted.current)setError(String(error instanceof Error?error.message:error));}
    finally{if(mounted.current)setLoading(false);}
    await loadClis([...expandedRef.current]);
  };
  const toggleClis=async(container:Container)=>{
    const next=new Set(expandedRef.current);
    if(next.has(container.containerId)){next.delete(container.containerId);setCliRows(rows=>Object.fromEntries(Object.entries(rows).filter(([id])=>id!==container.containerId)));}
    else{next.add(container.containerId);void loadClis([container.containerId]);}
    expandedRef.current=next;setExpandedIds(Object.fromEntries([...next].map(id=>[id,true])));
  };
  const finishCli=(message:string)=>{setCliTarget(null);setActivateTarget(null);setSwitchTarget(null);setNotice(message);void refresh();};
  useEffect(()=>{mounted.current=true;void refresh();const timer=setInterval(()=>void refresh(),10000);return()=>{mounted.current=false;clearInterval(timer);};},[]);
  const title=page==='bots'?'Bot 管理':page==='models'?'模型管理':'Agent 管理';
  const matches=(...values:string[])=>values.some(value=>value.toLowerCase().includes(query.trim().toLowerCase()));
  const visibleBots=data.bots.filter(bot=>(botUsage==='all'||(botUsage==='bound'?bot.usage!=='free':bot.usage==='free'))&&matches(bot.displayName,bot.appId));
  const visibleModels=data.models.filter(model=>matches(model.displayName,model.profileId,model.provider,...idsOf(model)));
  const finish=(message:string)=>{setModal(null);setNotice(message);void refresh();};
  const mutate=async(path:string,method:string,body?:unknown)=>{
    try{await platformApi(path,method,body);setNotice('操作完成');await refresh();}catch(error){setError(error instanceof Error?error.message:String(error));}
  };
  const openDashboard=async(container:Container)=>{
    const popup=window.open('about:blank','_blank');
    try{const result=await platformApi(`/${container.agentType==='browser'?'browsers':'containers'}/${container.containerId}/dashboard`,'POST',{});if(popup){popup.opener=null;popup.location.replace(result.url);}else setError('请允许弹出工作台窗口后重试');}
    catch(error){popup?.close();setError(error instanceof Error?error.message:String(error));}
  };
  const refreshBot=async(bot:Bot)=>{
    if(refreshingBot.current)return;refreshingBot.current=true;setRefreshingBotId(bot.appId);setError('');setNotice('');
    try{
      const result=await platformApi(`/bots/${encodeURIComponent(bot.appId)}/refresh`,'POST',{});
      if(result.refreshed!==true)throw new Error('刷新尚未确认，请重试。');
      await refresh();
      if(mounted.current){if(result.runtimeSynced===false)setError(result.message);else setNotice(result.message||'飞书配置已刷新。');}
    }catch(error){if(mounted.current)setError(error instanceof Error?error.message:String(error));}
    finally{refreshingBot.current=false;if(mounted.current)setRefreshingBotId(null);}
  };
  if(!ui.platformManaged)return <section className="page"><h1>平台管理未启用</h1><p>此部署保持原生 Botmux 模式。</p></section>;
  const heading=page==='bots'?'Bot 管理':page==='models'?'模型连接':agentSection==='local'?'本地 Agent':agentSection==='catalog'?'支持的 Agent':agentSection==='logins'?'登录工作台':'Agent 实例';
  return <section className={embedded?'pm-page':'page pm-page'}><div className="page-heading"><div>{!embedded?<><p className="eyebrow">管理</p><h1>{title}</h1></>:<><h2 className="pm-panel-title">{heading} <ConfigHelp>{page==='bots'?'统一管理飞书机器人，按需绑定到 Agent。':page==='models'?'一个连接可包含多个模型，共用地址与凭据。':agentSection==='local'?'配置本地 CLI 的模型、认证和运行环境。':agentSection==='catalog'?'查看各 Agent 的镜像、版本与认证能力。':agentSection==='logins'?'管理持久化浏览器配置与原生登录会话。':'创建、配置与维护隔离运行的 Worker。'}</ConfigHelp></h2></>}</div><div className="page-heading-actions">
    <RefreshIconButton label="刷新" busy={loading} onClick={()=>{clearManagementCache();window.dispatchEvent(new Event('platform-management-refresh'));void refresh();}}/>
    {page==='bots'?<button onClick={()=>setModal('import-bot')}>导入已有 Bot</button>:null}
    {page==='agents'&&['all','instances'].includes(agentSection)?<button onClick={()=>{setSelected(null);setModal('browser');}}>创建浏览器</button>:null}
    {page==='bots'?<CreateActionButton onClick={()=>setModal('bot')}>新建 Bot</CreateActionButton>:page==='agents'?(['all','instances'].includes(agentSection)?<CreateActionButton onClick={()=>{setSelected(null);setModal('container');}}>创建 Agent</CreateActionButton>:null):<CreateActionButton onClick={()=>{setModel(null);setCloneSourceId(null);setModal('model');}}>添加模型连接</CreateActionButton>}
  </div></div>
  {page==='bots'?<FeishuSessionPanel/>:null}
  {error?<p className="hint-warn" role="alert">{error}</p>:null}{notice?<p className="hint" role="status">{notice}</p>:null}
  {loading?<p>正在加载…</p>:page==='bots'?<>
    <div className="pm-bot-list-heading"><h2>机器人 <ConfigHelp>从当前账号导入或新建应用，绑定到目标 Agent；刷新名称不会重置密钥。</ConfigHelp></h2><span>{data.bots.length} 个机器人</span></div>

    <div className="pm-list-filters"><input type="search" aria-label="搜索机器人" placeholder="搜索名称或 App ID" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="机器人绑定状态" value={botUsage} onChange={e=>setBotUsage(e.target.value)}><option value="all">全部状态</option><option value="bound">已绑定</option><option value="free">空闲</option></select></div>
    <div className="pm-table-wrap"><table className="pm-summary-table"><thead><tr><th>名称</th><th>App ID</th><th>凭证</th><th>使用情况</th><th>操作</th></tr></thead><tbody>{visibleBots.map(bot=><tr key={bot.botId}><td><CompactText text={bot.displayName}/></td><td><CompactText text={bot.appId}/></td><td>{bot.secretConfigured?'已配置':'未配置'}</td><td>{bot.usage==='free'?<span className="pm-state">空闲</span>:bot.usage==='local'?(bot.localState==='missing'?'本地绑定待恢复':bot.localState==='pending'?'本地配置待同步':bot.localState==='other'?'其他 Control Agent':'本地 Botmux'):`Agent / ${bot.containerName}`}{bot.detachPending?<small className="hint-warn">摘除待同步，保留占用</small>:null}{bot.localDetachPending?<small className="hint-warn">本地解绑未完成，请重试</small>:null}{refreshingBotId===bot.appId?<small>刷新中…</small>:null}</td><td><AgentActions name={`${bot.displayName}（${bot.appId}）`} actions={[
      {label:'刷新飞书配置',disabled:refreshingBotId!==null,run:()=>void refreshBot(bot)},
      ...(bot.usage!=='sandbox'?[{label:bot.usage==='local'?'同步到本地 Botmux':'绑定本地 Botmux',disabled:bot.localOwned===false||!bot.secretConfigured,run:()=>{setSelectedBot(bot);setModal('bind-local');}}]:[]),
      ...(bot.usage==='sandbox'?[{label:'摘除绑定',disabled:bot.containerStatus!=='ready'||!bot.containerId,run:()=>{setSelectedBot(bot);setModal('unbind');}}]:[]),
      ...(bot.usage==='local'?[{label:bot.localDetachPending?'重试本地解绑':'解除本地绑定',disabled:bot.localOwned===false,run:()=>{setSelectedBot(bot);setModal('unbind');}}]:[]),
      {label:'删除记录',danger:true,disabled:bot.usage!=='free',run:()=>{setSelectedBot(bot);setModal('delete-bot');}},
    ]}/>{bot.detachPending?<a href="#/platform-agents">重试同步</a>:null}</td></tr>)}</tbody></table>{!visibleBots.length?<p className="empty">{data.bots.length?'没有匹配的机器人':'暂无机器人'}</p>:null}</div>
    <p className="pm-list-footer">共 {data.bots.length} 个机器人 · {data.bots.filter(bot=>bot.usage!=='free').length} 个已绑定，{data.bots.filter(bot=>bot.usage==='free').length} 个空闲</p>
  </>:page==='models'?<>

    {!embedded?<h2>模型连接 <ConfigHelp>同一连接可包含多个模型；更新后需在实例修改配置中保存并同步。</ConfigHelp></h2>:null}<div className="pm-list-filters"><input type="search" aria-label="搜索模型连接" placeholder="搜索连接名称、Provider 或模型" value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="pm-table-wrap"><table className="pm-model-table"><thead><tr><th>名称</th><th>Provider / 模型</th><th>认证 / 状态</th><th>操作</th></tr></thead><tbody>{visibleModels.map(m=><tr key={m.profileId}><td><CompactText text={m.displayName}/><small><CompactText text={m.protocol||'openai-completions'}/></small></td><td><CompactText text={m.provider}/>{dynamicModel(m)?<small><CompactText text={m.protocol==='zcode-coding-plan'?'BigModel Coding Plan · 模型由 ZCode /model 动态选择':'Claude 订阅 · 模型由 Claude 原生管理'}/></small>:<details><summary>{`${idsOf(m).length} 个模型`} · 展开查看</summary>{capabilitiesOf(m).map(item=><small key={item.modelId}><CompactText text={`${item.modelId}${item.modelId===m.modelId?'（默认）':''} · ${item.inputModalities.join('+')} · ${item.contextWindow.toLocaleString()} ctx · ${item.maxTokens.toLocaleString()} max · ${item.reasoningLevels.join('/')||'无思考档位'} · 摘要 ${item.supportsReasoningSummaries?item.defaultReasoningSummary:'不支持'}`}/></small>)}</details>}</td><td>{m.authMethod==='oauth'?'实例内官方登录':m.apiKeyConfigured?'Key 已配置':'未配置'}<small>{m.enabled?'已启用':'已停用'}</small></td><td><AgentActions name={`${m.displayName}（${m.profileId}）`} actions={[
      {label:'编辑连接',run:()=>{setCloneSourceId(null);setModel(m);setModal('model');}},
      {label:'克隆',run:()=>clone(m)},
      {label:'删除',danger:true,run:()=>{setModel(m);setModal('delete-model');}},
    ]}/></td></tr>)}</tbody></table>{!visibleModels.length?<p className="empty">{data.models.length?'没有匹配的模型连接':'暂无模型连接'}</p>:null}</div>
  </>:<>
    {['all','local'].includes(agentSection)?<LocalControlAgent models={data.models}/>:null}
    {agentSection==='logins'?<LoginWorkbench embedded container={null} containers={data.containers} onClose={()=>{}}/>:null}
    {['all','instances'].includes(agentSection)?<>
    <div className="pm-bot-list-heading"><h2>实例列表 <Parameter help="Agent 类型和挂载固定；镜像可升级，模型、Proxy 和机器人可修改并同步。执行任务期间不可修改。"> </Parameter></h2><span>{data.containers.length} 个实例</span></div>
    <div className="pm-list-filters"><input type="search" aria-label="搜索 Agent 实例" placeholder="搜索名称、类型、镜像或日期" value={instanceQuery} onChange={e=>setInstanceQuery(e.target.value)}/></div>
    <div className="pm-table-wrap"><table className="pm-agent-table"><thead><tr><th>Agent / 镜像</th><th>认证 / 模型</th><th>机器人</th><th><Parameter help="已应用版本与目标版本一致时，容器已确认配置。模型管理更新连接后，在操作菜单同步配置。">同步状态</Parameter></th><th>操作</th></tr></thead><tbody>{data.containers.filter(c=>[c.displayName,c.agentType,c.image,c.createdAt||''].some(v=>v.toLowerCase().includes(instanceQuery.trim().toLowerCase()))).map(c=>{const multi=(c.imageAgents?.length||0)>1&&c.agentType!=='browser';const agentNameOf=(id:string)=>data.agents.find(a=>a.id===id)?.name||id;const expanded=!!expandedIds[c.containerId];const clis=multi?cliRows[c.containerId]:null;
    const instanceActions=c.agentType==='browser'?[
      {label:'打开浏览器',disabled:c.status!=='ready',run:()=>void openDashboard(c)},
      {label:'配置 Proxy',disabled:c.status!=='ready',run:()=>{setSelected(c);setModal('browser');}},
      ...(c.status==='error'?[{label:'重试启动',run:()=>void mutate(`/browsers/${c.containerId}/reconcile`,'POST',{})}]:[]),
      {label:c.status==='deleting'?'重试删除':'删除',danger:true,run:()=>{setSelected(c);setModal('delete');}},
    ]:multi?[
      ...(c.runtimeKind==='native-botmux'?[{label:'打开 Agent 工作台',disabled:c.status!=='ready',run:()=>void openDashboard(c)}]:[]),
            {label:'修改配置',disabled:c.status!=='ready',run:()=>setConfigureTarget(c)},
      {label:'登录 CLI',disabled:c.status!=='ready',run:()=>{setSelected(c);setModal('cli-login');}},
      {label:'镜像升级 / 回滚',disabled:!['ready','error'].includes(c.status),run:()=>{setSelected(c);setModal('upgrade');}},
      ...(c.status==='error'?[{label:'重试同步',run:()=>void mutate(`/containers/${c.containerId}/reconcile`,'POST',{})}]:[]),
      {label:'删除',danger:true,run:()=>{setSelected(c);setModal('delete');}},
    ]:[
      ...(c.runtimeKind==='native-botmux'?[{label:'打开 Agent 工作台',disabled:c.status!=='ready',run:()=>void openDashboard(c)},
        ...((c.requiresLogin||c.authMethod==='oauth')?[{label:c.agentType==='claude-code'?'Claude 订阅登录':'原生 OAuth 登录',disabled:c.status!=='ready',run:()=>{setSelected(c);setModal('logins');}}]:[])]:[]),
      {label:'修改配置',run:()=>setConfigureTarget(c)},
      {label:'登录 CLI',disabled:c.status!=='ready',run:()=>{setSelected(c);setModal('cli-login');}},
      {label:'镜像升级 / 回滚',disabled:!['ready','error'].includes(c.status),run:()=>{setSelected(c);setModal('upgrade');}},
      ...(c.status==='error'?[{label:'重试同步',run:()=>void mutate(`/containers/${c.containerId}/reconcile`,'POST',{})}]:[]),
      {label:'删除',danger:true,run:()=>{setSelected(c);setModal('delete');}},
    ];

    return <Fragment key={c.containerId}><tr><td colSpan={multi?2:undefined}><CompactText text={c.displayName}/><small><CompactText text={`${c.agentType==='browser'?'浏览器':c.agentType} · ${c.imageLabel||c.image}`}/></small>{c.createdAt?<small>{new Date(c.createdAt).toLocaleDateString()}</small>:null}{multi?<button type="button" className="pm-cli-toggle" aria-expanded={expanded} onClick={()=>void toggleClis(c)}>{expanded?'收起 CLI':`展开 CLI（${clis?.length??c.imageAgents!.length}）`}</button>:null}</td>{!multi?<td><CompactText text={c.modelName||'—'}/><small><CompactText text={c.agentType==='browser'?'手动管理 · 无到期时间':c.modelId||"CLI 原生默认模型"}/></small></td>:null}<td><CompactText text={c.agentType==='browser'?'不适用':c.botName||'未绑定'}/></td><td><span className={`pm-status pm-status-${c.status}`}>{syncingId===c.containerId?'同步中…':c.runtimeHealth==='unhealthy'?'服务恢复未确认':labels[c.status]||c.status}</span><small data-tip={`已应用 ${c.appliedRevision} / 目标 ${c.revision}`}>版本 {c.appliedRevision} / {c.revision}</small>{c.lastError?<small className="hint-warn"><CompactText text={c.lastError}/></small>:null}</td><td><AgentActions name={c.displayName} disabled={!!syncingId} actions={instanceActions}/></td></tr>
    {multi&&expanded?(clis??[]).map(cli=>{const oauthEligible=cli.configured===true&&((['codex','zcode'].includes(cli.agentType)&&cli.authMethod==='oauth')||(cli.agentType==='claude-code'&&cli.modelProtocol==='vercel-claude'));return <tr key={`${c.containerId}:${cli.agentType}`} className="pm-cli-row"><td><span className="pm-cli-name">{agentNameOf(cli.agentType)}</span>{cli.active?<span className="pm-state">当前使用</span>:null}{!cli.configured?<span className="pm-state">未配置</span>:null}</td><td><CompactText text={cli.configured?(cli.authMethod==='oauth'?'原生 OAuth 登录':cli.modelName||'—'):'—'}/><small><CompactText text={cli.configured?(cli.authMethod==='oauth'?(cli.modelId||'CLI 原生默认模型'):(cli.modelId||'—')):'保存配置后可切换使用'}/></small></td><td>{cli.oauthState?loginStates[cli.oauthState]||cli.oauthState:'—'}</td><td>{cli.configured?<><small data-tip={`已应用 ${cli.appliedRevision} / 目标 ${cli.revision}`}>版本 {cli.appliedRevision} / {cli.revision}</small>{cli.lastError?<small className="hint-warn"><CompactText text={cli.lastError}/></small>:cli.appliedRevision!==cli.revision?<small className="hint-warn">待同步</small>:null}</>:'—'}</td><td><AgentActions name={`${c.displayName} · ${agentNameOf(cli.agentType)}`} disabled={!!syncingId} actions={[
      {label:'修改模型',run:()=>setCliTarget({container:c,cli})},
      ...(oauthEligible?[{label:cli.agentType==='claude-code'?'Claude 订阅登录':'原生 OAuth 登录',disabled:c.status!=='ready',run:()=>{setSelected(c);setLoginCli(cli.agentType);setModal('logins');}}]:[]),
    ]}/></td></tr>;}):null}
    {multi&&expanded&&!clis?<tr className="pm-cli-row"><td colSpan={5}>正在读取 CLI 列表…</td></tr>:null}
    </Fragment>;})}</tbody></table>{!data.containers.length?<p className="empty">暂无 Agent</p>:null}</div>
    </>:null}
    {['all','catalog'].includes(agentSection)?<ImageCatalog agents={data.agents}/>:null}
  </>}
  {configureTarget?<ConfigureAgent container={configureTarget} onClose={()=>setConfigureTarget(null)} onDone={v=>{setConfigureTarget(null);finish(v);}}/>:null}
  {modal==='bot'?<PlatformBotCreate api={platformApi} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='import-bot'?<PlatformBotImport api={platformApi} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='bind-local'&&selectedBot?<BindLocalBot bot={selectedBot} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='delete-bot'&&selectedBot?<DeleteBot bot={selectedBot} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='container'?<ContainerForm data={data} container={selected} hideModel={(selected?.imageAgents?.length||0)>1&&selected?.agentType!=='browser'} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='browser'?<BrowserInstanceForm container={selected} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='model'?<ModelForm model={model} cloneSourceId={cloneSourceId} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='delete-model'&&model?<DeleteModel model={model} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='delete'&&selected?(selected.agentType==='browser'?<DeleteBrowserInstance container={selected} onClose={()=>setModal(null)} onDone={finish}/>:<DeleteContainer container={selected} onClose={()=>setModal(null)} onDone={finish}/>):null}
  {modal==='unbind'&&selectedBot?(selectedBot.usage==='local'?<UnbindLocalBot bot={selectedBot} onClose={()=>setModal(null)} onDone={finish}/>:<UnbindBot bot={selectedBot} onClose={()=>setModal(null)} onDone={finish}/>):null}
  {modal==='upgrade'&&selected?<ImageUpgrade container={selected} onClose={()=>setModal(null)} onDone={()=>{setModal(null);void refresh();}}/>:null}
  {cliTarget?<CliConfigForm data={data} container={data.containers.find(c=>c.containerId===cliTarget.container.containerId)||cliTarget.container} cli={cliRows[cliTarget.container.containerId]?.find(c=>c.agentType===cliTarget.cli.agentType)||cliTarget.cli} onRefresh={refresh} onClose={()=>setCliTarget(null)} onDone={finishCli}/>:null}
  {activateTarget?<ActivateCli container={data.containers.find(c=>c.containerId===activateTarget.container.containerId)||activateTarget.container} cli={activateTarget.cli} agentName={data.agents.find(a=>a.id===activateTarget.cli.agentType)?.name||activateTarget.cli.agentType} onRefresh={refresh} onClose={()=>setActivateTarget(null)} onDone={finishCli}/>:null}
  {modal==='logins'?<LoginWorkbench container={selected} containers={data.containers} presetAgentType={loginCli} onClose={()=>{setModal(null);setLoginCli(undefined);}}/>:null}
  {modal==='cli-login'&&selected?<CliLoginDialog target={selected.containerId} onClose={()=>setModal(null)}/>:null}
  {switchTarget?<CliSwitchForm container={switchTarget} agents={data.agents} onClose={()=>setSwitchTarget(null)} onDone={finishCli}/>:null}
  </section>;
}
export function WorkspaceSettings({options,onClose,onDone,embedded=false}:{options:WorkspaceOptions;onClose:()=>void;onDone:(m:string)=>void;embedded?:boolean}){
  const [path,setPath]=useState(options.hostPathRoot||options.defaultHostPath||options.tenantHome||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const submitting=useRef(false);
  const form=<form onSubmit={async e=>{
    e.preventDefault();if(submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{await platformApi('/workspaces','PUT',{hostPathRoot:path.trim()});onDone('hostPath 范围已保存，创建时使用该目录预填并限制子目录。');}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}>
    <div className="pm-bot-list-heading"><h3><Parameter help="仅允许此目录及其子目录作为 Agent 工作区，同时用于默认预填；现有挂载不自动改变。">hostPath 范围</Parameter></h3><span>{options.hostPathRoot?<button type="button" disabled={busy} onClick={async()=>{if(submitting.current)return;submitting.current=true;setBusy(true);setError('');try{await platformApi('/workspaces','PUT',{hostPathRoot:null});onDone('已取消 hostPath 范围，恢复部署默认策略。');}catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}}}>取消范围</button>:null}<button disabled={busy||!path.trim()}>{busy?'保存中…':'保存设置'}</button></span></div>
    <label className="pm-sr-only" htmlFor="hostpath-range">hostPath 范围</label><input id="hostpath-range" aria-label="hostPath 范围" name="hostPathRoot" value={path} onChange={e=>setPath(e.target.value)} disabled={busy} required placeholder={options.tenantHome||'/absolute/host/directory'}/>
    {error?<p role="alert" className="hint-warn">{error}</p>:null}<footer>{!embedded?<button type="button" onClick={onClose} disabled={busy}>取消</button>:null}</footer>
  </form>;
  const content=<>{form}{options.globalReadOnlyMounts?<HostMountSettings mounts={options.globalReadOnlyMounts} onDone={()=>onDone('挂载配置已保存')}/>:null}</>;
  return embedded?<div className="pm-settings-form">{content}</div>:<Modal title="工作区设置" onClose={onClose} busy={busy}>{content}</Modal>;
}
export function BindLocalBot({bot,onClose,onDone}:{bot:Bot;onClose:()=>void;onDone:(m:string)=>void}){
  const [cliId,setCliId]=useState(bot.localCliId||'pi'),[owner,setOwner]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');const submitting=useRef(false);
  useEffect(()=>{if(bot.ownerConfigured)return;let cancelled=false;void platformApi('/feishu-session').then(value=>{if(!cancelled)setOwner(current=>current||value.session?.identity?.email||'');}).catch(()=>{});return()=>{cancelled=true;};},[bot.ownerConfigured]);
  return <Modal title="同步到本地 Botmux" onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(!confirmed||submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{const result=await platformApi(`/local-bots/${encodeURIComponent(bot.appId)}/bind`,'POST',{bindingRevision:bot.bindingRevision,cliId,confirmRestart:true,...(!bot.ownerConfigured?{owner}: {})});
      if(result.applied!==true)throw new Error('同步尚未确认，请刷新后重试');onDone('数据库配置已同步到本地 Botmux，并确认启动。');
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}><p>从数据库恢复「{bot.displayName}」的凭据和绑定。本地 Bot 配置页面将在同步成功后显示此机器人。</p>
    <label>本地 CLI<select name="localBotCli" value={cliId} disabled={busy} onChange={e=>setCliId(e.target.value)}><option value="pi">Pi</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="traex">TRAE</option><option value="zcode">ZCode</option></select></label>
    {!bot.ownerConfigured?<label>确认机器人所有者<input name="localBotOwner" required value={owner} disabled={busy} onChange={e=>setOwner(e.target.value)} placeholder="企业邮箱、手机号或 union_id"/><small className="hint">此记录缺少 owner，需要在目标应用下验证；不会从其他 Bot 复制 open_id。</small></label>:null}
    <ConfigHelp>模型和 OAuth 使用当前容器的全局配置，不复制、不删除登录态。正在执行任务时拒绝同步。</ConfigHelp>
    <label className="pm-check"><input type="checkbox" required checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/><span>确认同步配置并启动此 Bot；已有空闲进程会重启。</span></label>
    {error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||!confirmed||!bot.ownerConfigured&&!owner.trim()}>{busy?'同步中…':'同步并启动'}</button></footer>
  </form></Modal>;
}
export function DeleteBot({bot,onClose,onDone}:{bot:Bot;onClose:()=>void;onDone:(m:string)=>void}){
  const [confirmId,setConfirmId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const submitting=useRef(false);
  return <Modal title="删除 Bot 平台记录" onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(confirmId!==bot.appId||submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{const result=await platformApi(`/bots/${encodeURIComponent(bot.appId)}`,'DELETE',{confirmAppId:confirmId});if(result.deleted!==true)throw new Error('删除尚未确认');onDone('平台记录已删除，保存的 Bot 凭据已清除；飞书应用未删除，可重新导入。');}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}><p>仅删除「{bot.displayName}」的平台记录及其保存的凭据，不删除飞书应用、Agent 登录态、会话或工作区。绑定中的机器人必须先解绑。</p>
    <label>输入 App ID 确认<input name="confirmBotAppId" value={confirmId} disabled={busy} onChange={e=>setConfirmId(e.target.value)} placeholder={bot.appId}/></label>
    {error?<p role="alert" className="hint-warn">{error}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||confirmId!==bot.appId}>{busy?'删除中…':'删除平台记录'}</button></footer></form></Modal>;
}
export function UnbindLocalBot({bot,onClose,onDone}:{bot:Bot;onClose:()=>void;onDone:(m:string)=>void}){
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');const submitting=useRef(false);
  return <Modal title="解除本地 Bot 绑定" onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(!confirmed||submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{const result=await platformApi(`/local-bots/${encodeURIComponent(bot.appId)}/unbind`,'POST',{...(bot.localRevision?{localRevision:bot.localRevision}:{bindingRevision:bot.bindingRevision}),confirmLocalStop:true});
      if(result.released!==true)throw new Error('本地解绑尚未确认，请刷新后重试');onDone('本地 Agent 已停止，机器人已回到空闲池；飞书应用和数据保留。');
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}><p>将「{bot.displayName}」从本地 Botmux 解绑并移入空闲池。</p><ConfigHelp>保留飞书应用、凭据恢复副本、会话及工作区文件。解绑后不会随 Gateway 重启自动绑定本地。</ConfigHelp><label className="pm-check"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/><span>确认停止此机器人的本地 Agent，可能中断正在运行的任务。</span></label>{error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy||!confirmed}>{busy?'解绑中…':'确认停止并解绑'}</button></footer></form></Modal>;
}
export function UnbindBot({bot,onClose,onDone}:{bot:Bot;onClose:()=>void;onDone:(m:string)=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');const submitting=useRef(false);
  return <Modal title="摘除机器人绑定" onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{const result=await platformApi(`/bots/${encodeURIComponent(bot.botId)}/unbind`,'POST',{containerId:bot.containerId,revision:bot.containerRevision});const c=result.container;
      if(!c||c.containerId!==bot.containerId||c.botId!==null||c.status!=='ready'||c.revision!==c.appliedRevision||c.revision<=Number(bot.containerRevision))throw new Error('摘除未确认生效，请刷新状态；机器人暂不释放');
      onDone('机器人已摘除，容器解绑配置已同步；机器人返回空闲池。');
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}><p>将 {bot.displayName} 从 Agent「{bot.containerName}」摘除，并同步到对应容器。</p><ConfigHelp>容器确认无绑定后才返回空闲池。不会删除飞书应用、容器或数据；忙碌时请等待任务结束。</ConfigHelp>{error?<p role="alert" className="hint-warn">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy}>{busy?'同步解绑中…':'确认摘除并同步'}</button></footer></form></Modal>;
}
function DeleteContainer({container,onClose,onDone}:{container:Container;onClose:()=>void;onDone:(m:string)=>void}){
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <Modal title="删除 Agent 容器" onClose={onClose}><form onSubmit={async event=>{
    event.preventDefault();const data=new FormData(event.currentTarget);setBusy(true);
    try{const result=await platformApi(`/containers/${container.containerId}`,'DELETE',{revision:container.revision,cancelRunning:data.get('mode')==='cancel'});
      onDone(result.queued?'已登记删除请求，等待任务结束后自动删除':'已确认删除运行资源，数据卷保留');
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  }}><p>删除 {container.displayName}（{container.agentType}）。确认远端删除后才释放机器人 {container.botName||'（未绑定）'}。</p>
    <ConfigHelp>保留 /workspace、Agent state 和日志；不会删除飞书应用。</ConfigHelp>
    <label>正在执行的任务<select name="mode" defaultValue="wait"><option value="wait">等待任务结束后删除</option><option value="cancel">取消任务并删除（中断正在运行的进程）</option></select></label>
    <label>输入容器名确认<input required value={name} onChange={event=>setName(event.target.value)} placeholder={container.displayName}/></label>
    {error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>返回</button><button className="primary" disabled={busy||name!==container.displayName}>{busy?'删除中…':'确认删除'}</button></footer>
  </form></Modal>;
}
export function ContainerForm({data,container,onClose,onDone,hideModel=false}:{data:Data;container:Container|null;onClose:()=>void;onDone:(m:string)=>void;hideModel?:boolean}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);const requestId=useRef(newPlatformRequestId());
  const [mcpIds,setMcpIds]=useState<string[]>([]);
  const [workspaceType,setWorkspaceType]=useState('volume'),[volumeSource,setVolumeSource]=useState(''),[readOnly,setReadOnly]=useState(false);
  const [agentType,setAgentType]=useState(container?.agentType||'pi');
  const [hostMountIds,setHostMountIds]=useState<string[]>(container?.hostMounts?.map(m=>m.id)??[]);
  const [imageProfile,setImageProfile]=useState('native');
  const [cachedImages,setCachedImages]=useState<CachedImage[]>([]),[cachedHostArch,setCachedHostArch]=useState<string|undefined>(),[selectedImage,setSelectedImage]=useState('');
  useEffect(()=>{if(container)return;void platformApi('/image-cache').then(v=>{if(!Array.isArray(v.images))throw Error('镜像缓存响应无效，请刷新');setCachedImages(v.images);setCachedHostArch(v.hostArch);}).catch(e=>setError(String(e)));},[]);
  const initialModelSelection=container?configuredModelSelection(container.authMethod,container.modelProfileId,container.modelId):'';
  const [modelSelection,setModelSelection]=useState(initialModelSelection),[oauthModelId,setOauthModelId]=useState(container?.authMethod==='oauth'&&container.agentType==='codex'?container.modelId||'':'');
  const agent=data.agents.find(a=>a.id===agentType);
  const admitted=()=>true;
  const workspaceOptions=data.workspaceOptions;
  const submit=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setBusy(true);setError('');const values=Object.fromEntries(new FormData(event.currentTarget));
    try{let modelProfileId:string|null=null,modelId:string|null=null,authMethod:'api-key'|'oauth'='api-key';
    if(!hideModel){const normalized=normalizeModelSelection(agentType,modelSelection,oauthModelId,data.models);modelProfileId=normalized.modelProfileId;modelId=normalized.modelId;authMethod=normalized.authMethod;}
      if(container){if(hideModel){const observed=await syncInstanceBinding(platformApi,container,String(values.botId||'')||null,String(values.proxyProfileId||'')||null);onDone(`机器人与代理已同步（版本 ${observed.appliedRevision}），模型配置请在各 CLI 行单独修改。`);}
        else{const observed=await syncAgentConfiguration(platformApi,container,modelProfileId,String(values.botId||'')||null,modelId,String(values.proxyProfileId||'')||null);onDone(`Agent 模型与配置已同步（版本 ${observed.appliedRevision}），后续任务使用新配置。`);}}
      else {const fields={...values};delete fields.modelSelection;delete fields.oauthModelId;const created=await platformApi('/containers','POST',{...fields,...modelSelectionForCreate({modelProfileId,modelId,authMethod}),
        workspace:workspaceType==='hostpath'?'hostpath':volumeSource?'volume':'new',
        workspaceSource:workspaceType==='hostpath'?values.workspaceSource:volumeSource||undefined,
        cpu:Number(values.cpu||1),memoryMiB:Number(values.memoryMiB||2048),mountGlobalReadOnly:values.mountGlobalReadOnly==='on',...(workspaceOptions?.globalReadOnlyMounts?{hostMountIds}:{}),workspaceReadOnly:readOnly,dockerAccess:imageProfile==='dev'&&values.dockerAccess==='on',hostPathConfirmed:workspaceType==='hostpath'&&values.hostPathConfirmed==='on',requestId:requestId.current,agentType,...(mcpIds.length?{mcpServerIds:mcpIds}:{})});
        if(created.container)await platformApi('/agent-pools','POST',{workspaceKind:created.container.workspaceKind??'volume',workspaceSource:created.container.workspaceClaim,displayName:'工作区 Agent 池'});
        onDone('Agent 已创建并完成运行握手');}}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  };
  return <Modal title={container?'Agent 配置':'创建 Agent'} onClose={onClose} busy={busy}><form onSubmit={submit}>
    <label><Parameter help="用于列表识别，创建后不可修改。最多 64 字符。">名称</Parameter><input name="displayName" defaultValue={container?.displayName||''} required maxLength={64} disabled={!!container}/></label>
    <label><Parameter help="Agent 类型创建后固定。Worker 保留飞书通信和 Dashboard。">Agent</Parameter><select aria-label="Agent 类型" disabled={!!container} value={agentType} onChange={event=>{setAgentType(event.target.value);setImageProfile('native');setSelectedImage('');setModelSelection('');setOauthModelId('');}}>{data.agents.filter(a=>a.supported&&a.id!=='browser').map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <label><Parameter help="从本地缓存选择兼容镜像。远端镜像请先到支持的 Agent 页面拉取。Dev 镜像包含四种 CLI、编译调试和 Docker 客户端；非本机架构镜像不可选择。">镜像</Parameter>{container?<input value={container.image} title={container.image} disabled/>:<select name="image" required value={selectedImage} onChange={e=>{setSelectedImage(e.target.value);setImageProfile(cachedImages.find(i=>i.id===e.target.value)?.roles.includes('control')?'dev':'native');}}><option value="">选择已缓存的兼容镜像</option>{hostFirst(cachedImages.filter(i=>i.agents.includes(agentType)&&i.roles.includes('worker')),cachedHostArch).map(i=>{const foreign=!!i.architecture&&!!cachedHostArch&&i.architecture!==cachedHostArch;return <option key={i.id} value={i.id} disabled={foreign}>{i.roles.includes('control')?'Dev · ':'Worker · '}{imageOptionLabel(i.tags,i.id,i.architecture,cachedHostArch)}</option>;})}</select>}</label>
    {!container?<input type="hidden" name="imageProfile" value={imageProfile}/>:null}
    {!container?<McpSelection clis={cachedImages.find(i=>i.id===selectedImage)?.agents??[agentType]} value={mcpIds} onChange={setMcpIds} disabled={busy}/>:null}
    {!container?<><label>CPU 配额<input name="cpu" type="number" min="0.25" step="0.25" defaultValue="1"/></label><label>内存 MiB<input name="memoryMiB" type="number" min="128" defaultValue="2048"/></label><>{workspaceOptions?.globalReadOnlyMounts?<HostMountSelection mounts={workspaceOptions.globalReadOnlyMounts} value={hostMountIds} onChange={setHostMountIds} disabled={busy}/>:<label className="pm-check"><input name="mountGlobalReadOnly" type="checkbox" disabled={!workspaceOptions?.globalReadOnlyHostPath}/><span>挂载 /host 全局只读目录</span></label>}</></>:null}
    {!container&&imageProfile==='dev'?<label className="pm-check"><input name="dockerAccess" type="checkbox"/><Parameter help="挂载宿主 Docker socket，权限等同宿主机管理员；仅可信开发任务开启。普通 Worker 默认不挂载。">允许 Dev Agent 使用宿主 Docker</Parameter></label>:null}
    <ProxySelect defaultValue={container?.proxyProfileId}/>
    {!hideModel?<><ModelAuthSelector agentType={agentType} models={data.models.filter(m=>admitted())} protocols={container?.runtimeKind==='pi-rpc'?['openai-completions']:agent?.protocols||['openai-completions']} authMethods={container?.runtimeKind==='pi-rpc'?['api-key']:agent?.authMethods||['api-key']} currentProfileId={container?.modelProfileId}
      value={modelSelection} onChange={setModelSelection} oauthModelId={oauthModelId} onOauthModelIdChange={setOauthModelId} disabled={busy} selectAriaLabel="登录方式 / 模型"/>
    {modelSelection===configuredModelSelection('oauth',null,null)?<ConfigHelp>创建完成后，在 Agent 操作菜单完成原生 OAuth 登录。凭据只保存在该 Worker；不会写入模型管理或复制到其他实例。</ConfigHelp>:null}</>:hideModel?<ConfigHelp>此实例包含多个 Agent CLI：模型与认证在展开后的每个 CLI 行单独配置；此处只修改机器人绑定和代理。</ConfigHelp>:null}
    <label><Parameter help="可选择空闲机器人。选择“不绑定机器人”会同步解绑但保留容器，确认生效后机器人回到空闲池。">飞书机器人</Parameter><select name="botId" defaultValue={container?.botId||''}><option value="">不绑定机器人</option>{data.bots.filter(b=>b.usage==='free'||b.botId===container?.botId).map(b=><option key={b.botId} value={b.botId}>{b.displayName} · {b.appId}</option>)}</select></label>
    {container?<label><Parameter help="挂载创建后固定。更换挂载需新建 Agent，可复用历史目录或卷。">工作区</Parameter><input disabled title={container.workspaceClaim} value={`${container.workspaceKind||'volume'} · ${container.workspaceClaim}${container.workspaceReadOnly?'（只读）':''}`}/></label>:<>
      <label><Parameter help="先选择 /workspace 的存储类型，再选择具体数据卷或宿主机目录；与凭据 state 卷独立。">工作区类型</Parameter><select aria-label="工作区类型" value={workspaceType} onChange={e=>{setWorkspaceType(e.target.value);setReadOnly(e.target.value==='hostpath');}}><option value="volume">volume · Docker 数据卷</option><option value="hostpath" disabled={!workspaceOptions?.hostPathEnabled}>hostPath · 宿主机目录</option></select></label>
      {workspaceType==='volume'?<label><Parameter help="新建独立卷会创建新的文件空间；已有卷包含平台共享卷和历史使用过的卷。复用同一个卷即共享文件，不会复制一份。">数据卷</Parameter><select aria-label="数据卷" name="workspaceSource" value={volumeSource} onChange={e=>setVolumeSource(e.target.value)}><option value="">新建独立卷</option><optgroup label="已有 volume">{workspaceOptions?.workspaces?.filter(w=>w.kind==='volume').map(w=><option key={w.source} value={w.source}>{w.shared?'平台共享卷 · ':''}{w.source}{w.shared?'':` · 使用 ${w.useCount} 次`}</option>)}</optgroup></select></label>:null}
      <ConfigHelp>{workspaceType==='hostpath'?'直接挂载 Docker 宿主机目录到 /workspace，与宿主机共享文件。':!volumeSource?'创建新的 Docker 数据卷，文件独立；删除 Agent 后仍保留。':'复用已有卷和文件；多个 Agent 选择同一个卷即共享文件，请留意并发写入。'}</ConfigHelp>
      {workspaceType==='hostpath'?<><label><Parameter help={`${workspaceOptions?.hostPathMode==='unrestricted'?'不限制目录范围；填写 Docker 宿主机绝对路径，实际挂载权限由 Docker 决定。':`目录需预先存在。批准根目录：${workspaceOptions?.hostRoots.join('、')||'未配置'}。`}默认路径在“工作区设置”修改。`}>hostPath（可选历史目录）</Parameter><input name="workspaceSource" required list="pm-hostpath-history" defaultValue={workspaceOptions?.defaultHostPath||workspaceOptions?.tenantHome||''}/><datalist id="pm-hostpath-history">{workspaceOptions?.workspaces?.filter(w=>w.kind==='hostpath').map(w=><option key={w.source} value={w.source}/>)}</datalist></label><label className="pm-check"><input type="checkbox" name="hostPathConfirmed" required/><span>确认此目录将暴露给 Agent；读写模式下 Agent 可修改、删除该目录内容。</span></label></>:null}
      <label className="pm-check"><input type="checkbox" checked={readOnly} onChange={e=>setReadOnly(e.target.checked)}/><Parameter help="只读时 Agent 可以读取工作区但不能修改。hostPath 默认只读；关闭后允许修改或删除目录内容。">只读挂载 /workspace</Parameter></label>
    </>}
    {busy?<p className="hint" role="status">正在同步到 Agent，等待运行时确认…</p>:null}
    {error?<p role="alert" className="hint-warn">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>关闭</button><button type="submit" className="primary" disabled={busy||!!container&&container.status!=='ready'}>{busy?'同步中…':container?'保存并同步':'创建 Agent'}</button></footer>
  </form></Modal>;
}
/** Per-CLI model/auth form for multi-CLI instances. The active CLI saves
 * through the container reconcile path; inactive ones only rewrite files. */
export function CliConfigForm({data,container,cli,onClose,onDone,onRefresh}:{data:Data;container:Container;cli:CliConfigurationRecord;onClose:()=>void;onDone:(m:string)=>void;onRefresh?:()=>Promise<void>}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [modelSelection,setModelSelection]=useState(configuredModelSelection(cli.authMethod,cli.modelProfileId,cli.modelId));
  const [oauthModelId,setOauthModelId]=useState(cli.authMethod==='oauth'&&cli.agentType==='codex'?cli.modelId||'':'');
  const submitting=useRef(false);
  const agent=data.agents.find(a=>a.id===cli.agentType);
  const name=agent?.name||cli.agentType;
  return <Modal title={`${name} · 模型与认证`} onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{const normalized=normalizeModelSelection(cli.agentType,modelSelection,oauthModelId,data.models);
      const observed=await saveCliConfiguration(platformApi,container.containerId,cli,normalized.modelProfileId,normalized.modelId);
      onDone(`${name} 配置已保存并同步（版本 ${observed.revision}）。`);}
    catch(error){await onRefresh?.();setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}>
    <ConfigHelp>{cli.active?'此 CLI 正被机器人使用：保存会同步到实例，运行时确认后才生效。':'此 CLI 未投入使用：实例空闲时可保存配置；需要使用时在实例操作中选择“切换 CLI”。'}</ConfigHelp>
    <ModelAuthSelector agentType={cli.agentType} models={data.models} protocols={agent?.protocols||['openai-completions']} authMethods={agent?.authMethods||['api-key']} currentProfileId={cli.modelProfileId}
      value={modelSelection} onChange={setModelSelection} oauthModelId={oauthModelId} onOauthModelIdChange={setOauthModelId} disabled={busy}
      selectAriaLabel="登录方式 / 模型" help="选择该 CLI 支持的认证方式和模型连接；与实例级配置相互独立。"/>
    {modelSelection===configuredModelSelection('oauth',null,null)?<ConfigHelp>保存后在此 CLI 行选择“原生 OAuth 登录”完成授权；凭据只保留在此 Agent。</ConfigHelp>:null}
    {cli.agentType==='claude-code'&&!data.models.some(m=>m.enabled&&m.authMethod!=='oauth'&&m.protocol==='anthropic-messages')?<ConfigHelp>未找到可用的普通 API Key 连接：请在模型管理创建 Anthropic Messages 协议连接；方舟 Coding Plan 可克隆现有连接并改用 Anthropic 地址。</ConfigHelp>:null}
    {busy?<p className="hint" role="status">正在同步到 Agent，等待运行时确认…</p>:null}
    {error?<p role="alert" className="hint-warn">{error}</p>:null}
    <footer><button type="button" onClick={onClose} disabled={busy}>关闭</button><button type="submit" className="primary" disabled={busy||container.status!=='ready'}>{busy?'同步中…':'保存并同步'}</button></footer>
  </form></Modal>;
}
/** Explicit Bot CLI switch confirmation. */
export function ActivateCli({container,cli,agentName,onClose,onDone,onRefresh}:{container:Container;cli:CliConfigurationRecord;agentName:string;onClose:()=>void;onDone:(m:string)=>void;onRefresh?:()=>Promise<void>}){
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const submitting=useRef(false);
  return <Modal title="切换机器人使用的 CLI" onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(!confirmed||submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{await activateCliConfiguration(platformApi,container.containerId,cli.agentType,cli.revision);
      onDone(`机器人已切换为使用 ${agentName}，配置已同步。`);}
    catch(error){await onRefresh?.();setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}>
    <p>将「{container.displayName}」当前使用的 CLI 切换为 {agentName}。</p>
    <ConfigHelp>切换会沿用该 CLI 已保存的模型与认证，运行时确认后生效；正在执行任务或登录时会被拒绝。原 CLI 的配置保留，可随时切回。</ConfigHelp>
    <label className="pm-check"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/><span>确认切换并重启此 Agent 的机器人进程。</span></label>
    {busy?<p className="hint" role="status">正在切换，等待运行时确认…</p>:null}
    {error?<p role="alert" className="hint-warn">{error}</p>:null}
    <footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="primary" disabled={busy||!confirmed||container.status!=='ready'}>{busy?'切换中…':'确认切换'}</button></footer>
  </form></Modal>;
}
/** Instance-level CLI switching: one entry point in the instance menu instead
 * of per-CLI actions. Only configured peers can take over the Bot. */
export function CliSwitchForm({container,agents,onClose,onDone}:{container:Container;agents:Agent[];onClose:()=>void;onDone:(m:string)=>void}){
  const [clis,setClis]=useState<CliConfigurationRecord[]|null>(null),[choice,setChoice]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const submitting=useRef(false);
  useEffect(()=>{let live=true;void platformApi(`/containers/${container.containerId}/clis`).then(result=>{if(live){const rows:CliConfigurationRecord[]=result.clis??[];setClis(rows);setChoice(rows.find(cli=>cli.active)?.agentType||'');}}).catch(e=>{if(live)setError(e instanceof Error?e.message:String(e));});return()=>{live=false;};},[container.containerId]);
  const agentNameOf=(id:string)=>agents.find(a=>a.id===id)?.name||id;
  const selected=clis?.find(cli=>cli.agentType===choice);
  return <Modal title={`切换 ${container.displayName} 的 CLI`} onClose={onClose} busy={busy}><form onSubmit={e=>{e.preventDefault();if(submitting.current||!confirmed||!selected||selected.active||!selected.configured)return;submitting.current=true;setBusy(true);setError('');
      void activateCliConfiguration(platformApi,container.containerId,choice,selected.revision)
        .then(()=>onDone(`机器人已切换为使用 ${agentNameOf(choice)}，配置已同步。`))
        .catch(e=>{setError(e instanceof Error?e.message:String(e));submitting.current=false;setBusy(false);});}}>
    <CliSwitchFields value={choice} onChange={setChoice} options={(clis??[]).map(cli=>({id:cli.agentType,name:agentNameOf(cli.agentType)+(cli.active?'（当前使用）':!cli.configured?'（未配置）':''),disabled:!cli.configured&&!cli.active}))} confirmed={confirmed} onConfirm={setConfirmed} busy={busy} loading={!clis&&!error} hint="请先配置目标 CLI 的模型或原生登录。切换会关闭旧 CLI 的空闲会话；文件、历史与原生凭据保留，任务或登录进行中时不能切换。"/>
    {busy?<p className="hint" role="status">正在切换，等待运行时确认…</p>:null}
    {error?<p role="alert" className="hint-warn">{error}</p>:null}
    <footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="primary" disabled={busy||!confirmed||!selected||selected.active||!selected.configured}>{busy?'切换中…':'确认切换'}</button></footer>
  </form></Modal>;
}
export function DeleteModel({model,onClose,onDone}:{model:Model;onClose:()=>void;onDone:(m:string)=>void}){
  const [confirmId,setConfirmId]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),submitting=useRef(false);
  return <Modal title="删除模型连接" onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(confirmId!==model.profileId||submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{const result=await platformApi(`/models/${encodeURIComponent(model.profileId)}`,'DELETE',{});if(result.ok!==true)throw new Error('删除尚未确认，请刷新后重试');onDone('模型连接已删除，保存的 Key 已清除；历史记录保留。');}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}><p>确认删除「{model.displayName}」？将从模型列表移除并清除平台保存的 Key，不会删除 Agent、Bot 或任务数据。</p><ConfigHelp>仍被 Agent、Bot 或未完成 Workflow 引用时会拒绝删除。为保留历史关联，删除后的配置 ID 不可重新使用；此页面不支持恢复。</ConfigHelp><label>输入配置 ID 确认<input name="confirmProfileId" value={confirmId} onChange={e=>setConfirmId(e.target.value)} placeholder={model.profileId} disabled={busy} required/></label>{error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||confirmId!==model.profileId}>{busy?'删除中…':'确认删除'}</button></footer></form></Modal>;
}
export function ModelForm({model,cloneSourceId=null,onClose,onDone}:{model:Model|null;cloneSourceId?:string|null;onClose:()=>void;onDone:(m:string)=>void}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [protocol,setProtocol]=useState(model?.protocol||'openai-completions'),[baseUrl,setBaseUrl]=useState(model?.baseUrl||''),[provider,setProvider]=useState(model?.provider||'');
  const initialIds=model&&!dynamicModel(model)?idsOf(model):[];
  const [modelIdsText,setModelIdsText]=useState(initialIds.join('\n'));
  const [mainModel,setMainModel]=useState(model?.modelId||''),[claudeRouting,setClaudeRouting]=useState<ClaudeModelRouting>(model?.claudeModelRouting||{});
  const [capabilities,setCapabilities]=useState<ModelCapability[]>(model?capabilitiesOf(model):[]);
  type ProtocolDraft={baseUrl:string;provider:string;modelIdsText:string;mainModel:string;claudeRouting:ClaudeModelRouting;capabilities:ModelCapability[]};
  const drafts=useRef<Record<string,ProtocolDraft>>({});
  const authMethod='api-key',dynamic=['zcode-coding-plan','vercel-claude'].includes(protocol);
  const submitting=useRef(false);
  const idsFrom=(text:unknown)=>[...new Set(String(text||'').split(/\r?\n/).map(id=>id.trim()).filter(Boolean))];
  const reconcile=(ids:string[])=>ids.map(modelId=>capabilities.find(item=>item.modelId===modelId)||defaultCapability(modelId));
  const changeIds=(text:string)=>{const ids=idsFrom(text);setModelIdsText(text);setMainModel(current=>ids.includes(current)?current:ids[0]||'');setCapabilities(current=>ids.map(modelId=>current.find(item=>item.modelId===modelId)||defaultCapability(modelId)));};
  const changeProtocol=(nextProtocol:string)=>{
    if(nextProtocol===protocol)return;
    const current={baseUrl,provider,modelIdsText,mainModel,claudeRouting,capabilities};
    drafts.current[protocol]=current;
    const nextDynamic=['zcode-coding-plan','vercel-claude'].includes(nextProtocol);
    // Static API protocols can share their endpoint and model catalog. Fixed
    // provider protocols start clean; each protocol retains its own draft.
    const next=drafts.current[nextProtocol]??(dynamic||nextDynamic
      ?{baseUrl:'',provider:'',modelIdsText:'',mainModel:'',claudeRouting:{},capabilities:[]}
      :{...current,claudeRouting:{}});
    setProtocol(nextProtocol);setBaseUrl(next.baseUrl);setProvider(next.provider);setModelIdsText(next.modelIdsText);
    setMainModel(next.mainModel);setClaudeRouting(next.claudeRouting);setCapabilities(next.capabilities);
  };
  const updateCapability=(modelId:string,change:Partial<ModelCapability>)=>setCapabilities(current=>current.map(item=>{
    if(item.modelId!==modelId)return item;
    const next={...item,...change};
    if(next.defaultReasoningLevel&&!next.reasoningLevels.includes(next.defaultReasoningLevel))next.defaultReasoningLevel=next.reasoningLevels[0]||null;
    return next;
  }));
  return <Modal title={cloneSourceId?'克隆模型连接':model?'编辑模型连接':'添加模型连接'} onClose={onClose} busy={busy}><form onSubmit={async event=>{
    event.preventDefault();if(submitting.current)return;submitting.current=true;const value=Object.fromEntries(new FormData(event.currentTarget));setBusy(true);
    try{const modelIds=dynamic?[]:idsFrom(value.modelIds);
      if(!dynamic&&(!modelIds.length||modelIds.length>100))throw new Error('请填写 1–100 个模型 ID，每行一个');
      const modelCapabilities=dynamic?[]:reconcile(modelIds);
      const routingChangedFromSaved=protocol==='anthropic-messages'&&model?.protocol==='anthropic-messages'&&Object.keys(model.claudeModelRouting||{}).length>0;
      if(protocol==='anthropic-messages'&&(Object.keys(claudeRouting).length>0||routingChangedFromSaved)){
        const support=await platformApi('/models');
        if(support.capabilities?.claudeModelRouting!==true)throw new Error('当前控制面版本不支持独立的 Claude 模型分配，请先升级控制面后重试。');
      }
      const payload={displayName:value.displayName,provider:protocol==='vercel-claude'?'vercel':dynamic?'zai':protocol==='anthropic-messages'?provider.trim()||String(value.profileId).trim():value.provider,baseUrl:protocol==='vercel-claude'?'https://ai-gateway.vercel.sh':dynamic?'https://api.z.ai':baseUrl,modelIds,modelCapabilities,modelId:dynamic?'':protocol==='anthropic-messages'&&modelIds.includes(mainModel)?mainModel:modelIds[0],...(protocol==='anthropic-messages'&&(Object.keys(claudeRouting).length>0||routingChangedFromSaved)?{claudeModelRouting:claudeRouting}:{}),enabled:value.enabled==='on',protocol,authMethod,...(authMethod==='api-key'&&value.apiKey?{apiKey:value.apiKey}:{})};
      if(cloneSourceId)await platformApi(`/models/${encodeURIComponent(cloneSourceId)}/clone`,'POST',{...payload,profileId:value.profileId});
      // The edited revision rejects a save over someone else's change (409).
      else await platformApi(`/models/${encodeURIComponent(String(value.profileId))}`,model?'PUT':'POST',model&&model.revision!==undefined?{...payload,revision:model.revision}:payload);
      onDone(cloneSourceId?'模型连接副本已保存。':'模型连接已保存；现有 Agent 保留原模型，请到 Agent 管理切换或同步配置。');}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}>{cloneSourceId?<ConfigHelp>当前仅预填草稿，尚未创建记录。可修改配置 ID 和其它参数；取消不会写入数据库。Key 留空时，保存副本才复制来源的加密 Key，不回显原文。</ConfigHelp>:null}<label><Parameter help="唯一标识，仅支持字母、数字、点、下划线和连字符，创建后不可修改。新建和克隆不能覆盖已存在的 ID。">配置 ID</Parameter><input name="profileId" defaultValue={model?.profileId||''} required readOnly={!!model&&!cloneSourceId} maxLength={100} pattern="[A-Za-z0-9._-]+"/></label>
    <label><Parameter help="展示在模型连接列表和 Agent 的模型选择器中。">名称</Parameter><input name="displayName" defaultValue={model?.displayName||''} required/></label>
    {!dynamic&&protocol!=='anthropic-messages'?<label><Parameter help="Pi 使用的模型服务提供方标识，仅支持字母、数字、点、下划线和连字符。">Provider</Parameter><input name="provider" value={provider} onChange={e=>setProvider(e.target.value)} required pattern="[A-Za-z0-9._-]+"/></label>:null}
    <label><Parameter help="Codex 要求 OpenAI Responses；Claude Code 要求 Anthropic Messages；Pi 支持这些协议，但具体服务端必须真的实现对应 API。">协议</Parameter><select name="protocol" value={protocol} onChange={e=>changeProtocol(e.target.value)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="vercel-claude">Vercel + Claude 订阅登录</option><option value="zcode-coding-plan">ZCode · Z.AI Coding Plan API Key</option></select></label>
    <ConfigHelp>{protocol==='vercel-claude'?'保存 Vercel Key 后，同步到 Claude Agent，再在登录工作台完成 Claude 订阅登录。更换 Key 后可重新发起登录。':dynamic?'配置 Z.AI Coding Plan API Key 即可。模型列表与默认模型由 ZCode 原生维护，可进入终端用 /model 切换。':protocol==='anthropic-messages'?'Claude 使用 Base URL 和 API Key（Bearer Token）；可分别选择默认主模型、Haiku / Sonnet / Opus 和子 Agent。':'这里只维护 API Key 模型连接。原生 OAuth 请直接在创建 Agent 时选择，无需预建连接。'}</ConfigHelp>
    {!dynamic?<label><Parameter help="模型服务的 API 基础地址。">Base URL</Parameter><input name="baseUrl" type="url" value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} required={!dynamic}/></label>:null}
    {!dynamic?<><label><Parameter help={protocol==='anthropic-messages'?'每行一个精确模型 ID，最多 100 个；主模型、别名和子 Agent 从此列表选择。所有模型共用此连接的协议、地址和凭据。':'每行一个精确模型 ID，最多 100 个；空行忽略、重复去除。第一行为默认模型，不会改变已有 Agent 的选择。所有模型共用此连接的协议、地址和凭据。'}>模型 ID（每行一个）</Parameter><textarea name="modelIds" rows={5} value={modelIdsText} onChange={e=>changeIds(e.target.value)} placeholder={'model-a\nmodel-b'} required/></label>
      {protocol==='anthropic-messages'?<fieldset className="pm-model-capabilities"><legend>Claude 模型分配</legend><ConfigHelp>默认主模型用于新选择此连接的 Agent；已有 Agent 的主模型可单独切换。未指定的别名和子 Agent 跟随该 Agent 的主模型，配置由共用此连接的 Claude Agent 共享。</ConfigHelp>
        <label>默认主模型<select aria-label="Claude 默认主模型" value={mainModel} onChange={e=>setMainModel(e.target.value)} required><option value="" disabled>先填写模型 ID</option>{idsFrom(modelIdsText).map(id=><option key={id} value={id}>{id}</option>)}</select></label>
        {([['haiku','Haiku'],['sonnet','Sonnet'],['opus','Opus'],['subagent','子 Agent']] as const).map(([key,name])=><label key={key}>{name} 模型<select aria-label={`Claude ${name} 模型`} value={claudeRouting[key]||''} onChange={e=>{const value=e.target.value;setClaudeRouting(current=>{const next={...current};if(value)next[key]=value;else delete next[key];return next;});}}><option value="">跟随 Agent 主模型</option>{claudeRouting[key]&&!idsFrom(modelIdsText).includes(claudeRouting[key]!)?<option value={claudeRouting[key]} disabled>已移除：{claudeRouting[key]}</option>:null}{idsFrom(modelIdsText).map(id=><option key={id} value={id}>{id}</option>)}</select></label>)}
      </fieldset>:null}
      <details open={protocol!=='anthropic-messages'}><summary>高级：Pi / Codex 逐模型能力（Claude 无需填写）</summary>{protocol==='anthropic-messages'?<label><Parameter help="供 Pi 使用的提供方标识；留空使用配置 ID。">Provider（可选）</Parameter><input name="provider" value={provider} onChange={e=>setProvider(e.target.value)} pattern="[A-Za-z0-9._-]+"/></label>:null}<fieldset className="pm-model-capabilities"><legend>逐模型能力</legend><ConfigHelp>能力会同步到 Pi 和 Codex 的原生模型目录；Claude 使用所选模型 ID，不使用这里的能力参数。Codex 当前不提供最大输出 Token 的 catalog 字段。</ConfigHelp>
      {reconcile(idsFrom(modelIdsText)).map(item=><details key={item.modelId}><summary>{item.modelId} · {item.inputModalities.join('+')} · {item.contextWindow.toLocaleString()} ctx</summary>
        <div className="pm-capability-grid">
          <label><Parameter help="Coding Agent 必须支持文本；勾选图片后，Pi/Codex 的原生模型目录会公开 image 输入能力。">输入模态</Parameter><span className="pm-inline-checks"><span><input type="checkbox" checked disabled/> text</span><span><input aria-label={`${item.modelId} image 模态`} type="checkbox" checked={item.inputModalities.includes('image')} onChange={e=>updateCapability(item.modelId,{inputModalities:e.target.checked?['text','image']:['text']})}/> image</span></span></label>
          <label><Parameter help="模型可处理的输入与输出总 Token 上限。Codex/Pi 原生目录会使用该值。">上下文窗口</Parameter><input aria-label={`${item.modelId} 上下文窗口`} type="number" min={1024} max={10000000} step={1} value={item.contextWindow} onChange={e=>updateCapability(item.modelId,{contextWindow:Number(e.target.value)})}/></label>
          <label><Parameter help="单次响应最大输出 Token。Pi 原生目录使用该值；Codex 当前 catalog 没有对应字段。">最大输出 Token</Parameter><input aria-label={`${item.modelId} 最大输出 Token`} type="number" min={1} max={item.contextWindow} step={1} value={item.maxTokens} onChange={e=>updateCapability(item.modelId,{maxTokens:Number(e.target.value)})}/></label>
          <label><Parameter help="模型实际支持的思考档位；全部不选表示该模型不支持调节思考强度。">思考级别</Parameter><span className="pm-inline-checks pm-reasoning-levels">{reasoningLevels.map(level=><span key={level}><input aria-label={`${item.modelId} ${level} 思考级别`} type="checkbox" checked={item.reasoningLevels.includes(level)} onChange={e=>updateCapability(item.modelId,{reasoningLevels:e.target.checked?[...item.reasoningLevels,level].sort((a,b)=>reasoningLevels.indexOf(a)-reasoningLevels.indexOf(b)):item.reasoningLevels.filter(value=>value!==level)})}/>{level}</span>)}</span></label>
          <label><Parameter help="新会话默认使用的思考级别；无思考档位时只能选择“不设置”。">默认思考级别</Parameter><select aria-label={`${item.modelId} 默认思考级别`} value={item.defaultReasoningLevel||''} onChange={e=>updateCapability(item.modelId,{defaultReasoningLevel:e.target.value||null})}><option value="">不设置</option>{item.reasoningLevels.map(level=><option key={level} value={level}>{level}</option>)}</select></label>
          <label><Parameter help="模型是否支持 Responses 推理摘要。这和是否支持思考档位是两个独立能力。Codex 的平台配置默认会开启 model_supports_reasoning_summaries；这里决定该模型是否可请求摘要及其默认格式。Pi/DSH 当前原生模型 schema 不支持摘要格式字段。">推理摘要</Parameter><span className="pm-inline-checks"><span><input aria-label={`${item.modelId} 支持推理摘要`} type="checkbox" checked={item.supportsReasoningSummaries} onChange={e=>updateCapability(item.modelId,{supportsReasoningSummaries:e.target.checked,defaultReasoningSummary:e.target.checked?(item.defaultReasoningSummary==='none'?'auto':item.defaultReasoningSummary):'none'})}/> 支持</span></span></label>
          <label><Parameter help="Codex 新会话默认请求的推理摘要格式。none 关闭，auto 由服务选择，concise/detailed 指定摘要详细度。">默认推理摘要</Parameter><select aria-label={`${item.modelId} 默认推理摘要`} value={item.defaultReasoningSummary} disabled={!item.supportsReasoningSummaries} onChange={e=>updateCapability(item.modelId,{defaultReasoningSummary:e.target.value as ModelCapability['defaultReasoningSummary']})}><option value="none">none</option><option value="auto">auto</option><option value="concise">concise</option><option value="detailed">detailed</option></select></label>
        </div>
      </details>)}</fieldset></details></>:null}
    <PlatformSwitch name="enabled" defaultChecked={model?.enabled??true} disabled={busy} title="启用此连接" description="启用后可供 Agent 选择；克隆的副本默认停用。"/>
    <label><Parameter help="加密保存，不回显。编辑时留空保留原 Key；克隆时留空，在保存副本时复制来源 Key，也可以填写新 Key。">API Key</Parameter><input name="apiKey" type="password" autoComplete="new-password" placeholder={cloneSourceId?'留空在保存时复制来源 Key':model?'留空保留现有 Key':''} required={!model?.apiKeyConfigured}/></label>{error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy}>{cloneSourceId?'保存副本':'保存连接'}</button></footer></form></Modal>;
}
export function renderBotsPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="bots"/>);}
export function renderModelsPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="models"/>);}
export function renderAgentsPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="agents"/>);}
