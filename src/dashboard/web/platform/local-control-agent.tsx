import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Modal,platformApi} from './management-page.js';
import {ProxySelect} from './proxies.js';
import {CompactText,Parameter} from './compact-controls.js';
import {hostFirst,imageOptionLabel} from './image-utils.js';
type Model={profileId:string;displayName:string;provider:string;modelId:string;modelIds?:string[];protocol?:string;enabled:boolean;apiKeyConfigured:boolean};
type Agent={agentType:string;revision:number;appliedRevision:number;requestId?:string;authMethod:string;modelProfileId:string|null;modelId:string;currentModel:string|null;modelName:string|null;credentialPresent:boolean;status:string;requiresLogin?:boolean};
type Bot={appId:string;displayName:string;cliId:string};
type Local={name:string;controlId:string;agents:Agent[];bots:Bot[]};
const names:Record<string,string>={pi:'Pi',codex:'Codex','claude-code':'Claude Code',zcode:'ZCode'};
const protocols:Record<string,string[]>={pi:['openai-completions','openai-responses','anthropic-messages'],codex:['openai-responses'],'claude-code':['anthropic-messages','vercel-claude'],zcode:['zcode-coding-plan']};
function ControlProxy({onClose}:{onClose:()=>void}){
 const [state,setState]=useState<any>(),[value,setValue]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{void platformApi('/control-proxy').then(result=>{setState(result);setValue(result.proxyProfileId||'');}).catch(e=>setError(String(e)));},[]);
 return <Modal title="Dev Agent 全局 Proxy" onClose={onClose} busy={busy}><p className="hint">此代理由容器内所有 CLI 共享，空闲时同步生效。</p><ProxySelect value={value} onChange={setValue}/><footer><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||!state} onClick={async()=>{setBusy(true);try{await platformApi('/control-proxy','PUT',{revision:state.revision,proxyProfileId:value||null});onClose();}catch(e){setError(String(e));}finally{setBusy(false);}}}>保存并同步</button></footer>{error?<p role="alert">{error}</p>:null}</Modal>;
}
function ControlUpgrade({onClose}:{onClose:()=>void}){
 const [images,setImages]=useState<any[]>([]),[hostArch,setHostArch]=useState<string|undefined>(),[image,setImage]=useState(''),[state,setState]=useState<any>(),[confirm,setConfirm]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{void Promise.all([platformApi('/images'),platformApi('/control-upgrade')]).then(([inventory,status])=>{setImages(inventory.images.filter((item:any)=>item.roles.includes('control')));setHostArch(inventory.hostArch);setState(status);}).catch(e=>setError(String(e)));},[]);
 const submit=async(rollback=false)=>{setBusy(true);try{await platformApi('/control-upgrade','POST',{image,rollback,confirmRestart:confirm});setState({status:'queued'});setError('');}catch(e){setError(String(e));}finally{setBusy(false);}};
 return <Modal title="Dev Agent 镜像升级" onClose={onClose} busy={busy}><p className="hint">升级期间工作台短暂断开，重连后使用新镜像。保留 state、workspace 和 Docker 配置，失败自动恢复旧容器。</p><label>本地兼容镜像<select value={image} onChange={e=>setImage(e.target.value)}><option value="">选择已缓存的 Dev Agent 镜像</option>{hostFirst(images,hostArch).map(item=>{const foreign=!!item.architecture&&!!hostArch&&item.architecture!==hostArch;return <option key={item.id} value={item.id} disabled={foreign}>{imageOptionLabel(item.tags,item.id,item.architecture,hostArch)}</option>;})}</select></label><label><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>确认重启空闲 Dev Agent</label><footer><button onClick={onClose} disabled={busy}>关闭</button><button className="primary" disabled={busy||!confirm||!image||state?.status==='queued'} onClick={()=>void submit()}>升级</button>{state?.previousImage?<button disabled={busy||!confirm} onClick={()=>void submit(true)}>回滚</button>:null}</footer>{state?.status==='queued'?<p role="status">升级已排队，请稍后刷新页面查看结果。</p>:null}{state?.error?<p role="alert">{state.error}</p>:null}{error?<p role="alert">{error}</p>:null}</Modal>;
}
export function LocalControlAgent({models}:{models:Model[]}){
 const [state,setState]=useState<Local|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[selected,setSelected]=useState<Agent|null>(null),[bot,setBot]=useState<Bot|null>(null),[login,setLogin]=useState<Agent|null>(null);
 const live=useRef(true);
 const [panel,setPanel]=useState<'proxy'|'upgrade'|null>(null),[overview,setOverview]=useState<any>();
 const refresh=async()=>{try{const [value,proxy,upgrade,proxies]=await Promise.all([platformApi('/local-agent'),platformApi('/control-proxy'),platformApi('/control-upgrade'),platformApi('/proxies')]);if(!Array.isArray(value.agents)||!Array.isArray(value.bots))throw Error('本地 Agent 状态格式无效');if(live.current){setState(value);setOverview({proxy,upgrade,proxyName:proxies.proxies.find((p:any)=>p.profileId===proxy.proxyProfileId)?.displayName});setError('');}}catch(e){if(live.current)setError(e instanceof Error?e.message:String(e));}};
 useEffect(()=>{live.current=true;const manual=()=>void refresh();if(typeof window!=='undefined')window.addEventListener('platform-management-refresh',manual);void refresh();const timer=setInterval(()=>void refresh(),10000);return()=>{live.current=false;clearInterval(timer);if(typeof window!=='undefined')window.removeEventListener('platform-management-refresh',manual);};},[]);
 const done=(message:string)=>{setSelected(null);setBot(null);setNotice(message);void refresh();};
 return <section className="pm-local-control"><div className="pm-bot-list-heading"><h3>运行环境 <Parameter help="固定常驻容器，不提供删除操作。CLI 类型按 Bot 选择；模型和认证按 CLI 全局共享。"> </Parameter></h3><div className="pm-local-cli-actions">{state?.bots.map(item=><button key={item.appId} title={`${item.displayName} · ${names[item.cliId]||item.cliId}`} onClick={()=>setBot(item)}>{state.bots.length>1?`${item.displayName} · `:''}切换 CLI</button>)}</div></div>
  {error?<p className="hint-warn" role="alert">{error}</p>:null}{notice?<p className="hint" role="status">{notice}</p>:null}
  <div className="pm-runtime-overview"><div><strong>Dev Agent <span className="pm-role-tag">Control</span></strong><small><CompactText text={overview?.upgrade?.currentImage||'镜像信息读取中'}/></small></div><div><strong>全局 Proxy</strong><small>{overview?.proxy?.proxyProfileId?overview.proxyName||overview.proxy.proxyProfileId:'直连'} · {overview?.proxy?.appliedRevision===overview?.proxy?.revision?'已同步':'待同步'}</small></div><div className="pm-inline-actions"><button onClick={()=>setPanel('proxy')}>修改 Proxy</button><button onClick={()=>setPanel('upgrade')}>镜像升级</button></div></div>
  <div className="pm-bot-list-heading"><h3>本地 CLI</h3><span>模型与认证按 CLI 全局共享</span></div>
  <div className="pm-table-wrap"><table className="pm-local-cli-table"><thead><tr><th>CLI</th><th>认证方式</th><th>模型配置</th><th>同步状态</th><th>操作</th></tr></thead><tbody>{state?.agents.map(agent=><tr key={agent.agentType}><td><strong>{names[agent.agentType]}</strong>{state.bots.some(item=>item.cliId===agent.agentType)?<small className="pm-local-cli-selected" title={state.bots.filter(item=>item.cliId===agent.agentType).map(item=>item.displayName).join('、')}>当前使用</small>:null}</td><td>{agent.requiresLogin&&agent.authMethod!=='oauth'?'Vercel + 订阅':agent.authMethod==='oauth'?'OAuth':'API Key'}<small title="凭据文件存在不等于实际登录有效">{agent.credentialPresent?'存在凭据':'未发现凭据'}</small></td><td><CompactText text={agent.modelName||'原生模型'}/><small><CompactText text={agent.currentModel||'由 CLI 原生管理'}/></small></td><td><span className={`pm-sync-dot ${agent.status==='synced'?'is-synced':''}`} title={`已应用 ${agent.appliedRevision} / 目标 ${agent.revision}`}>{agent.status==='synced'?'已同步':agent.status==='pending'?'待同步':agent.status==='restore'?'待恢复':'未纳管'}</span></td><td><div className="pm-inline-actions"><button onClick={()=>setSelected(agent)}>{agent.status==='pending'?'继续同步':'配置'}</button>{(agent.requiresLogin||agent.authMethod==='oauth')?<button onClick={()=>setLogin(agent)}>登录</button>:null}</div></td></tr>)}</tbody></table></div>
  <p className="pm-info-note">同步不复制或删除 OAuth 凭据。凭据是否有效由 CLI 确认；工作中的 Bot 会拒绝切换配置。</p>
  {state&&!state.bots.length?<p className="hint">暂无本地 Bot，请在 Bot 管理中创建本地机器人。</p>:null}
  {selected?<LocalModelForm agent={selected} models={models} onClose={()=>setSelected(null)} onDone={done}/>:null}
  {bot?<LocalCliForm bot={bot} onClose={()=>setBot(null)} onDone={done}/>:null}
  {login?<LocalLogin agent={login} onClose={()=>{setLogin(null);void refresh();}}/>:null}
  {panel==='proxy'?<ControlProxy onClose={()=>{setPanel(null);void refresh();}}/>:null}
  {panel==='upgrade'?<ControlUpgrade onClose={()=>{setPanel(null);void refresh();}}/>:null}
 </section>;
}
function LocalModelForm({agent,models,onClose,onDone}:{agent:Agent;models:Model[];onClose:()=>void;onDone:(s:string)=>void}){
 const candidates=models.filter(m=>m.enabled&&m.apiKeyConfigured&&protocols[agent.agentType]?.includes(m.protocol||'openai-completions'));
 const inherited=candidates.flatMap(m=>(m.protocol==='vercel-claude'||m.protocol==='zcode-coding-plan'?['']:m.modelIds||[m.modelId]).map(id=>({profile:m.profileId,id,label:m.provider+'/'+id}))).filter(m=>m.label===agent.currentModel);
 const existing=agent.modelProfileId?[agent.modelProfileId,agent.modelId]:(agent.agentType==='codex')&&agent.authMethod==='oauth'&&agent.status!=='unmanaged'?[null,null]:inherited.length===1?[inherited[0]!.profile,inherited[0]!.id]:null;
 const initial=existing?JSON.stringify(existing):'';
 const [selection,setSelection]=useState(initial),[oauthModel,setOauthModel]=useState(agent.authMethod==='oauth'?agent.modelId:''),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const requestId=useRef(agent.status==='pending'?agent.requestId:crypto.randomUUID()),submitting=useRef(false),pending=agent.status==='pending';
 const oauth=selection==='[null,null]';
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();if(submitting.current)return;submitting.current=true;setBusy(true);setError('');
  try{const [modelProfileId,modelId]=JSON.parse(selection);const result=await platformApi('/local-agent/'+agent.agentType,'PUT',{revision:agent.revision,requestId:requestId.current,authMethod:oauth?'oauth':'api-key',modelProfileId,modelId:oauth?oauthModel.trim()||null:modelId,confirmRestart:confirmed});
   if(result.applied!==true)throw Error('同步尚未确认');onDone(`${names[agent.agentType]} 配置已同步（版本 ${result.revision}），重启 ${result.restartedBots} 个空闲 Bot。`);
  }catch(e){setError(e instanceof Error?e.message:String(e));}finally{submitting.current=false;setBusy(false);}
 }
 return <Modal title={`本地 ${names[agent.agentType]} 全局配置`} onClose={onClose} busy={busy}><form onSubmit={submit}>
  <label>认证 / 模型<select aria-label="本地认证 / 模型" value={selection} required disabled={busy||pending} onChange={e=>setSelection(e.target.value)}><option value="" disabled>请选择模型连接或原生登录</option>{(agent.agentType==='codex')?<option value="[null,null]">原生 OAuth · 不使用共享模型连接</option>:null}{candidates.map(m=><optgroup key={m.profileId} label={`${m.displayName} · ${m.profileId}`}>{(m.protocol==='vercel-claude'||m.protocol==='zcode-coding-plan'?['']:m.modelIds||[m.modelId]).map(id=><option key={id} value={JSON.stringify([m.profileId,id])}>{id||'原生动态模型 · 登录后选择'}</option>)}</optgroup>)}</select></label>
  {oauth?<label>OAuth 模型（可选）<input value={oauthModel} onChange={e=>setOauthModel(e.target.value)} disabled={busy||pending} placeholder="留空使用 CLI 原生默认模型"/></label>:null}
  <p className="hint">配置按 CLI 共享。同类型的所有本地 Bot 和直接终端使用相同配置。切换 API Key / OAuth 不删除原生登录凭据。</p>
  {pending?<p className="hint-warn">上次同步未确认，需重试原配置；旧模型引用在确认前继续受保护。</p>:null}
  <label className="pm-check"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/><span>确认重启受影响的空闲 Bot；正在执行任务时拒绝操作。会话历史与工作区保留。</span></label>
  {error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy||!confirmed||!selection}>{busy?'同步中…':'保存并同步'}</button></footer>
 </form></Modal>;
}
function LocalCliForm({bot,onClose,onDone}:{bot:Bot;onClose:()=>void;onDone:(s:string)=>void}){
 const [cli,setCli]=useState(bot.cliId),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <Modal title={`切换 ${bot.displayName} 的本地 CLI`} onClose={onClose} busy={busy}><form onSubmit={async e=>{e.preventDefault();setBusy(true);try{await platformApi('/local-agent/bots/'+bot.appId,'PUT',{cliId:cli,confirmRestart:confirmed});onDone('本地 CLI 已切换；使用所选 CLI 的全局模型配置。');}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>
  <label>CLI<select value={cli} onChange={e=>setCli(e.target.value)}>{Object.entries(names).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
  <p className="hint">请先配置目标 CLI 的全局模型或原生登录。Botmux 会关闭旧 CLI 会话；文件、历史与原生凭据保留。</p>
  <label className="pm-check"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>确认切换 CLI 并关闭旧 CLI 的空闲会话</span></label>{error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy||!confirmed||cli===bot.cliId}>确认切换</button></footer>
 </form></Modal>;
}
function LocalLogin({agent,onClose}:{agent:Agent;onClose:()=>void}){
 const [value,setValue]=useState<any>(null),[profiles,setProfiles]=useState<any[]>([]),[profileId,setProfileId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{void platformApi('/browser-profiles').then(result=>{setProfiles(result.profiles||[]);if(result.profiles?.length===1)setProfileId(result.profiles[0].profileId);}).catch(e=>setError(e instanceof Error?e.message:String(e)));},[]);
 const action=async(action:string)=>{setBusy(true);try{const result=await platformApi(`/local-agent/${agent.agentType}/login`,'POST',{action,...(action==='start'?{profileId}:{})});if(result.oauth)setValue(result.oauth);setError('');return result;}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 const open=async()=>{const popup=window.open('about:blank','_blank');try{const result=await action('dashboard');if(result?.url&&popup){popup.opener=null;popup.location.replace(result.url);}else throw Error('登录工作台尚未就绪或浏览器拦截了弹窗');}catch(e){popup?.close();setError(e instanceof Error?e.message:String(e));}};
 useEffect(()=>{if(!value||!['starting','waiting','interrupted'].includes(value.state))return;const timer=setInterval(()=>void action('inspect'),5000);return()=>clearInterval(timer);},[value?.state]);
 return <Modal title={`本地 ${names[agent.agentType]} 原生登录`} onClose={onClose} busy={busy}>
  <p className="hint">原生 CLI 在 Control Agent 内完成认证，凭据仅保存在其 /state；统一登录工作台只保存浏览器 Cookie。登录期间暂停同 CLI 的本地 Bot，完成或取消后恢复。</p>
  <label>浏览器配置<select value={profileId} onChange={e=>setProfileId(e.target.value)} disabled={busy||!!value}><option value="">请选择持久化浏览器配置</option>{profiles.map(profile=><option key={profile.profileId} value={profile.profileId}>{profile.displayName} · {profile.storageKind}</option>)}</select></label>
  <p>状态：{value?.state||'尚未发起'}</p>{value?.authorizationUrl?<a href={value.authorizationUrl} target="_blank" rel="noreferrer">打开官方登录页面</a>:null}{value?.userCode?<p>设备验证码：<code>{value.userCode}</code></p>:null}
  {value?.authorizationUrl?<button disabled={busy} onClick={()=>void open()}>打开统一登录工作台</button>:null}
  <p className="hint">凭据文件：{value?.credentialPresent?'存在（有效性由原生 CLI 确认）':'尚未确认'}</p>
  {!profiles.length?<p className="hint-warn">请先在 Agent 管理 → 登录工作台新建浏览器配置。</p>:null}
  {error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button onClick={onClose} disabled={busy}>关闭面板</button><button disabled={busy||!value} onClick={()=>void action('inspect')}>刷新状态</button><button disabled={busy||!value} onClick={()=>void action('cancel')}>取消登录并恢复</button><button className="primary" disabled={busy||!profileId||value&&['starting','waiting','interrupted'].includes(value.state)} onClick={()=>void action('start')}>发起原生登录</button></footer>
 </Modal>;
}
