import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { mountReactPage } from '../react-mount.js';
import { ui } from '../ui.js';
import { CreateActionButton, RefreshIconButton } from '../dashboard-components.js';

type Bot={botId:string;displayName:string;appId:string;usage:'local'|'free'|'sandbox';containerName?:string;secretConfigured:boolean};
type Model={profileId:string;displayName:string;provider:string;baseUrl:string;modelId:string;apiKeyConfigured:boolean;enabled:boolean};
type Container={containerId:string;displayName:string;agentType:string;image:string;sandboxId:string|null;modelProfileId:string;modelName:string;modelId:string;
  status:string;revision:number;appliedRevision:number;egressHosts:string[];botId:string|null;botName:string|null;workspaceClaim:string;stateClaim:string;lastError:string|null};
type Agent={id:string;name:string;supported:boolean;version:string|null;images:Array<{id:string;image:string;label:string}>};
type Data={bots:Bot[];models:Model[];containers:Container[];agents:Agent[]};
type Job={id:string;status:string;appId?:string;appName?:string;qrDataUrl?:string;platformQrDataUrl?:string;message?:string;permissionStatusMsg?:string;error?:string;liveStarted?:boolean;liveStartMessage?:string};
const initial:Data={bots:[],models:[],containers:[],agents:[]};
const labels:Record<string,string>={creating:'配置中',ready:'就绪',error:'异常',deleting:'删除待确认',deleted:'已删除'};
export async function platformApi(path:string,method='GET',body?:unknown){
  const response=await fetch(`/api/platform${path}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();if(!response.ok)throw new Error(result.message||result.error||`HTTP ${response.status}`);return result;
}
function Modal({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{ref.current?.showModal();},[]);
  return <dialog ref={ref} className="pm-dialog" onCancel={e=>{e.preventDefault();onClose();}}><header><h2>{title}</h2><button type="button" onClick={onClose} aria-label="关闭">×</button></header>{children}</dialog>;
}
function ManagementPage({page}:{page:'bots'|'agents'|'sandbox'}){
  const [data,setData]=useState<Data>(initial),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
  const [modal,setModal]=useState<'bot'|'container'|'model'|'delete'|null>(null),[selected,setSelected]=useState<Container|null>(null),[model,setModel]=useState<Model|null>(null);
  const mounted=useRef(true);
  const refresh=async()=>{
    try{const [bots,models,containers,catalog]=await Promise.all(['/bots','/models','/containers','/catalog'].map(p=>platformApi(p)));
      if(mounted.current){setData({bots:bots.bots,models:models.models,containers:containers.containers,agents:catalog.agents});setError('');}}
    catch(error){if(mounted.current)setError(String(error instanceof Error?error.message:error));}
    finally{if(mounted.current)setLoading(false);}
  };
  useEffect(()=>{mounted.current=true;void refresh();const timer=setInterval(()=>void refresh(),10000);return()=>{mounted.current=false;clearInterval(timer);};},[]);
  const title=page==='bots'?'Bot 管理':page==='agents'?'Agent 管理':'OpenSandbox';
  const finish=(message:string)=>{setModal(null);setNotice(message);void refresh();};
  const mutate=async(path:string,method:string,body?:unknown)=>{
    try{await platformApi(path,method,body);setNotice('操作完成');await refresh();}catch(error){setError(error instanceof Error?error.message:String(error));}
  };
  if(!ui.platformManaged)return <section className="page"><h1>平台管理未启用</h1><p>此部署保持原生 Botmux 模式。</p></section>;
  return <section className="page pm-page"><div className="page-heading"><div><p className="eyebrow">管理</p><h1>{title}</h1></div><div className="page-heading-actions">
    <RefreshIconButton label="刷新" busy={loading} onClick={()=>void refresh()}/>
    {page==='bots'?<CreateActionButton onClick={()=>setModal('bot')}>新建 Bot</CreateActionButton>:page==='sandbox'?<CreateActionButton onClick={()=>{setSelected(null);setModal('container');}}>创建容器</CreateActionButton>:<CreateActionButton onClick={()=>{setModel(null);setModal('model');}}>添加模型连接</CreateActionButton>}
  </div></div>
  {error?<p className="hint-warn" role="alert">{error}</p>:null}{notice?<p className="hint" role="status">{notice}</p>:null}
  {loading?<p>正在加载…</p>:page==='bots'?<>
    <p className="hint">统一创建飞书机器人。空闲身份可分配给 OpenSandbox，本地机器人继续在原生 Bot 配置页管理。</p>
    <div className="pm-table-wrap"><table><thead><tr><th>名称</th><th>App ID</th><th>凭证</th><th>使用情况</th></tr></thead><tbody>{data.bots.map(bot=><tr key={bot.botId}><td>{bot.displayName}</td><td><code>{bot.appId}</code></td><td>{bot.secretConfigured?'已配置':'未配置'}</td><td>{bot.usage==='free'?<span className="pm-state">空闲</span>:bot.usage==='local'?'本地 Botmux':`OpenSandbox / ${bot.containerName}`}</td></tr>)}</tbody></table>{!data.bots.length?<p className="empty">暂无机器人</p>:null}</div>
  </>:page==='agents'?<>
    <div className="pm-agent-list">{data.agents.map(agent=><article key={agent.id}><h2>{agent.name} <small>{agent.supported?agent.version:'待适配'}</small></h2><p>{agent.supported?'API Key · OpenAI Chat Completions · 下一轮生效':'镜像、模型和认证能力验证完成后开放'}</p>{agent.images.map(image=><code key={image.id}>{image.image} </code>)}</article>)}</div>
    <h2>模型连接</h2><div className="pm-table-wrap"><table><thead><tr><th>名称</th><th>Provider / 模型</th><th>认证</th><th>操作</th></tr></thead><tbody>{data.models.map(m=><tr key={m.profileId}><td>{m.displayName}<small>{m.enabled?'已启用':'已停用'}</small></td><td>{m.provider}<small>{m.modelId}</small></td><td>{m.apiKeyConfigured?'Key 已配置':'未配置'}</td><td><button onClick={()=>{setModel(m);setModal('model');}}>编辑连接</button></td></tr>)}</tbody></table></div><p className="hint">官方账号登录尚未适配，不提供不可用的 OAuth 选项。Agent 实例在 OpenSandbox 页面管理。</p>
  </>:<>
    <p className="hint">一个容器运行一种 Agent。创建后 Agent 与镜像固定，可更换模型及绑定机器人。</p>
    <div className="pm-table-wrap"><table><thead><tr><th>容器 / Agent</th><th>模型</th><th>机器人</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.containers.map(c=><tr key={c.containerId}><td>{c.displayName}<small>{c.agentType} · {c.image}</small></td><td>{c.modelName}<small>{c.modelId}</small></td><td>{c.botName||'未绑定'}</td><td>{labels[c.status]||c.status}<small>配置 {c.appliedRevision}/{c.revision}</small>{c.lastError?<small className="hint-warn">{c.lastError}</small>:null}</td><td><div className="pm-actions"><button onClick={()=>{setSelected(c);setModal('container');}}>详情</button>{c.status!=='ready'?<button onClick={()=>void mutate(`/containers/${c.containerId}/reconcile`,'POST',{})}>重试</button>:null}<button onClick={()=>{setSelected(c);setModal('delete');}}>删除</button></div></td></tr>)}</tbody></table>{!data.containers.length?<p className="empty">暂无 Agent 容器</p>:null}</div>
  </>}
  {modal==='bot'?<BotCreate onClose={()=>setModal(null)} onDone={finish}/>:null}
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
function ContainerForm({data,container,onClose,onDone}:{data:Data;container:Container|null;onClose:()=>void;onDone:(m:string)=>void}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);const requestId=useRef(crypto.randomUUID());
  const submit=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setBusy(true);setError('');const values=Object.fromEntries(new FormData(event.currentTarget));
    try{if(container)await platformApi(`/containers/${container.containerId}`,'PUT',{revision:container.revision,modelProfileId:values.modelProfileId,botId:values.botId||null});
      else await platformApi('/containers','POST',{...values,requestId:requestId.current,agentType:'pi'});onDone(container?'容器配置已应用':'容器已创建并完成运行握手');}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  };
  return <Modal title={container?'容器详情':'创建 Agent 容器'} onClose={onClose}><form onSubmit={submit}>
    <label>名称<input name="displayName" defaultValue={container?.displayName||''} required maxLength={64} disabled={!!container}/></label>
    <label>Agent<input value="Pi" disabled/></label>
    <label>镜像{container?<input value={container.image} disabled/>:<select name="imageProfile" defaultValue="runtime">{data.agents.find(a=>a.id==='pi')?.images.map(i=><option key={i.id} value={i.id}>{i.label} · {i.image}</option>)}</select>}</label>
    <label>模型<select name="modelProfileId" defaultValue={container?.modelProfileId||''} required><option value="" disabled>选择兼容的模型连接</option>{data.models.filter(m=>m.enabled&&(!container||container.egressHosts.includes(new URL(m.baseUrl).hostname))).map(m=><option key={m.profileId} value={m.profileId}>{m.displayName} / {m.modelId}</option>)}</select></label>
    <label>飞书机器人<select name="botId" defaultValue={container?.botId||''}><option value="">不绑定机器人</option>{data.bots.filter(b=>b.usage==='free'||b.botId===container?.botId).map(b=><option key={b.botId} value={b.botId}>{b.displayName} · {b.appId}</option>)}</select></label>
    {container?<><label>工作区<input disabled value={container.workspaceClaim}/></label><p className="hint">Agent / 镜像不可修改。解绑只需选择“不绑定机器人”，容器会保留。</p></>:<label>工作区<select name="workspace" defaultValue="new"><option value="new">创建独立持久化工作区</option><option value="shared">使用平台共享 /workspace</option></select></label>}
    <p className="hint">{busy?'正在调用 OpenSandbox，请等待。失败时保留记录，可在列表重试。':'模型变更不会删除容器；运行任务期间不允许修改。'}</p>
    {error?<p role="alert" className="hint-warn">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>关闭</button><button type="submit" className="primary" disabled={busy||!!container&&container.status!=='ready'}>{busy?'处理中…':container?'保存配置':'创建容器'}</button></footer>
  </form></Modal>;
}
function ModelForm({model,onClose,onDone}:{model:Model|null;onClose:()=>void;onDone:(m:string)=>void}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <Modal title={model?'编辑模型连接':'添加模型连接'} onClose={onClose}><form onSubmit={async event=>{
    event.preventDefault();const value=Object.fromEntries(new FormData(event.currentTarget));setBusy(true);
    try{await platformApi(`/models/${encodeURIComponent(String(value.profileId))}`,'PUT',{displayName:value.displayName,provider:value.provider,baseUrl:value.baseUrl,modelId:value.modelId,...(value.apiKey?{apiKey:value.apiKey}:{})});onDone('模型连接已保存；已有容器需在详情中应用新配置');}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  }}><label>配置 ID<input name="profileId" defaultValue={model?.profileId||''} required readOnly={!!model} pattern="[A-Za-z0-9._-]+"/></label><label>名称<input name="displayName" defaultValue={model?.displayName||''} required/></label><label>Provider<input name="provider" defaultValue={model?.provider||''} required pattern="[A-Za-z0-9._-]+"/></label><label>协议<input value="OpenAI Chat Completions" disabled/></label><label>Base URL<input name="baseUrl" type="url" defaultValue={model?.baseUrl||''} required/></label><label>模型 ID<input name="modelId" defaultValue={model?.modelId||''} required/></label><label>API Key<input name="apiKey" type="password" autoComplete="new-password" placeholder={model?'留空保留现有 Key':''} required={!model}/></label>{error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy}>保存连接</button></footer></form></Modal>;
}
function BotCreate({onClose,onDone}:{onClose:()=>void;onDone:(m:string)=>void}){
  const [job,setJob]=useState<Job|null>(null),[target,setTarget]=useState('pool'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(!job||['completed','failed','needs_owner'].includes(job.status))return;
    let cancelled=false;const timer=setInterval(()=>{void platformApi(`/onboarding/${target}/${job.id}`).then(data=>{if(!cancelled)setJob(data.job);}).catch(error=>{if(!cancelled)setError(error.message);});},1500);
    return()=>{cancelled=true;clearInterval(timer);};},[job?.id,job?.status,target]);
  return <Modal title="新建飞书机器人" onClose={onClose}>{!job?<form onSubmit={async event=>{
    event.preventDefault();const input=Object.fromEntries(new FormData(event.currentTarget));setBusy(true);setError('');
    try{const result=await platformApi('/onboarding','POST',{name:input.name,target});setJob(result.job);}catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  }}><label>机器人名称<input name="name" required maxLength={64}/></label><label>用途<select value={target} onChange={event=>setTarget(event.target.value)}><option value="pool">加入空闲池，供 OpenSandbox 分配</option><option value="local">用于本地 Botmux</option></select></label><p className="hint">扫码后按统一模板创建、配置并发布飞书应用。此操作会创建真实应用。</p>{error?<p role="alert" className="hint-warn">{error}</p>:null}<footer><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy?'提交中…':'创建并扫码授权'}</button></footer></form>:<>
    <p>{job.permissionStatusMsg||job.message||job.status}</p>{job.qrDataUrl?<img className="pm-qr" src={job.qrDataUrl} alt="飞书创建授权二维码"/>:null}{job.platformQrDataUrl?<img className="pm-qr" src={job.platformQrDataUrl} alt="飞书开放平台授权二维码"/>:null}
    {job.appId?<p>App ID：<code>{job.appId}</code></p>:null}
    {job.status==='needs_owner'?<form onSubmit={async event=>{event.preventDefault();const entries=String(new FormData(event.currentTarget).get('owner')).split(/[\s,]+/).filter(Boolean);try{const result=await platformApi(`/onboarding/${target}/${job.id}/owner`,'POST',{entries});setJob(result.job);}catch(error){setError(error instanceof Error?error.message:String(error));}}}><label>确认应用所有者<input name="owner" required placeholder="企业邮箱、手机号或此应用可验证的身份"/></label><button>验证并完成</button></form>:null}
    {job.status==='completed'?<><p>{target==='pool'?'应用创建已完成。机器人入池后不会启动本地 Agent。':'本地机器人配置已创建，可在数字员工 → Bot 配置查看。'}</p>{target==='pool'?<button onClick={async()=>{try{await platformApi(`/onboarding/pool/${job.id}/register`,'POST',{});onDone('机器人已进入空闲池');}catch(error){setError(error instanceof Error?error.message:String(error));}}}>确认入池并关闭</button>:<button onClick={()=>onDone('本地机器人已创建')}>完成</button>}</>:null}
    {job.status==='failed'?<p className="hint-warn">{job.error}。{job.appId?'应用已创建，请保留 App ID，先排查权限配置；不要重复新建。':''}</p>:null}
    {error?<p role="alert" className="hint-warn">{error}</p>:null}<footer><button onClick={onClose}>关闭</button></footer>
  </>}</Modal>;
}
export function renderBotsPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="bots"/>);}
export function renderAgentsPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="agents"/>);}
export function renderSandboxPage(root:HTMLElement){return mountReactPage(root,<ManagementPage page="sandbox"/>);}
