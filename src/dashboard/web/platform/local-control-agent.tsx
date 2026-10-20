import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Modal,platformApi} from './management-page.js';
import {CompactText,Parameter} from './compact-controls.js';
type Model={profileId:string;displayName:string;provider:string;modelId:string;modelIds?:string[];protocol?:string;enabled:boolean;apiKeyConfigured:boolean};
type Agent={agentType:string;revision:number;appliedRevision:number;requestId?:string;authMethod:string;modelProfileId:string|null;modelId:string;currentModel:string|null;modelName:string|null;credentialPresent:boolean;status:string};
type Bot={appId:string;displayName:string;cliId:string};
type Local={name:string;controlId:string;agents:Agent[];bots:Bot[]};
const names:Record<string,string>={pi:'Pi',codex:'Codex','claude-code':'Claude Code'};
const protocols:Record<string,string[]>={pi:['openai-completions','openai-responses','anthropic-messages'],codex:['openai-responses'],'claude-code':['anthropic-messages']};
export function LocalControlAgent({models}:{models:Model[]}){
 const [state,setState]=useState<Local|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[selected,setSelected]=useState<Agent|null>(null),[bot,setBot]=useState<Bot|null>(null),[login,setLogin]=useState<Agent|null>(null);
 const live=useRef(true);
 const refresh=async()=>{try{const value=await platformApi('/local-agent');if(live.current){setState(value);setError('');}}catch(e){if(live.current)setError(e instanceof Error?e.message:String(e));}};
 useEffect(()=>{live.current=true;void refresh();const timer=setInterval(()=>void refresh(),10000);return()=>{live.current=false;clearInterval(timer);};},[]);
 const done=(message:string)=>{setSelected(null);setBot(null);setNotice(message);void refresh();};
 return <section className="pm-local-control"><div className="pm-bot-list-heading"><h2>本地 Control Agent <Parameter help="固定常驻容器，不提供删除操作。CLI 类型按 Bot 选择；模型和认证按 CLI 全局共享。"> </Parameter></h2><div className="pm-local-cli-actions">{state?.bots.map(item=><button key={item.appId} title={`${item.displayName} · ${names[item.cliId]||item.cliId}`} onClick={()=>setBot(item)}>{state.bots.length>1?`${item.displayName} · `:''}切换 CLI</button>)}</div></div>
  {error?<p className="hint-warn" role="alert">{error}</p>:null}{notice?<p className="hint" role="status">{notice}</p>:null}
  <p className="hint">本地预装 Pi、Codex、Claude Code。同步不复制或删除 OAuth 凭据；工作中的 Bot 会拒绝切换。</p>
  <div className="pm-agent-list">{state?.agents.map(agent=><details key={agent.agentType}><summary><span className="pm-agent-chevron">›</span><strong>{names[agent.agentType]}{state.bots.some(item=>item.cliId===agent.agentType)?<small className="pm-local-cli-selected" title={state.bots.filter(item=>item.cliId===agent.agentType).map(item=>item.displayName).join('、')}>当前使用</small>:null}</strong><span>{agent.status==='synced'?'已同步':agent.status==='pending'?'同步待确认':'已有本地配置 · 待纳管'}</span><CompactText text={agent.currentModel||'原生默认模型'}/></summary><div className="pm-agent-details">
    <p>{agent.authMethod==='oauth'?'原生 OAuth':agent.modelName||'API Key / 本地历史配置'} · 已应用 {agent.appliedRevision} / 目标 {agent.revision}</p>
    <p className="hint">{agent.credentialPresent?'原生凭据文件存在；实际登录有效性由 CLI 确认。':'尚未发现原生凭据文件。'}</p>
    <button onClick={()=>setSelected(agent)}>{agent.status==='pending'?'继续上次同步':'修改模型 / 同步配置'}</button>{agent.agentType!=='pi'&&agent.authMethod==='oauth'?<button onClick={()=>setLogin(agent)}>原生 OAuth 登录</button>:null}
  </div></details>)}</div>
  {state&&!state.bots.length?<p className="hint">暂无本地 Bot，请在 Bot 管理中创建本地机器人。</p>:null}
  {selected?<LocalModelForm agent={selected} models={models} onClose={()=>setSelected(null)} onDone={done}/>:null}
  {bot?<LocalCliForm bot={bot} onClose={()=>setBot(null)} onDone={done}/>:null}
  {login?<LocalLogin agent={login} onClose={()=>{setLogin(null);void refresh();}}/>:null}
 </section>;
}
function LocalModelForm({agent,models,onClose,onDone}:{agent:Agent;models:Model[];onClose:()=>void;onDone:(s:string)=>void}){
 const candidates=models.filter(m=>m.enabled&&m.apiKeyConfigured&&protocols[agent.agentType]?.includes(m.protocol||'openai-completions'));
 const inherited=candidates.flatMap(m=>(m.modelIds||[m.modelId]).map(id=>({profile:m.profileId,id,label:m.provider+'/'+id}))).filter(m=>m.label===agent.currentModel);
 const existing=agent.modelProfileId?[agent.modelProfileId,agent.modelId]:agent.authMethod==='oauth'&&agent.status!=='unmanaged'?[null,null]:inherited.length===1?[inherited[0]!.profile,inherited[0]!.id]:null;
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
  <label>认证 / 模型<select aria-label="本地认证 / 模型" value={selection} required disabled={busy||pending} onChange={e=>setSelection(e.target.value)}><option value="" disabled>请选择模型连接或原生登录</option>{agent.agentType!=='pi'?<option value="[null,null]">原生 OAuth · 不使用共享模型连接</option>:null}{candidates.map(m=><optgroup key={m.profileId} label={`${m.displayName} · ${m.profileId}`}>{(m.modelIds||[m.modelId]).map(id=><option key={id} value={JSON.stringify([m.profileId,id])}>{id}</option>)}</optgroup>)}</select></label>
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
 const [value,setValue]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[callback,setCallback]=useState('');
 const action=async(action:string)=>{setBusy(true);try{const result=await platformApi(`/local-agent/${agent.agentType}/login`,'POST',{action,...(action==='callback'?{callback}:{})});setValue(result.oauth);setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 useEffect(()=>{if(!value||!['starting','waiting','interrupted'].includes(value.state))return;const timer=setInterval(()=>void action('inspect'),5000);return()=>clearInterval(timer);},[value?.state]);
 return <Modal title={`本地 ${names[agent.agentType]} 原生登录`} onClose={onClose} busy={busy}>
  <p className="hint">原生 CLI 在 Control Agent 内完成认证，凭据仅保存在其 /state。登录期间暂停同 CLI 的本地 Bot，完成或取消后恢复。不复制其他 Worker 的账号。</p>
  <p>状态：{value?.state||'尚未发起'}</p>{value?.authorizationUrl?<a href={value.authorizationUrl} target="_blank" rel="noreferrer">打开官方登录页面</a>:null}{value?.userCode?<p>设备验证码：<code>{value.userCode}</code></p>:null}
  {value?.callbackPort?<label>授权完成后粘贴浏览器 localhost 回调 URL<input value={callback} onChange={e=>setCallback(e.target.value)}/><button disabled={busy||!callback} onClick={()=>void action('callback')}>提交给原生 CLI</button></label>:null}
  <p className="hint">凭据文件：{value?.credentialPresent?'存在（有效性由原生 CLI 确认）':'尚未确认'}</p>
  {error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button onClick={onClose} disabled={busy}>关闭面板</button><button disabled={busy} onClick={()=>void action('inspect')}>刷新状态</button><button disabled={busy||!value} onClick={()=>void action('cancel')}>取消登录并恢复</button><button className="primary" disabled={busy||value&&['starting','waiting','interrupted'].includes(value.state)} onClick={()=>void action('start')}>发起原生登录</button></footer>
 </Modal>;
}
