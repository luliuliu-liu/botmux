import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { mountReactPage } from '../react-mount.js';
import { ui } from '../ui.js';
import { CreateActionButton, RefreshIconButton } from '../dashboard-components.js';
import { FeishuSessionPanel } from './feishu-session-panel.js';
import { PlatformBotCreate } from './bot-create.js';
import { syncAgentConfiguration } from './agent-configuration.js';

type Bot={botId:string;displayName:string;appId:string;usage:'local'|'free'|'sandbox';containerName?:string;secretConfigured:boolean};
type Model={profileId:string;displayName:string;provider:string;baseUrl:string;modelId:string;apiKeyConfigured:boolean;enabled:boolean};
type Container={containerId:string;displayName:string;agentType:string;image:string;sandboxId:string|null;modelProfileId:string;modelName:string;modelId:string;
  status:string;revision:number;appliedRevision:number;egressHosts:string[];botId:string|null;botName:string|null;workspaceClaim:string;stateClaim:string;lastError:string|null};
type Agent={id:string;name:string;supported:boolean;version:string|null;images:Array<{id:string;image:string;label:string}>};
type Data={bots:Bot[];models:Model[];containers:Container[];agents:Agent[]};
const initial:Data={bots:[],models:[],containers:[],agents:[]};
const labels:Record<string,string>={creating:'配置中',ready:'就绪',error:'异常',deleting:'删除待确认',deleted:'已删除'};
export async function platformApi(path:string,method='GET',body?:unknown){
  const response=await fetch(`/api/platform${path}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();if(!response.ok)throw new Error(result.message||result.error||`HTTP ${response.status}`);return result;
}
function Modal({title,children,onClose,busy=false}:{title:string;children:ReactNode;onClose:()=>void;busy?:boolean}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{ref.current?.showModal();},[]);
  return <dialog ref={ref} className="pm-dialog" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}><header><h2>{title}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="关闭">×</button></header>{children}</dialog>;
}
export function ManagementPage({page}:{page:'bots'|'models'|'agents'}){
  const [data,setData]=useState<Data>(initial),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
  const [modal,setModal]=useState<'bot'|'container'|'model'|'delete'|null>(null),[selected,setSelected]=useState<Container|null>(null),[model,setModel]=useState<Model|null>(null);
  const mounted=useRef(true);
  const syncing=useRef(false),[syncingId,setSyncingId]=useState<string|null>(null);
  const refresh=async()=>{
    try{const [bots,models,containers,catalog]=await Promise.all(['/bots','/models','/containers','/catalog'].map(p=>platformApi(p)));
      if(mounted.current){setData({bots:bots.bots,models:models.models,containers:containers.containers,agents:catalog.agents});setError('');}}
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
  if(!ui.platformManaged)return <section className="page"><h1>平台管理未启用</h1><p>此部署保持原生 Botmux 模式。</p></section>;
  return <section className="page pm-page"><div className="page-heading"><div><p className="eyebrow">管理</p><h1>{title}</h1></div><div className="page-heading-actions">
    <RefreshIconButton label="刷新" busy={loading} onClick={()=>void refresh()}/>
    {page==='bots'?<CreateActionButton onClick={()=>setModal('bot')}>新建 Bot</CreateActionButton>:page==='agents'?<CreateActionButton onClick={()=>{setSelected(null);setModal('container');}}>创建 Agent</CreateActionButton>:<CreateActionButton onClick={()=>{setModel(null);setModal('model');}}>添加模型连接</CreateActionButton>}
  </div></div>
  {page==='bots'?<FeishuSessionPanel/>:null}
  {error?<p className="hint-warn" role="alert">{error}</p>:null}{notice?<p className="hint" role="status">{notice}</p>:null}
  {loading?<p>正在加载…</p>:page==='bots'?<>
    <div className="pm-bot-list-heading"><h2>机器人</h2><span>{data.bots.length} 个机器人</span></div>
    <div className="pm-table-wrap"><table><thead><tr><th>名称</th><th>App ID</th><th>凭证</th><th>使用情况</th></tr></thead><tbody>{data.bots.map(bot=><tr key={bot.botId}><td>{bot.displayName}</td><td><code>{bot.appId}</code></td><td>{bot.secretConfigured?'已配置':'未配置'}</td><td>{bot.usage==='free'?<span className="pm-state">空闲</span>:bot.usage==='local'?'本地 Botmux':`Agent / ${bot.containerName}`}</td></tr>)}</tbody></table>{!data.bots.length?<p className="empty">暂无机器人</p>:null}</div>
  </>:page==='models'?<>
    <p className="hint">集中维护模型、服务地址和 API Key。保存连接不会自动修改已运行的 Agent；请到 <a href="#/platform-agents">Agent 管理</a> 切换模型或同步最新配置。</p>
    <h2>模型连接</h2><div className="pm-table-wrap"><table><thead><tr><th>名称</th><th>Provider / 模型</th><th>认证</th><th>操作</th></tr></thead><tbody>{data.models.map(m=><tr key={m.profileId}><td>{m.displayName}<small>{m.enabled?'已启用':'已停用'}</small></td><td>{m.provider}<small>{m.modelId}</small></td><td>{m.apiKeyConfigured?'Key 已配置':'未配置'}</td><td><button onClick={()=>{setModel(m);setModal('model');}}>编辑连接</button></td></tr>)}</tbody></table>{!data.models.length?<p className="empty">暂无模型连接</p>:null}</div><p className="hint">当前支持 API Key · OpenAI Chat Completions；官方账号登录尚未适配。</p>
  </>:<>
    <p className="hint">Agent 运行在 OpenSandbox 隔离容器中，类型与镜像固定，可修改模型及绑定机器人。<a href="#/platform-models">模型管理</a> 更新连接后，可在此同步配置；运行任务期间不允许修改。</p>
    <div className="pm-table-wrap"><table><thead><tr><th>Agent / 镜像</th><th>目标模型连接</th><th>机器人</th><th>同步状态</th><th>操作</th></tr></thead><tbody>{data.containers.map(c=><tr key={c.containerId}><td>{c.displayName}<small>{c.agentType} · {c.image}</small></td><td>{c.modelName}<small>{c.modelId}</small></td><td>{c.botName||'未绑定'}</td><td>{syncingId===c.containerId?'同步中…':labels[c.status]||c.status}<small>已应用 {c.appliedRevision} / 目标 {c.revision}</small>{c.lastError?<small className="hint-warn">{c.lastError}</small>:null}</td><td><div className="pm-actions"><button disabled={!!syncingId} onClick={()=>{setSelected(c);setModal('container');}}>修改模型 / 配置</button><button disabled={!!syncingId||c.status!=='ready'} onClick={()=>void sync(c)}>{syncingId===c.containerId?'同步中…':'同步配置'}</button>{c.status==='error'?<button disabled={!!syncingId} onClick={()=>void mutate(`/containers/${c.containerId}/reconcile`,'POST',{})}>重试同步</button>:null}<button disabled={!!syncingId} onClick={()=>{setSelected(c);setModal('delete');}}>删除</button></div></td></tr>)}</tbody></table>{!data.containers.length?<p className="empty">暂无 Agent</p>:null}</div>
    <h2>支持的 Agent</h2><div className="pm-agent-list">{data.agents.map(agent=><article key={agent.id}><h2>{agent.name} <small>{agent.supported?agent.version:'待适配'}</small></h2><p>{agent.supported?'API Key · 可切换兼容模型':'镜像、模型和认证能力验证完成后开放'}</p>{agent.images.map(image=><code key={image.id}>{image.image} </code>)}</article>)}</div>
  </>}
  {modal==='bot'?<PlatformBotCreate api={platformApi} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='container'?<ContainerForm data={data} container={selected} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='model'?<ModelForm model={model} onClose={()=>setModal(null)} onDone={finish}/>:null}
  {modal==='delete'&&selected?<DeleteContainer container={selected} onClose={()=>setModal(null)} onDone={finish}/>:null}
  </section>;
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
  const submit=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setBusy(true);setError('');const values=Object.fromEntries(new FormData(event.currentTarget));
    try{if(container){const observed=await syncAgentConfiguration(platformApi,container,String(values.modelProfileId),String(values.botId||'')||null);onDone(`Agent 模型与配置已同步（版本 ${observed.appliedRevision}），后续任务使用新配置。`);}
      else {await platformApi('/containers','POST',{...values,requestId:requestId.current,agentType:'pi'});onDone('Agent 已创建并完成运行握手');}}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  };
  return <Modal title={container?'Agent 配置':'创建 Agent'} onClose={onClose} busy={busy}><form onSubmit={submit}>
    <label>名称<input name="displayName" defaultValue={container?.displayName||''} required maxLength={64} disabled={!!container}/></label>
    <label>Agent<input value="Pi" disabled/></label>
    <label>镜像{container?<input value={container.image} disabled/>:<select name="imageProfile" defaultValue="runtime">{data.agents.find(a=>a.id==='pi')?.images.map(i=><option key={i.id} value={i.id}>{i.label} · {i.image}</option>)}</select>}</label>
    <label>模型<select name="modelProfileId" defaultValue={container?.modelProfileId||''} required><option value="" disabled>选择兼容的模型连接</option>{data.models.filter(m=>m.enabled&&(!container||container.egressHosts.includes(new URL(m.baseUrl).hostname))).map(m=><option key={m.profileId} value={m.profileId}>{m.displayName} / {m.modelId}</option>)}</select></label>
    <label>飞书机器人<select name="botId" defaultValue={container?.botId||''}><option value="">不绑定机器人</option>{data.bots.filter(b=>b.usage==='free'||b.botId===container?.botId).map(b=><option key={b.botId} value={b.botId}>{b.displayName} · {b.appId}</option>)}</select></label>
    {container?<><label>工作区<input disabled value={container.workspaceClaim}/></label><p className="hint">Agent / 镜像不可修改。解绑只需选择“不绑定机器人”，容器会保留。</p></>:<label>工作区<select name="workspace" defaultValue="new"><option value="new">创建独立持久化工作区</option><option value="shared">使用平台共享 /workspace</option></select></label>}
    <p className="hint">模型来自 <a href="#/platform-models">模型管理</a>；只可选择容器网络范围内已启用的模型。新增端点主机需要新建 Agent。</p>
    <p className="hint">{busy?'正在同步到 Agent，等待运行时确认。失败时保留记录，可在列表重试同步。':'保存会同步模型、地址与 API Key 到 Agent；同一连接的更新也可重新同步。不会删除容器或打断运行中的任务。'}</p>
    {error?<p role="alert" className="hint-warn">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>关闭</button><button type="submit" className="primary" disabled={busy||!!container&&container.status!=='ready'}>{busy?'同步中…':container?'保存并同步':'创建 Agent'}</button></footer>
  </form></Modal>;
}
function ModelForm({model,onClose,onDone}:{model:Model|null;onClose:()=>void;onDone:(m:string)=>void}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <Modal title={model?'编辑模型连接':'添加模型连接'} onClose={onClose}><form onSubmit={async event=>{
    event.preventDefault();const value=Object.fromEntries(new FormData(event.currentTarget));setBusy(true);
    try{await platformApi(`/models/${encodeURIComponent(String(value.profileId))}`,'PUT',{displayName:value.displayName,provider:value.provider,baseUrl:value.baseUrl,modelId:value.modelId,...(value.apiKey?{apiKey:value.apiKey}:{})});onDone('模型连接已保存；请到 Agent 管理同步配置，或切换到此模型。');}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  }}><label>配置 ID<input name="profileId" defaultValue={model?.profileId||''} required readOnly={!!model} pattern="[A-Za-z0-9._-]+"/></label><label>名称<input name="displayName" defaultValue={model?.displayName||''} required/></label><label>Provider<input name="provider" defaultValue={model?.provider||''} required pattern="[A-Za-z0-9._-]+"/></label><label>协议<input value="OpenAI Chat Completions" disabled/></label><label>Base URL<input name="baseUrl" type="url" defaultValue={model?.baseUrl||''} required/></label><label>模型 ID<input name="modelId" defaultValue={model?.modelId||''} required/></label><label>API Key<input name="apiKey" type="password" autoComplete="new-password" placeholder={model?'留空保留现有 Key':''} required={!model}/></label>{error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy}>保存连接</button></footer></form></Modal>;
}
export function renderBotsPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="bots"/>);}
export function renderModelsPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="models"/>);}
export function renderAgentsPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="agents"/>);}
