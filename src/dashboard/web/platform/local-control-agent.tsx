import {ConfigureAgent} from './configure-agent.js';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Modal,platformApi} from './management-page.js';
import {AgentActions,CompactText,Parameter,ConfigHelp} from './compact-controls.js';
import {hostFirst,imageOptionLabel} from './image-utils.js';
import {CliLoginDialog} from './cli-logins.js';
import {idsOf,modelGroupLabel,modelOptionLabel,type ModelOption} from './model-options.js';
import {newPlatformRequestId} from './request-id.js';
type Model=ModelOption&{apiKeyConfigured:boolean};
type Agent={agentType:string;revision:number;appliedRevision:number;requestId?:string;authMethod:string;modelProfileId:string|null;modelId:string;currentModel:string|null;modelName:string|null;credentialPresent:boolean;credentialKind?:'api-key'|'oauth'|'native';status:string;requiresLogin?:boolean};
type Bot={appId:string;displayName:string;cliId:string};
type Local={name:string;controlId:string;agents:Agent[];bots:Bot[]};
const names:Record<string,string>={pi:'Pi',codex:'Codex','claude-code':'Claude Code',zcode:'ZCode'};
const protocols:Record<string,string[]>={pi:['openai-completions','openai-responses','anthropic-messages'],codex:['openai-responses'],'claude-code':['anthropic-messages','vercel-claude'],zcode:['zcode-coding-plan']};
function ControlUpgrade({onClose}:{onClose:()=>void}){
 const [images,setImages]=useState<any[]>([]),[hostArch,setHostArch]=useState<string|undefined>(),[image,setImage]=useState(''),[state,setState]=useState<any>(),[confirm,setConfirm]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{void Promise.all([platformApi('/images'),platformApi('/control-upgrade')]).then(([inventory,status])=>{setImages(inventory.images.filter((item:any)=>item.roles.includes('control')));setHostArch(inventory.hostArch);setState(status);}).catch(e=>setError(String(e)));},[]);
 const submit=async(rollback=false)=>{setBusy(true);try{await platformApi('/control-upgrade','POST',{image,rollback,confirmRestart:confirm});setState({status:'queued'});setError('');}catch(e){setError(String(e));}finally{setBusy(false);}};
 return <Modal title="Dev Agent 镜像升级" onClose={onClose} busy={busy}><ConfigHelp>升级期间工作台短暂断开，重连后使用新镜像。保留 state、workspace 和 Docker 配置，失败自动恢复旧容器。</ConfigHelp><label>本地兼容镜像<select value={image} onChange={e=>setImage(e.target.value)}><option value="">选择已缓存的 Dev Agent 镜像</option>{hostFirst(images,hostArch).map(item=>{const foreign=!!item.architecture&&!!hostArch&&item.architecture!==hostArch;return <option key={item.id} value={item.id} disabled={foreign}>{imageOptionLabel(item.tags,item.id,item.architecture,hostArch)}</option>;})}</select></label><label className="pm-check"><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/><span>确认重启空闲 Dev Agent</span></label><footer><button onClick={onClose} disabled={busy}>关闭</button><button className="primary" disabled={busy||!confirm||!image||state?.status==='queued'} onClick={()=>void submit()}>升级</button>{state?.previousImage?<button disabled={busy||!confirm} onClick={()=>void submit(true)}>回滚</button>:null}</footer>{state?.status==='queued'?<p role="status">升级已排队，请稍后刷新页面查看结果。</p>:null}{state?.error?<p role="alert">{state.error}</p>:null}{error?<p role="alert">{error}</p>:null}</Modal>;
}
export function LocalControlAgent({models}:{models:Model[]}){
 const [state,setState]=useState<Local|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[selected,setSelected]=useState<Agent|null>(null),[login,setLogin]=useState<Agent|null>(null);
 const live=useRef(true);
 const [panel,setPanel]=useState<'configure'|'upgrade'|'cli-login'|null>(null),[overview,setOverview]=useState<any>();
 const refresh=async()=>{try{const [value,proxy,upgrade,proxies]=await Promise.all([platformApi('/local-agent'),platformApi('/control-proxy'),platformApi('/control-upgrade'),platformApi('/proxies')]);if(!Array.isArray(value.agents)||!Array.isArray(value.bots))throw Error('本地 Agent 状态格式无效');if(live.current){setState(value);setOverview({proxy,upgrade,proxyName:proxies.proxies.find((p:any)=>p.profileId===proxy.proxyProfileId)?.displayName});setError('');}}catch(e){if(live.current)setError(e instanceof Error?e.message:String(e));}};
 useEffect(()=>{live.current=true;const manual=()=>void refresh();if(typeof window!=='undefined')window.addEventListener('platform-management-refresh',manual);void refresh();const timer=setInterval(()=>void refresh(),10000);return()=>{live.current=false;clearInterval(timer);if(typeof window!=='undefined')window.removeEventListener('platform-management-refresh',manual);};},[]);
 const done=(message:string)=>{setSelected(null);setNotice(message);void refresh();};
 return <section className="pm-local-control"><div className="pm-bot-list-heading"><h3>运行环境 <Parameter help="固定常驻容器，不提供删除操作。CLI 类型在本地 CLI 行的三点菜单切换；模型和认证按 CLI 全局共享。"> </Parameter></h3></div>
  {error?<p className="hint-warn" role="alert">{error}</p>:null}{notice?<p className="hint" role="status">{notice}</p>:null}
  <div className="pm-runtime-overview"><div><strong>Dev Agent <span className="pm-role-tag">Control</span></strong><small><CompactText text={overview?.upgrade?.currentImage||'镜像信息读取中'}/></small></div><div><strong>全局 Proxy</strong><small>{overview?.proxy?.proxyProfileId?overview.proxyName||overview.proxy.proxyProfileId:'直连'} · {overview?.proxy?.appliedRevision===overview?.proxy?.revision?'已同步':'待同步'}</small></div><AgentActions name="Dev Agent 运行环境" actions={[{label:'修改配置',run:()=>setPanel('configure')},{label:'登录 CLI',run:()=>setPanel('cli-login')},{label:'镜像升级',run:()=>setPanel('upgrade')}]}/></div>
  <div className="pm-bot-list-heading"><h3>本地 CLI <ConfigHelp>模型与认证按 CLI 全局共享；不复制或删除 OAuth 凭据，忙碌时拒绝修改。</ConfigHelp></h3></div>
  <div className="pm-table-wrap"><table className="pm-local-cli-table"><thead><tr><th>CLI</th><th>认证方式</th><th>模型配置</th><th>同步状态</th><th>操作</th></tr></thead><tbody>{state?.agents.map(agent=><tr key={agent.agentType}><td><strong>{names[agent.agentType]}</strong>{state.bots.some(item=>item.cliId===agent.agentType)?<small className="pm-local-cli-selected" title={state.bots.filter(item=>item.cliId===agent.agentType).map(item=>item.displayName).join('、')}>当前使用</small>:null}</td><td>{agent.requiresLogin&&agent.authMethod!=='oauth'?'Vercel + 订阅':agent.authMethod==='oauth'?'OAuth':'API Key'}<small title="凭据存在不等于认证有效或模型调用成功">{agent.credentialKind==='native'?(agent.credentialPresent?'存在凭据':'未发现凭据'):agent.requiresLogin||agent.authMethod==='oauth'?(agent.credentialPresent?'已保存登录凭据':'未发现登录凭据'):(agent.credentialPresent?'已配置 API Key':'未发现 API Key')}</small></td><td><CompactText text={agent.modelName||'原生模型'}/><small><CompactText text={agent.currentModel||'由 CLI 原生管理'}/></small></td><td><span className={`pm-sync-dot ${agent.status==='synced'?'is-synced':''}`} title={`已应用 ${agent.appliedRevision} / 目标 ${agent.revision}`}>{agent.status==='synced'?'已同步':agent.status==='pending'?'待同步':agent.status==='restore'?'待恢复':'未纳管'}</span></td><td><AgentActions name={names[agent.agentType]||agent.agentType} actions={[{label:'修改模型',run:()=>setSelected(agent)},
        ...(agent.requiresLogin&&['codex','claude-code','zcode'].includes(agent.agentType)?[{label:'原生 OAuth 登录',run:()=>setLogin(agent)}]:[]),
]}/></td></tr>)}</tbody></table></div>

  {state&&!state.bots.length?<p role="status">暂无本地 Bot，请在 Bot 管理中创建本地机器人。</p>:null}
  {selected?<LocalModelForm agent={selected} models={models} onClose={()=>setSelected(null)} onDone={done}/>:null}
  {login?<LocalLogin agent={login} onClose={()=>{setLogin(null);void refresh();}}/>:null}
  {panel==='configure'?<ConfigureAgent onClose={()=>setPanel(null)} onDone={v=>{setPanel(null);done(v);}}/>:null}
  {panel==='upgrade'?<ControlUpgrade onClose={()=>{setPanel(null);void refresh();}}/>:null}
  {panel==='cli-login'?<CliLoginDialog target="control" onClose={()=>setPanel(null)}/>:null}
 </section>;
}
function LocalModelForm({agent,models,onClose,onDone}:{agent:Agent;models:Model[];onClose:()=>void;onDone:(s:string)=>void}){
 const candidates=models.filter(m=>m.authMethod!=='oauth'&&(m.enabled||m.profileId===agent.modelProfileId)&&protocols[agent.agentType]?.includes(m.protocol||'openai-completions'));
 const inherited=candidates.flatMap(m=>idsOf(m).map(id=>({profile:m.profileId,id,label:m.provider+'/'+id}))).filter(m=>m.label===agent.currentModel);
 const existing=agent.modelProfileId?[agent.modelProfileId,agent.modelId]:['codex','zcode'].includes(agent.agentType)&&agent.authMethod==='oauth'&&agent.status!=='unmanaged'?[null,null]:inherited.length===1?[inherited[0]!.profile,inherited[0]!.id]:null;
 const initial=existing?JSON.stringify(existing):'';
 const [selection,setSelection]=useState(initial),[oauthModel,setOauthModel]=useState(agent.authMethod==='oauth'?agent.modelId:''),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const requestId=useRef(agent.status==='pending'?agent.requestId:newPlatformRequestId()),submitting=useRef(false),pending=agent.status==='pending';
 const oauth=selection==='[null,null]';
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();if(submitting.current)return;submitting.current=true;setBusy(true);setError('');
  try{const [modelProfileId,modelId]=JSON.parse(selection);const result=await platformApi('/local-agent/'+agent.agentType,'PUT',{revision:agent.revision,requestId:requestId.current,authMethod:oauth?'oauth':'api-key',modelProfileId,modelId:oauth?oauthModel.trim()||null:modelId,confirmRestart:confirmed});
   if(result.applied!==true)throw Error('同步尚未确认');onDone(`${names[agent.agentType]} 配置已同步（版本 ${result.revision}），重启 ${result.restartedBots} 个空闲 Bot。`);
  }catch(e){setError(e instanceof Error?e.message:String(e));}finally{submitting.current=false;setBusy(false);}
 }
 return <Modal title={`本地 ${names[agent.agentType]} 全局配置`} onClose={onClose} busy={busy}><form onSubmit={submit}>
  <label>认证 / 模型<select aria-label="本地认证 / 模型" value={selection} required disabled={busy||pending} onChange={e=>setSelection(e.target.value)}><option value="" disabled>请选择模型连接或原生登录</option>{['codex','zcode'].includes(agent.agentType)?<option value="[null,null]">{agent.agentType==='zcode'?'BigModel 账号 OAuth 登录（浏览器授权）':'原生 OAuth 登录 · 无需模型连接'}</option>:null}{candidates.map(m=><optgroup key={m.profileId} label={modelGroupLabel(m)} disabled={!m.enabled}>{idsOf(m).map(id=><option key={id} value={JSON.stringify([m.profileId,id])}>{modelOptionLabel(m,id)}</option>)}</optgroup>)}</select></label>
  {oauth?<label>OAuth 模型（可选）<input value={oauthModel} onChange={e=>setOauthModel(e.target.value)} disabled={busy||pending} placeholder="留空使用 CLI 原生默认模型"/></label>:null}
  {agent.agentType==='claude-code'&&!candidates.some(m=>m.enabled&&m.protocol==='anthropic-messages')?<ConfigHelp>未找到可用的普通 API Key 连接：请在模型管理创建 Anthropic Messages 协议连接；方舟 Coding Plan 可克隆现有连接并改用 Anthropic 地址。</ConfigHelp>:null}
  <ConfigHelp>配置按 CLI 共享。同类型的所有本地 Bot 和直接终端使用相同配置。切换 API Key / OAuth 不删除原生登录凭据。</ConfigHelp>
  {pending?<p className="hint-warn">上次同步未确认，需重试原配置；旧模型引用在确认前继续受保护。</p>:null}
  <label className="pm-check"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/><span>确认重启受影响的空闲 Bot；正在执行任务时拒绝操作。会话历史与工作区保留。</span></label>
  {error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy||!confirmed||!selection}>{busy?'同步中…':'保存并同步'}</button></footer>
 </form></Modal>;
}
function LocalLogin({agent,onClose}:{agent:Agent;onClose:()=>void}){
 const [value,setValue]=useState<any>(null),[profiles,setProfiles]=useState<any[]>([]),[profileId,setProfileId]=useState(''),[browserMode,setBrowserMode]=useState<'workbench'|'local'>('workbench'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [callback,setCallback]=useState('');
 useEffect(()=>{void platformApi('/browser-profiles').then(result=>{setProfiles(result.profiles||[]);if(result.profiles?.length===1)setProfileId(result.profiles[0].profileId);}).catch(e=>setError(e instanceof Error?e.message:String(e)));},[]);
 const action=async(action:string)=>{setBusy(true);try{const result=await platformApi(`/local-agent/${agent.agentType}/login`,'POST',{action,...(action==='start'?{...(browserMode==='workbench'?{profileId}:{}),browserMode}:{}),...(action==='callback'?{callback:callback.trim()}:{})});if(result.oauth)setValue(result.oauth);if(action==='callback')setCallback('');setError('');return result;}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 const open=async()=>{const popup=window.open('about:blank','_blank');try{const result=await action('dashboard');if(result?.url&&popup){popup.opener=null;popup.location.replace(result.url);}else throw Error('登录工作台尚未就绪或浏览器拦截了弹窗');}catch(e){popup?.close();setError(e instanceof Error?e.message:String(e));}};
 useEffect(()=>{if(!value||!['starting','waiting','interrupted'].includes(value.state))return;const timer=setInterval(()=>void action('inspect'),5000);return()=>clearInterval(timer);},[value?.state]);
 return <Modal title={`本地 ${names[agent.agentType]} 原生登录`} onClose={onClose} busy={busy}>
  <ConfigHelp>原生 CLI 在 Control Agent 内完成认证，凭据仅保存在其 /state；统一登录工作台只保存浏览器 Cookie。登录期间暂停同 CLI 的本地 Bot，完成或取消后恢复。</ConfigHelp>
  <label>登录方式<select aria-label="登录方式" value={browserMode} onChange={e=>setBrowserMode(e.target.value==='local'?'local':'workbench')} disabled={busy||!!value}><option value="workbench">统一浏览器工作台</option><option value="local">本地浏览器打开链接</option></select></label>
  {browserMode==='workbench'?<label>浏览器配置<select value={profileId} onChange={e=>setProfileId(e.target.value)} disabled={busy||!!value}><option value="">请选择持久化浏览器配置</option>{profiles.map(profile=><option key={profile.profileId} value={profile.profileId}>{profile.displayName} · {profile.storageKind}</option>)}</select></label>
  :<ConfigHelp>本地浏览器模式：发起后此处显示授权链接，用你自己的浏览器完成登录。</ConfigHelp>}
  <p>状态：{value?.state||'尚未发起'}</p>{value?.userCode?<p>设备验证码：<code>{value.userCode}</code></p>:null}
  {value?.authorizationUrl?browserMode==='local'?value.state==='waiting'?<a href={value.authorizationUrl} target="_blank" rel="noreferrer">用本地浏览器打开授权页</a>:null:<button disabled={busy} onClick={()=>void open()}>打开统一登录工作台</button>:null}
  {browserMode==='local'&&value?.state==='waiting'&&value?.callbackPort?<><label>授权后的本地回调地址<input aria-label="授权后的本地回调地址" value={callback} onChange={e=>setCallback(e.target.value)} placeholder="粘贴浏览器跳转后的完整 localhost 地址"/></label><ConfigHelp>如果浏览器跳转到 localhost 后无法连接，请复制地址栏中的完整地址并提交，让目标 Agent 完成授权。</ConfigHelp><button disabled={busy||!callback.trim()} onClick={()=>void action('callback')}>提交回调地址</button></>:null}
  <p role="status">凭据文件：{value?.credentialPresent?'存在':'尚未确认'}<ConfigHelp>凭据有效性由原生 CLI 确认。</ConfigHelp></p>
  {browserMode==='workbench'&&!profiles.length?<p className="hint-warn">请先在 Agent 管理 → 登录工作台新建浏览器配置。</p>:null}
  {error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button onClick={onClose} disabled={busy}>关闭面板</button><button disabled={busy||!value} onClick={()=>void action('inspect')}>刷新状态</button><button disabled={busy||!value} onClick={()=>void action('cancel')}>取消登录并恢复</button><button className="primary" disabled={busy||browserMode==='workbench'&&!profileId||value&&['starting','waiting','interrupted'].includes(value.state)} onClick={()=>void action('start')}>发起原生登录</button></footer>
 </Modal>;
}
