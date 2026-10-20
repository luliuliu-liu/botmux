import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { mountReactPage } from '../react-mount.js';
import { ui } from '../ui.js';
import { CreateActionButton, RefreshIconButton } from '../dashboard-components.js';
import { FeishuSessionPanel } from './feishu-session-panel.js';
import { PlatformBotCreate } from './bot-create.js';
import { syncAgentConfiguration } from './agent-configuration.js';
import { AgentActions, CompactText, Parameter } from './compact-controls.js';
import {NetworkRules,LoginWorkbench} from './worker-access.js';
import {LocalControlAgent} from './local-control-agent.js';

type Bot={botId:string;displayName:string;appId:string;usage:'local'|'free'|'sandbox';localRevision?:string;localDetachPending?:boolean;containerId?:string;containerName?:string;containerRevision?:number;containerStatus?:string;detachPending?:boolean;secretConfigured:boolean};
type Model={profileId:string;displayName:string;provider:string;baseUrl:string;modelId:string;modelIds?:string[];apiKeyConfigured:boolean;enabled:boolean;protocol?:string;authMethod?:string};
const dynamicModel=(model:Model)=>model.protocol==='zcode-coding-plan';
const idsOf=(model:Model)=>dynamicModel(model)?['']:model.modelIds?.length?model.modelIds:[model.modelId];
export type Container={containerId:string;displayName:string;agentType:string;image:string;sandboxId:string|null;authMethod?:string;modelProfileId:string|null;modelName:string;modelId:string|null;
  status:string;revision:number;appliedRevision:number;egressHosts:string[];networkMode?:'unrestricted'|'restricted';botId:string|null;botName:string|null;workspaceClaim:string;workspaceKind?:string;workspaceReadOnly?:boolean;detachPending?:boolean;stateClaim:string;lastError:string|null;runtimeKind?:string};
type Agent={id:string;name:string;supported:boolean;version:string|null;protocols?:string[];authMethods?:string[];images:Array<{id:string;image:string;label:string}>};
type WorkspaceOptions={hostPathEnabled:boolean;hostPathMode?:'unrestricted'|'restricted';tenantHome?:string|null;defaultHostPath?:string|null;hostRoots:string[];workspaces:Array<{kind:'volume'|'hostpath';source:string;readOnly:boolean;useCount:number;shared?:boolean}>};
type Data={bots:Bot[];models:Model[];containers:Container[];agents:Agent[];workspaceOptions?:WorkspaceOptions};
const initial:Data={bots:[],models:[],containers:[],agents:[]};
const labels:Record<string,string>={creating:'配置中',ready:'就绪',error:'异常',deleting:'删除待确认',deleted:'已删除'};
export async function platformApi(path:string,method='GET',body?:unknown){
  const response=await fetch(`/api/platform${path}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();if(!response.ok)throw new Error(result.message||result.error||`HTTP ${response.status}`);return result;
}
export function Modal({title,children,onClose,busy=false}:{title:string;children:ReactNode;onClose:()=>void;busy?:boolean}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{ref.current?.showModal();},[]);
  return <dialog ref={ref} className="pm-dialog" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}><header><h2>{title}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="关闭">×</button></header>{children}</dialog>;
}
export function ManagementPage({page}:{page:'bots'|'models'|'agents'}){
  const [data,setData]=useState<Data>(initial),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
  const [modal,setModal]=useState<'bot'|'container'|'model'|'delete-model'|'delete'|'unbind'|'workspaces'|'network'|'logins'|null>(null),[selected,setSelected]=useState<Container|null>(null),[model,setModel]=useState<Model|null>(null),[selectedBot,setSelectedBot]=useState<Bot|null>(null);
  const [cloneSourceId,setCloneSourceId]=useState<string|null>(null);
  const mounted=useRef(true);
  const syncing=useRef(false),[syncingId,setSyncingId]=useState<string|null>(null);
  const clone=(source:Model)=>{
    setCloneSourceId(source.profileId);
    setModel({...source,profileId:`${source.profileId.slice(0,95)}-copy`,displayName:`${source.displayName.slice(0,190)} 副本`,enabled:false});
    setModal('model');setError('');setNotice('');
  };
  const refresh=async()=>{
    try{const [bots,models,containers,catalog,workspaces]=await Promise.all(['/bots','/models','/containers','/catalog','/workspaces'].map(p=>platformApi(p)));
      if(mounted.current){setData({bots:bots.bots,models:models.models.filter((m:Model)=>m.authMethod!=='oauth'),containers:containers.containers,agents:catalog.agents,workspaceOptions:workspaces});setError('');}}
    catch(error){if(mounted.current)setError(String(error instanceof Error?error.message:error));}
    finally{if(mounted.current)setLoading(false);}
  };
  useEffect(()=>{mounted.current=true;void refresh();const timer=setInterval(()=>void refresh(),10000);return()=>{mounted.current=false;clearInterval(timer);};},[]);
  const title=page==='bots'?'Bot 管理':page==='models'?'模型管理':'Agent 管理';
  const finish=(message:string)=>{setModal(null);setNotice(message);void refresh();};
  const mutate=async(path:string,method:string,body?:unknown)=>{
    try{await platformApi(path,method,body);setNotice('操作完成');await refresh();}catch(error){setError(error instanceof Error?error.message:String(error));}
  };
  const sync=async(container:Container)=>{
    if(syncing.current)return;syncing.current=true;setSyncingId(container.containerId);setError('');setNotice('');
    try{const observed=await syncAgentConfiguration(platformApi,container,container.modelProfileId);await refresh();if(mounted.current)setNotice(`Agent 配置已同步（版本 ${observed.appliedRevision}），后续任务使用新配置。`);}
    catch(error){await refresh();if(mounted.current)setError(error instanceof Error?error.message:String(error));}
    finally{syncing.current=false;if(mounted.current)setSyncingId(null);}
  };
  const openDashboard=async(container:Container)=>{
    const popup=window.open('about:blank','_blank');
    try{const result=await platformApi(`/containers/${container.containerId}/dashboard`,'POST',{});if(popup){popup.opener=null;popup.location.replace(result.url);}else setError('请允许弹出工作台窗口后重试');}
    catch(error){popup?.close();setError(error instanceof Error?error.message:String(error));}
  };
  if(!ui.platformManaged)return <section className="page"><h1>平台管理未启用</h1><p>此部署保持原生 Botmux 模式。</p></section>;
  return <section className="page pm-page"><div className="page-heading"><div><p className="eyebrow">管理</p><h1>{title}</h1></div><div className="page-heading-actions">
    <RefreshIconButton label="刷新" busy={loading} onClick={()=>void refresh()}/>
    {page==='agents'?<><button onClick={()=>{setSelected(null);setModal('logins');}}>登录工作台</button><button onClick={()=>setModal('workspaces')}>工作区设置</button></>:null}
    {page==='bots'?<CreateActionButton onClick={()=>setModal('bot')}>新建 Bot</CreateActionButton>:page==='agents'?<CreateActionButton onClick={()=>{setSelected(null);setModal('container');}}>创建 Agent</CreateActionButton>:<CreateActionButton onClick={()=>{setModel(null);setCloneSourceId(null);setModal('model');}}>添加模型连接</CreateActionButton>}
  </div></div>
  {page==='bots'?<FeishuSessionPanel/>:null}
  {error?<p className="hint-warn" role="alert">{error}</p>:null}{notice?<p className="hint" role="status">{notice}</p>:null}
  {loading?<p>正在加载…</p>:page==='bots'?<>
    <div className="pm-bot-list-heading"><h2>机器人</h2><span>{data.bots.length} 个机器人</span></div>
    <div className="pm-table-wrap"><table><thead><tr><th>名称</th><th>App ID</th><th>凭证</th><th>使用情况</th><th>操作</th></tr></thead><tbody>{data.bots.map(bot=><tr key={bot.botId}><td>{bot.displayName}</td><td><code>{bot.appId}</code></td><td>{bot.secretConfigured?'已配置':'未配置'}</td><td>{bot.usage==='free'?<span className="pm-state">空闲</span>:bot.usage==='local'?'本地 Botmux':`Agent / ${bot.containerName}`}{bot.detachPending?<small className="hint-warn">摘除待同步，保留占用</small>:null}{bot.localDetachPending?<small className="hint-warn">本地解绑未完成，请重试</small>:null}</td><td>{bot.usage==='sandbox'?<><button disabled={bot.containerStatus!=='ready'||!bot.containerId} onClick={()=>{setSelectedBot(bot);setModal('unbind');}}>摘除绑定</button>{bot.detachPending?<a href="#/platform-agents">重试同步</a>:null}</>:bot.usage==='local'?<button disabled={!bot.localRevision} onClick={()=>{setSelectedBot(bot);setModal('unbind');}}>{bot.localDetachPending?'重试本地解绑':'解除本地绑定'}</button>:<span className="hint">—</span>}</td></tr>)}</tbody></table>{!data.bots.length?<p className="empty">暂无机器人</p>:null}</div>
  </>:page==='models'?<>
    <p className="hint">集中维护模型、服务地址和 API Key。保存连接不会自动修改已运行的 Agent；请到 <a href="#/platform-agents">Agent 管理</a> 切换模型或同步最新配置。</p>
    <h2>模型连接</h2><div className="pm-table-wrap"><table className="pm-model-table"><thead><tr><th>名称</th><th>Provider / 模型</th><th>认证 / 状态</th><th>操作</th></tr></thead><tbody>{data.models.map(m=><tr key={m.profileId}><td><CompactText text={m.displayName}/><small><CompactText text={m.protocol||'openai-completions'}/></small></td><td><CompactText text={m.provider}/><details><summary>{dynamicModel(m)?'原生动态模型':idsOf(m).length} 个模型 · 展开查看</summary>{idsOf(m).map(id=><small key={id}><CompactText text={`${dynamicModel(m)?'ZCode 自主管理模型列表':id}${!dynamicModel(m)&&id===m.modelId?'（默认）':''}`}/></small>)}</details></td><td>{m.authMethod==='oauth'?'实例内官方登录':m.apiKeyConfigured?'Key 已配置':'未配置'}<small>{m.enabled?'已启用':'已停用'}</small></td><td><AgentActions name={`${m.displayName}（${m.profileId}）`} actions={[
      {label:'编辑连接',run:()=>{setCloneSourceId(null);setModel(m);setModal('model');}},
      {label:'克隆',run:()=>clone(m)},
      {label:'删除',danger:true,run:()=>{setModel(m);setModal('delete-model');}},
    ]}/></td></tr>)}</tbody></table>{!data.models.length?<p className="empty">暂无模型连接</p>:null}</div><p className="hint">同一连接可配置多个模型 ID，共用地址、协议和凭据。Codex 使用 Responses，Claude Code 使用 Anthropic Messages；OAuth 请在 Agent 上直接选择原生登录。</p>
  </>:<>
    <LocalControlAgent models={data.models}/>
    <div className="pm-bot-list-heading"><h2>Agent 实例 <Parameter help="类型、镜像和挂载创建后固定；模型和机器人可修改并同步，执行任务期间不可修改。"> </Parameter></h2><span>{data.containers.length} 个实例</span></div>
    <div className="pm-table-wrap"><table className="pm-agent-table"><thead><tr><th>Agent / 镜像</th><th>认证 / 模型</th><th>机器人</th><th><Parameter help="已应用版本与目标版本一致时，容器已确认配置。模型管理更新连接后，在操作菜单同步配置。">同步状态</Parameter></th><th>操作</th></tr></thead><tbody>{data.containers.map(c=><tr key={c.containerId}><td><CompactText text={c.displayName}/><small><CompactText text={`${c.agentType} · ${c.image}`}/></small></td><td><CompactText text={c.modelName}/><small><CompactText text={c.modelId||"CLI 原生默认模型"}/></small></td><td><CompactText text={c.botName||'未绑定'}/></td><td><span className={`pm-status pm-status-${c.status}`}>{syncingId===c.containerId?'同步中…':labels[c.status]||c.status}</span><small data-tip={`已应用 ${c.appliedRevision} / 目标 ${c.revision}`}>版本 {c.appliedRevision} / {c.revision}</small>{c.lastError?<small className="hint-warn"><CompactText text={c.lastError}/></small>:null}</td><td><AgentActions name={c.displayName} disabled={!!syncingId} actions={[
      ...(c.runtimeKind==='native-botmux'?[{label:'打开 Agent 工作台',disabled:c.status!=='ready',run:()=>void openDashboard(c)},
        ...(c.agentType==='claude-code'||c.networkMode!=='unrestricted'?[{label:'出口规则',disabled:c.status!=='ready',run:()=>{setSelected(c);setModal('network');}}]:[]),
        ...(c.authMethod==='oauth'?[{label:'原生 OAuth 登录',disabled:c.status!=='ready',run:()=>{setSelected(c);setModal('logins');}}]:[])]:[]),
      {label:'修改模型 / 配置',run:()=>{setSelected(c);setModal('container');}},
      {label:'同步配置',disabled:c.status!=='ready',run:()=>void sync(c)},
      ...(c.status==='error'?[{label:'重试同步',run:()=>void mutate(`/containers/${c.containerId}/reconcile`,'POST',{})}]:[]),
      {label:'删除',danger:true,run:()=>{setSelected(c);setModal('delete');}},
    ]}/></td></tr>)}</tbody></table>{!data.containers.length?<p className="empty">暂无 Agent</p>:null}</div>
    <h2 className="pm-catalog-heading">支持的 Agent</h2><div className="pm-agent-list">{data.agents.map(agent=><details key={agent.id}><summary><span className="pm-agent-chevron" aria-hidden="true">›</span><strong>{agent.name}</strong><span className={agent.supported?'pm-state':'pm-catalog-muted'}>{agent.supported?'已支持':'待适配'}</span><span className="pm-catalog-version">{agent.version||'—'}</span></summary><div className="pm-agent-details"><p>{agent.supported?`${agent.authMethods?.includes('oauth')?'API Key / 原生 OAuth':'API Key'} · 支持切换兼容模型，下个任务生效`:'镜像、模型和认证能力验证完成后开放'}</p>{agent.images.map(image=><div className="pm-catalog-image" key={image.id}><span>{image.label}</span><CompactText text={image.image}/></div>)}</div></details>)}</div>
  </>}
  {modal==='bot'?<PlatformBotCreate api={platformApi} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='container'?<ContainerForm data={data} container={selected} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='model'?<ModelForm model={model} cloneSourceId={cloneSourceId} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='delete-model'&&model?<DeleteModel model={model} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='delete'&&selected?<DeleteContainer container={selected} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='unbind'&&selectedBot?(selectedBot.usage==='local'?<UnbindLocalBot bot={selectedBot} onClose={()=>setModal(null)} onDone={finish}/>:<UnbindBot bot={selectedBot} onClose={()=>setModal(null)} onDone={finish}/>):null}
  {modal==='workspaces'&&data.workspaceOptions?<WorkspaceSettings options={data.workspaceOptions} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='network'&&selected?<NetworkRules container={selected} onClose={()=>{setModal(null);void refresh();}}/>:null}
  {modal==='logins'?<LoginWorkbench container={selected} containers={data.containers.filter(c=>c.authMethod==='oauth')} onClose={()=>setModal(null)}/>:null}
  </section>;
}
export function WorkspaceSettings({options,onClose,onDone}:{options:WorkspaceOptions;onClose:()=>void;onDone:(m:string)=>void}){
  const [path,setPath]=useState(options.defaultHostPath||options.tenantHome||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const submitting=useRef(false);
  return <Modal title="工作区设置" onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{await platformApi('/workspaces','PUT',{defaultHostPath:path.trim()||null});onDone('默认 hostPath 已保存，仅影响以后创建 Agent 的预填路径。');}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}>
    <label><Parameter help={`创建 Agent 选择 hostPath 时自动填入。${options.hostPathMode==='unrestricted'?'不限制目录范围，使用 Docker 宿主机的绝对路径，实际可挂载性由 Docker 决定。':'目录需预先存在且位于批准根目录内。'}留空使用租户 home；设置保存在数据库，重启后保留。`}>默认 hostPath</Parameter><input name="defaultHostPath" value={path} onChange={e=>setPath(e.target.value)} disabled={busy||!options.hostPathEnabled} placeholder={options.tenantHome||'尚未启用 hostPath'}/></label>
    <p className="hint">仅设置默认目录，不修改现有 Agent，也不会挂载或暴露目录。</p>
    {options.hostPathMode==='unrestricted'?<p className="hint-warn">当前不限制目录范围。挂载时 Agent 可读取所选目录；读写模式还可修改或删除文件，请勿误选敏感目录。</p>:<div className="pm-approved-roots"><Parameter help="安全边界由部署配置 SANDBOX_ALLOWED_HOST_ROOTS 控制，未设置时使用 SANDBOX_TENANT_HOME。">批准的根目录（部署配置）</Parameter>{options.hostRoots.length?options.hostRoots.map(root=><code key={root}>{root}</code>):<p>未配置，hostPath 已禁用</p>}</div>}
    {error?<p role="alert" className="hint-warn">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy||!options.hostPathEnabled}>{busy?'保存中…':'保存设置'}</button></footer>
  </form></Modal>;
}
export function UnbindLocalBot({bot,onClose,onDone}:{bot:Bot;onClose:()=>void;onDone:(m:string)=>void}){
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');const submitting=useRef(false);
  return <Modal title="解除本地 Bot 绑定" onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(!confirmed||submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{const result=await platformApi(`/local-bots/${encodeURIComponent(bot.appId)}/unbind`,'POST',{localRevision:bot.localRevision,confirmLocalStop:true});
      if(result.released!==true)throw new Error('本地解绑尚未确认，请刷新后重试');onDone('本地 Agent 已停止，机器人已回到空闲池；飞书应用和数据保留。');
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}><p>将「{bot.displayName}」从本地 Botmux 解绑并移入空闲池。</p><p className="hint">保留飞书应用、凭据恢复副本、会话及工作区文件。解绑后不会随 Gateway 重启自动绑定本地。</p><label className="pm-check"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/><span>确认停止此机器人的本地 Agent，可能中断正在运行的任务。</span></label>{error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy||!confirmed}>{busy?'解绑中…':'确认停止并解绑'}</button></footer></form></Modal>;
}
export function UnbindBot({bot,onClose,onDone}:{bot:Bot;onClose:()=>void;onDone:(m:string)=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');const submitting=useRef(false);
  return <Modal title="摘除机器人绑定" onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{const result=await platformApi(`/bots/${encodeURIComponent(bot.botId)}/unbind`,'POST',{containerId:bot.containerId,revision:bot.containerRevision});const c=result.container;
      if(!c||c.containerId!==bot.containerId||c.botId!==null||c.status!=='ready'||c.revision!==c.appliedRevision||c.revision<=Number(bot.containerRevision))throw new Error('摘除未确认生效，请刷新状态；机器人暂不释放');
      onDone('机器人已摘除，容器解绑配置已同步；机器人返回空闲池。');
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}><p>将 {bot.displayName} 从 Agent「{bot.containerName}」摘除，并同步到对应容器。</p><p className="hint">容器确认无绑定后才返回空闲池。不会删除飞书应用、容器或数据；忙碌时请等待任务结束。</p>{error?<p role="alert" className="hint-warn">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy}>{busy?'同步解绑中…':'确认摘除并同步'}</button></footer></form></Modal>;
}
function DeleteContainer({container,onClose,onDone}:{container:Container;onClose:()=>void;onDone:(m:string)=>void}){
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <Modal title="删除 Agent 容器" onClose={onClose}><form onSubmit={async event=>{
    event.preventDefault();const data=new FormData(event.currentTarget);setBusy(true);
    try{const result=await platformApi(`/containers/${container.containerId}`,'DELETE',{revision:container.revision,cancelRunning:data.get('mode')==='cancel'});
      onDone(result.queued?'已登记删除请求，等待任务结束后自动删除':'已确认删除运行资源，数据卷保留');
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  }}><p>删除 {container.displayName}（{container.agentType}）。确认远端删除后才释放机器人 {container.botName||'（未绑定）'}。</p>
    <p className="hint">保留 /workspace、Agent state 和日志；不会删除飞书应用。</p>
    <label>正在执行的任务<select name="mode" defaultValue="wait"><option value="wait">等待任务结束后删除</option><option value="cancel">取消任务并删除（中断正在运行的进程）</option></select></label>
    <label>输入容器名确认<input required value={name} onChange={event=>setName(event.target.value)} placeholder={container.displayName}/></label>
    {error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>返回</button><button className="primary" disabled={busy||name!==container.displayName}>{busy?'删除中…':'确认删除'}</button></footer>
  </form></Modal>;
}
export function ContainerForm({data,container,onClose,onDone}:{data:Data;container:Container|null;onClose:()=>void;onDone:(m:string)=>void}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);const requestId=useRef(crypto.randomUUID());
  const [workspaceType,setWorkspaceType]=useState('volume'),[volumeSource,setVolumeSource]=useState(''),[readOnly,setReadOnly]=useState(false);
  const [agentType,setAgentType]=useState(container?.agentType||'pi');
  const [oauth,setOauth]=useState(container?.authMethod==='oauth');
  const agent=data.agents.find(a=>a.id===agentType);
  const compatible=(m:Model)=>container?.runtimeKind==='pi-rpc'?(m.protocol||'openai-completions')==='openai-completions'&&(m.authMethod||'api-key')==='api-key':
    (agent?.protocols||['openai-completions']).includes(m.protocol||'openai-completions')&&(agent?.authMethods||['api-key']).includes(m.authMethod||'api-key');
  const admitted=(m:Model)=>!container||container.networkMode==='unrestricted'||container.egressHosts.some(h=>h===new URL(m.baseUrl).hostname||h.startsWith('*.')&&new URL(m.baseUrl).hostname.endsWith(h.slice(1)));
  const workspaceOptions=data.workspaceOptions;
  const submit=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setBusy(true);setError('');const values=Object.fromEntries(new FormData(event.currentTarget));
    try{const [modelProfileId,chosen]=JSON.parse(String(values.modelSelection));
      const modelId=modelProfileId===null?String(values.oauthModelId||'').trim()||null:chosen;
      if(container){const observed=await syncAgentConfiguration(platformApi,container,modelProfileId,String(values.botId||'')||null,modelId);onDone(`Agent 模型与配置已同步（版本 ${observed.appliedRevision}），后续任务使用新配置。`);}
      else {const {modelSelection,oauthModelId,...fields}=values;await platformApi('/containers','POST',{...fields,modelProfileId,modelId,authMethod:modelProfileId===null?'oauth':'api-key',
        workspace:workspaceType==='hostpath'?'hostpath':volumeSource?'volume':'new',
        workspaceSource:workspaceType==='hostpath'?values.workspaceSource:volumeSource||undefined,
        workspaceReadOnly:readOnly,hostPathConfirmed:workspaceType==='hostpath'&&values.hostPathConfirmed==='on',requestId:requestId.current,agentType});onDone('Agent 已创建并完成运行握手');}}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  };
  return <Modal title={container?'Agent 配置':'创建 Agent'} onClose={onClose} busy={busy}><form onSubmit={submit}>
    <label><Parameter help="用于列表识别，创建后不可修改。最多 64 字符。">名称</Parameter><input name="displayName" defaultValue={container?.displayName||''} required maxLength={64} disabled={!!container}/></label>
    <label><Parameter help="Agent 类型和镜像在创建后固定。原生 Worker 保留飞书通信和工作台。">Agent</Parameter><select aria-label="Agent 类型" disabled={!!container} value={agentType} onChange={event=>{setAgentType(event.target.value);setOauth(false);}}>{data.agents.filter(a=>a.supported).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <label><Parameter help="每个 Worker 只预装所选 Agent，包含完整 Botmux；创建后不可切换镜像。">镜像</Parameter>{container?<input value={container.image} title={container.image} disabled/>:<select key={agentType} name="imageProfile" defaultValue="native">{agent?.images.filter(i=>i.id==='native').map(i=><option key={i.id} value={i.id}>{i.label} · {i.image}</option>)}</select>}</label>
    <p className="hint">{(container?container.networkMode==='unrestricted':agentType!=='claude-code')?'网络：直连，不限制出口；新建时不启用 egress sidecar。':'网络：启用 egress；创建后可在操作菜单管理出口规则。'}</p>
    <label><Parameter help="选择 Agent 支持的认证方式：原生 OAuth 不需要模型管理记录；API Key 模型按连接分组。">登录方式 / 模型</Parameter><select key={agentType} aria-label="登录方式 / 模型" name="modelSelection" defaultValue={container?JSON.stringify(container.authMethod==='oauth'?[null,null]:[container.modelProfileId,container.modelId??'']):''} onChange={e=>setOauth(JSON.parse(e.target.value)[0]===null)} required><option value="" disabled>选择原生登录或具体模型</option>{agent?.authMethods?.includes('oauth')?<option value={JSON.stringify([null,null])}>原生 OAuth 登录 · 无需模型连接</option>:null}{data.models.filter(m=>m.authMethod!=='oauth'&&(m.enabled||m.profileId===container?.modelProfileId)&&compatible(m)&&admitted(m)).map(m=><optgroup key={m.profileId} label={`${m.displayName} · ${m.provider}${!m.enabled?'（已停用）':''}`} disabled={!m.enabled}>{idsOf(m).map(id=><option key={id} value={JSON.stringify([m.profileId,id])}>{dynamicModel(m)?'原生动态模型（进入 ZCode /model 选择）':id}{!dynamicModel(m)&&id===m.modelId?' · 默认':''}</option>)}</optgroup>)}</select></label>
    {oauth?<><label><Parameter help="留空不固定模型，由原生 CLI 选择默认值；如需指定，可填写该账号实际支持的模型 ID。此项仅保存到此 Agent，不创建共享连接。">OAuth 模型（可选）</Parameter><input name="oauthModelId" maxLength={300} defaultValue={container?.authMethod==='oauth'?container.modelId||'':''} placeholder="使用 CLI 原生默认模型"/></label><p className="hint">创建完成后，在 Agent 操作菜单选择“原生 OAuth 登录”。凭据只保存在该 Worker；不会写入模型管理或复制到其他实例。</p></>:null}
    <label><Parameter help="可选择空闲机器人。选择“不绑定机器人”会同步解绑但保留容器，确认生效后机器人回到空闲池。">飞书机器人</Parameter><select name="botId" defaultValue={container?.botId||''}><option value="">不绑定机器人</option>{data.bots.filter(b=>b.usage==='free'||b.botId===container?.botId).map(b=><option key={b.botId} value={b.botId}>{b.displayName} · {b.appId}</option>)}</select></label>
    {container?<label><Parameter help="挂载创建后固定。更换挂载需新建 Agent，可复用历史目录或卷。">工作区</Parameter><input disabled title={container.workspaceClaim} value={`${container.workspaceKind||'volume'} · ${container.workspaceClaim}${container.workspaceReadOnly?'（只读）':''}`}/></label>:<>
      <label><Parameter help="先选择 /workspace 的存储类型，再选择具体数据卷或宿主机目录；与凭据 state 卷独立。">工作区类型</Parameter><select aria-label="工作区类型" value={workspaceType} onChange={e=>{setWorkspaceType(e.target.value);setReadOnly(e.target.value==='hostpath');}}><option value="volume">volume · Docker 数据卷</option><option value="hostpath" disabled={!workspaceOptions?.hostPathEnabled}>hostPath · 宿主机目录</option></select></label>
      {workspaceType==='volume'?<label><Parameter help="新建独立卷会创建新的文件空间；已有卷包含平台共享卷和历史使用过的卷。复用同一个卷即共享文件，不会复制一份。">数据卷</Parameter><select aria-label="数据卷" name="workspaceSource" value={volumeSource} onChange={e=>setVolumeSource(e.target.value)}><option value="">新建独立卷</option><optgroup label="已有 volume">{workspaceOptions?.workspaces?.filter(w=>w.kind==='volume').map(w=><option key={w.source} value={w.source}>{w.shared?'平台共享卷 · ':''}{w.source}{w.shared?'':` · 使用 ${w.useCount} 次`}</option>)}</optgroup></select></label>:null}
      <p className="hint pm-workspace-explanation">{workspaceType==='hostpath'?'直接挂载 Docker 宿主机目录到 /workspace，与宿主机共享文件。':!volumeSource?'创建新的 Docker 数据卷，文件独立；删除 Agent 后仍保留。':'复用已有卷和文件；多个 Agent 选择同一个卷即共享文件，请留意并发写入。'}</p>
      {workspaceType==='hostpath'?<><label><Parameter help={`${workspaceOptions?.hostPathMode==='unrestricted'?'不限制目录范围；填写 Docker 宿主机绝对路径，实际挂载权限由 Docker 决定。':`目录需预先存在。批准根目录：${workspaceOptions?.hostRoots.join('、')||'未配置'}。`}默认路径在“工作区设置”修改。`}>hostPath（可选历史目录）</Parameter><input name="workspaceSource" required list="pm-hostpath-history" defaultValue={workspaceOptions?.defaultHostPath||workspaceOptions?.tenantHome||''}/><datalist id="pm-hostpath-history">{workspaceOptions?.workspaces?.filter(w=>w.kind==='hostpath').map(w=><option key={w.source} value={w.source}/>)}</datalist></label><label className="pm-check"><input type="checkbox" name="hostPathConfirmed" required/><span>确认此目录将暴露给 Agent；读写模式下 Agent 可修改、删除该目录内容。</span></label></>:null}
      <label className="pm-check"><input type="checkbox" checked={readOnly} onChange={e=>setReadOnly(e.target.checked)}/><Parameter help="只读时 Agent 可以读取工作区但不能修改。hostPath 默认只读；关闭后允许修改或删除目录内容。">只读挂载 /workspace</Parameter></label>
    </>}
    {busy?<p className="hint" role="status">正在同步到 Agent，等待运行时确认…</p>:null}
    {error?<p role="alert" className="hint-warn">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>关闭</button><button type="submit" className="primary" disabled={busy||!!container&&container.status!=='ready'}>{busy?'同步中…':container?'保存并同步':'创建 Agent'}</button></footer>
  </form></Modal>;
}
export function DeleteModel({model,onClose,onDone}:{model:Model;onClose:()=>void;onDone:(m:string)=>void}){
  const [confirmId,setConfirmId]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),submitting=useRef(false);
  return <Modal title="删除模型连接" onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(confirmId!==model.profileId||submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{const result=await platformApi(`/models/${encodeURIComponent(model.profileId)}`,'DELETE',{});if(result.ok!==true)throw new Error('删除尚未确认，请刷新后重试');onDone('模型连接已删除，保存的 Key 已清除；历史记录保留。');}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}><p>确认删除「{model.displayName}」？将从模型列表移除并清除平台保存的 Key，不会删除 Agent、Bot 或任务数据。</p><p className="hint">仍被 Agent、Bot 或未完成 Workflow 引用时会拒绝删除。为保留历史关联，删除后的配置 ID 不可重新使用；此页面不支持恢复。</p><label>输入配置 ID 确认<input name="confirmProfileId" value={confirmId} onChange={e=>setConfirmId(e.target.value)} placeholder={model.profileId} disabled={busy} required/></label>{error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||confirmId!==model.profileId}>{busy?'删除中…':'确认删除'}</button></footer></form></Modal>;
}
export function ModelForm({model,cloneSourceId=null,onClose,onDone}:{model:Model|null;cloneSourceId?:string|null;onClose:()=>void;onDone:(m:string)=>void}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [protocol,setProtocol]=useState(model?.protocol||'openai-completions'),[baseUrl,setBaseUrl]=useState(model?.baseUrl||'');
  const authMethod='api-key',dynamic=protocol==='zcode-coding-plan';
  const submitting=useRef(false);
  return <Modal title={cloneSourceId?'克隆模型连接':model?'编辑模型连接':'添加模型连接'} onClose={onClose} busy={busy}><form onSubmit={async event=>{
    event.preventDefault();if(submitting.current)return;submitting.current=true;const value=Object.fromEntries(new FormData(event.currentTarget));setBusy(true);
    try{const modelIds=dynamic?[]:[...new Set(String(value.modelIds||'').split(/\r?\n/).map(id=>id.trim()).filter(Boolean))];
      if(!dynamic&&(!modelIds.length||modelIds.length>100))throw new Error('请填写 1–100 个模型 ID，每行一个');
      const payload={displayName:value.displayName,provider:dynamic?'zai':value.provider,baseUrl:dynamic?'https://api.z.ai':baseUrl,modelIds,modelId:dynamic?'':modelIds[0],enabled:value.enabled==='on',protocol,authMethod,...(authMethod==='api-key'&&value.apiKey?{apiKey:value.apiKey}:{})};
      if(cloneSourceId)await platformApi(`/models/${encodeURIComponent(cloneSourceId)}/clone`,'POST',{...payload,profileId:value.profileId});
      else await platformApi(`/models/${encodeURIComponent(String(value.profileId))}`,model?'PUT':'POST',payload);
      onDone(cloneSourceId?'模型连接副本已保存。':'模型连接已保存；现有 Agent 保留原模型，请到 Agent 管理切换或同步配置。');}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}
  }}>{cloneSourceId?<p className="hint">当前仅预填草稿，尚未创建记录。可修改配置 ID 和其它参数；取消不会写入数据库。Key 留空时，保存副本才复制来源的加密 Key，不回显原文。</p>:null}<label><Parameter help="唯一标识，仅支持字母、数字、点、下划线和连字符，创建后不可修改。新建和克隆不能覆盖已存在的 ID。">配置 ID</Parameter><input name="profileId" defaultValue={model?.profileId||''} required readOnly={!!model&&!cloneSourceId} maxLength={100} pattern="[A-Za-z0-9._-]+"/></label>
    <label><Parameter help="展示在模型连接列表和 Agent 的模型选择器中。">名称</Parameter><input name="displayName" defaultValue={model?.displayName||''} required/></label>
    {!dynamic?<label><Parameter help="Pi 使用的模型服务提供方标识，仅支持字母、数字、点、下划线和连字符。">Provider</Parameter><input name="provider" defaultValue={model?.provider||''} required={!dynamic} pattern="[A-Za-z0-9._-]+"/></label>:null}
    <label><Parameter help="Codex 要求 OpenAI Responses；Claude Code 要求 Anthropic Messages；Pi 支持这些协议，但具体服务端必须真的实现对应 API。">协议</Parameter><select name="protocol" value={protocol} onChange={e=>setProtocol(e.target.value)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="zcode-coding-plan">ZCode · Z.AI Coding Plan API Key</option></select></label>
    <p className="hint">{dynamic?'配置 Z.AI Coding Plan API Key 即可。模型列表与默认模型由 ZCode 原生维护，可进入终端用 /model 切换。':'这里只维护 API Key 模型连接。原生 OAuth 请直接在创建 Agent 时选择，无需预建连接。'}</p>
    {!dynamic?<label><Parameter help="模型服务的 API 基础地址，端点主机受容器网络策略限制。">Base URL</Parameter><input name="baseUrl" type="url" value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} required={!dynamic}/></label>:null}
    {!dynamic?<label><Parameter help="每行一个精确模型 ID，最多 100 个；空行忽略、重复去除。第一行为默认模型，不会改变已有 Agent 的选择。所有模型共用此连接的协议、地址和凭据。">模型 ID（每行一个）</Parameter><textarea name="modelIds" rows={5} defaultValue={model?idsOf(model).join('\n'):''} placeholder={'model-a\nmodel-b'} required={!dynamic}/></label>:null}
    <label className="pm-check"><input type="checkbox" name="enabled" defaultChecked={model?.enabled??true}/><span>启用此连接（克隆的副本默认停用）</span></label>
    <label><Parameter help="加密保存，不回显。编辑时留空保留原 Key；克隆时留空，在保存副本时复制来源 Key，也可以填写新 Key。">API Key</Parameter><input name="apiKey" type="password" autoComplete="new-password" placeholder={cloneSourceId?'留空在保存时复制来源 Key':model?'留空保留现有 Key':''} required={!model?.apiKeyConfigured}/></label>{error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy}>{cloneSourceId?'保存副本':'保存连接'}</button></footer></form></Modal>;
}
export function renderBotsPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="bots"/>);}
export function renderModelsPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="models"/>);}
export function renderAgentsPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="agents"/>);}
