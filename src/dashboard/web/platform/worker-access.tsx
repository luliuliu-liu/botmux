import {useEffect,useRef,useState} from 'react';
import {Modal,platformApi,type Container} from './management-page.js';
import {clearManagementCache} from './management-cache.js';
import {ProxySelect} from './proxies.js';
import {Parameter,CompactText} from './compact-controls.js';

type Profile={profileId:string;displayName:string;storageKind:string;storageSource:string;proxyProfileId:string|null;revision:number};
type Login={loginId:string;containerId:string;agentType?:string;browserMode?:string;profileId:string;state:string;workerState:string;expiresAt:string;lastError?:string;userCode?:string;credentialPresent?:boolean;authorizationUrl?:string};
type CliOption={agentType:string;configured?:boolean;authMethod?:string|null;modelProtocol?:string|null;revision:number};
type LoginTarget={value:string;label:string;containerId:string;agentType:string;revision:number;container:Container};
const states:Record<string,string>={starting:'启动中',waiting:'等待浏览器授权',succeeded:'原生 CLI 登录成功',failed:'登录未完成',cancelled:'已取消',closing:'关闭待确认',interrupted:'登录进程中断'};
export function LoginWorkbench({container,containers,onClose,embedded=false,presetAgentType}:{container:Container|null;containers:Container[];onClose:()=>void;embedded?:boolean;presetAgentType?:string}){
 const [workers,setWorkers]=useState(containers);
 const [cliTargets,setCliTargets]=useState<Record<string,CliOption[]>>({});
 const [profiles,setProfiles]=useState<Profile[]>([]),[logins,setLogins]=useState<Login[]>([]),[profileId,setProfileId]=useState(''),[target,setTarget]=useState(container?`${container.containerId}:${presetAgentType||container.agentType}`:''),[browserMode,setBrowserMode]=useState<'workbench'|'local'>('workbench'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const oauthCli=(cli:CliOption)=>cli.configured===true&&['codex','claude-code','traex','zcode'].includes(cli.agentType)&&(cli.authMethod==='oauth'||cli.modelProtocol==='vercel-claude');
 const loginTargets=workers.flatMap((c:Container):LoginTarget[]=>{
  if(c.agentType==='browser')return [];
  if((c.imageAgents?.length||0)>1)return (cliTargets[c.containerId]??[]).filter(oauthCli)
    .map(cli=>({value:`${c.containerId}:${cli.agentType}`,label:`${c.displayName} · ${cli.agentType}`,containerId:c.containerId,agentType:cli.agentType,revision:cli.revision,container:c}));
  return ['codex','claude-code','traex','zcode'].includes(c.agentType)&&(c.requiresLogin||c.authMethod==='oauth')
    ?[{value:`${c.containerId}:${c.agentType}`,label:`${c.displayName} · ${c.agentType}`,containerId:c.containerId,agentType:c.agentType,revision:c.revision,container:c}]:[];
 });
 const [newProfile,setNewProfile]=useState(false),[kind,setKind]=useState('volume'),[source,setSource]=useState(''),[name,setName]=useState(''),[newProxy,setNewProxy]=useState('');
 const [proxyDraft,setProxyDraft]=useState('');
 const refreshing=useRef(false),mounted=useRef(true);
 const selectedProfile=profiles.find(p=>p.profileId===profileId);
 const refresh=async()=>{if(refreshing.current)return;refreshing.current=true;try{
  const [p,l,c]=await Promise.all([platformApi('/browser-profiles'),platformApi('/logins'),platformApi('/containers')]);
  if(mounted.current){setWorkers(c.containers);setProfiles(p.profiles);setLogins(previous=>l.logins.map((r:Login)=>({...previous.find(s=>s.loginId===r.loginId),...r})));}
  for(const worker of c.containers.filter((x:Container)=>(x.imageAgents?.length||0)>1&&x.agentType!=='browser')){
   try{const result=await platformApi(`/containers/${worker.containerId}/clis`);if(mounted.current)setCliTargets(rows=>({...rows,[worker.containerId]:result.clis??[]}));}catch{/* keep the previous snapshot; single-CLI targets still work */}
  }
  for(const login of l.logins.filter((r:Login)=>['starting','waiting'].includes(r.state))){
   try{const status=await platformApi(`/logins/${login.loginId}`,'POST',{});if(mounted.current)setLogins(rows=>rows.map(row=>row.loginId===status.loginId?status:row));}catch{/* A user can retry status or close after transport errors. */}
  }
 }catch(e){if(mounted.current)setError(e instanceof Error?e.message:String(e));}finally{refreshing.current=false;}};
 useEffect(()=>{mounted.current=true;void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{mounted.current=false;clearInterval(timer);};},[]);
 useEffect(()=>{setProxyDraft(selectedProfile?.proxyProfileId||'');},[selectedProfile?.profileId,selectedProfile?.revision]);
 const mutate=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));await refresh();}finally{setBusy(false);}};
 const open=async(login:Login)=>{const popup=window.open('about:blank','_blank');try{const result=await platformApi(`/logins/${login.loginId}/dashboard`,'POST',{});if(popup){popup.opener=null;popup.location.replace(result.url);}else throw Error('请允许弹窗后重试');}catch(e){popup?.close();setError(e instanceof Error?e.message:String(e));}};
 const content=<>
  <label><Parameter help="原生 CLI 在目标 Worker 登录，凭据只保留该 Worker；浏览器工作台辅助授权。">目标 Agent / CLI</Parameter><select aria-label="登录目标 Agent 或 CLI" value={target} onChange={e=>setTarget(e.target.value)} disabled={busy}><option value="">请选择需要原生登录的 Agent 或 CLI</option>{loginTargets.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
  {browserMode==='workbench'?<label><Parameter help="同一个配置同时只允许一个登录工作台使用。关闭工作台会保留当前运行期的配置与 Cookie，便于重复登录；不启用浏览器密码自动保存。重启或整体重建不会恢复这份列表。">浏览器配置</Parameter><select value={profileId} onChange={e=>setProfileId(e.target.value)} disabled={busy}><option value="">选择本地浏览器配置</option>{profiles.map(p=><option key={p.profileId} value={p.profileId}>{p.displayName} · {p.storageKind}{p.proxyProfileId?' · 代理':' · 直连'}</option>)}</select></label>
  :null}
  {selectedProfile?<fieldset className="pm-profile-fields"><legend>浏览器代理</legend><ProxySelect value={proxyDraft} onChange={setProxyDraft}/><button type="button" disabled={busy} onClick={()=>void mutate(async()=>{const result=await platformApi('/browser-profiles/'+selectedProfile.profileId,'PUT',{revision:selectedProfile.revision,displayName:selectedProfile.displayName,proxyProfileId:proxyDraft||null});setProfiles(rows=>rows.map(row=>row.profileId===result.profile.profileId?result.profile:row));})}>保存并同步</button></fieldset>:null}
  <button type="button" disabled={busy} onClick={()=>setNewProfile(!newProfile)}>{newProfile?'收起新建配置':'新建浏览器配置'}</button>
  {newProfile?<fieldset className="pm-profile-fields"><legend>独立私有浏览器存储</legend><label>名称<input value={name} maxLength={64} onChange={e=>setName(e.target.value)}/></label><label>存储<select value={kind} onChange={e=>setKind(e.target.value)}><option value="volume">新建专用 volume</option><option value="hostpath">专用 hostPath</option></select></label>{kind==='hostpath'?<label>Docker 宿主机绝对路径<input value={source} onChange={e=>setSource(e.target.value)}/><span className="hint-warn">请使用独立目录，不能使用 Agent state、工作区或共享目录；此目录含账号 Cookie。</span></label>:null}<ProxySelect value={newProxy} onChange={setNewProxy}/><button disabled={busy||!name.trim()||kind==='hostpath'&&!source.startsWith('/')} onClick={()=>void mutate(async()=>{const before=new Set(profiles.map(p=>p.profileId));const result=await platformApi('/browser-profiles','POST',{displayName:name,storageKind:kind,storageSource:source,proxyProfileId:newProxy||null,confirmSensitiveStorage:kind==='hostpath'});setProfiles(result.profiles);setProfileId(result.profiles.find((p:Profile)=>!before.has(p.profileId))?.profileId||'');setNewProfile(false);setName('');setNewProxy('');})}>保存浏览器配置</button></fieldset>:null}
  <label><Parameter help="统一工作台：平台创建隔离浏览器并自动打开授权页；本地浏览器：只提供授权链接，用你自己的浏览器完成登录。两种方式的凭据最终都只保存在目标 Worker。工作台按需创建，15 分钟后关闭；配置只保留当前运行期。">登录方式</Parameter><select aria-label="登录方式" value={browserMode} onChange={e=>setBrowserMode(e.target.value==='local'?'local':'workbench')} disabled={busy}><option value="workbench">统一浏览器工作台</option><option value="local">本地浏览器打开链接</option></select></label>

  <div className="pm-login-list">{logins.map(login=><article key={login.loginId}><div><strong>{containers.find(c=>c.containerId===login.containerId)?.displayName||'Agent'}{login.agentType?` · ${login.agentType}`:''}</strong><span className="pm-state">{states[login.state]||login.state}</span></div><small>{profiles.find(p=>p.profileId===login.profileId)?.displayName} · 截止 {new Date(login.expiresAt).toLocaleTimeString()}</small>{login.userCode?<p>在浏览器输入设备码：<code>{login.userCode}</code></p>:null}{login.browserMode==='local'&&login.state==='waiting'&&login.authorizationUrl?<p>授权链接：<a href={login.authorizationUrl} target="_blank" rel="noreferrer">用本地浏览器打开</a></p>:null}{login.credentialPresent!==undefined?<small>Worker 凭据文件：{login.credentialPresent?'已存在（不等同于模型调用验证）':'尚未确认'}</small>:null}{login.lastError?<p className="hint-warn">{login.lastError}</p>:null}<div className="pm-actions">{login.browserMode!=='local'?<button disabled={busy||login.state==='starting'} onClick={()=>void open(login)}>打开浏览器</button>:null}<button disabled={busy} onClick={()=>void mutate(async()=>{const s=await platformApi(`/logins/${login.loginId}`,'POST',{});setLogins(rows=>rows.map(r=>r.loginId===s.loginId?s:r));})}>刷新登录状态</button><button disabled={busy} onClick={()=>void mutate(async()=>{await platformApi(`/logins/${login.loginId}`,'DELETE',{});})}>关闭工作台 · 保留数据</button></div></article>)}</div>
  <details><summary>浏览器存储详情</summary>{profiles.map(p=><p key={p.profileId}>{p.displayName}<small><CompactText text={`${p.storageKind} · ${p.storageSource} · ${p.proxyProfileId||'直连'}`}/></small></p>)}</details>
  {error?<p className="hint-warn" role="alert">{error}</p>:null}<footer>{!embedded?<button disabled={busy} onClick={onClose}>返回</button>:null}<button disabled={busy} onClick={()=>{clearManagementCache();void refresh();}}>刷新</button><button className="primary" disabled={busy||!loginTargets.some(t=>t.value===target)||(browserMode==='workbench'&&!profileId)||logins.some(l=>loginTargets.some(t=>t.value===target&&l.containerId===t.containerId)||(browserMode==='workbench'&&l.profileId===profileId))} onClick={()=>void mutate(async()=>{clearManagementCache();const selected=loginTargets.find(t=>t.value===target);if(!selected)throw Error('目标 Agent 或 CLI 不存在，请刷新后重试');const latest=await platformApi('/containers');const worker:Container|undefined=latest.containers.find((c:Container)=>c.containerId===selected.containerId);if(!worker||worker.status!=='ready')throw Error('目标 Agent 不存在或未就绪，请刷新后重试');let revision:number;const agentType=selected.agentType;if((worker.imageAgents?.length||0)>1){const clis=await platformApi(`/containers/${worker.containerId}/clis`);const cli=clis.clis?.find((item:CliOption)=>item.agentType===selected.agentType);if(!cli?.configured)throw Error('目标 CLI 尚未配置，请先保存其模型配置');revision=cli.revision;}
else{
  if(worker.agentType!==agentType||!(worker.requiresLogin||worker.authMethod==='oauth'))throw Error('目标 Agent 不存在、无需原生登录或配置尚未同步，请刷新后重试');
  // The refreshed container revision, never the snapshot from mount time.
  revision=worker.revision;if(worker.revision!==worker.appliedRevision)throw Error('目标 Agent 配置尚未同步，请刷新后重试');}
const result=await platformApi(`/containers/${selected.containerId}/login`,'POST',{revision,profileId:browserMode==='local'?(profileId||undefined):profileId,agentType,browserMode});setLogins(rows=>[result,...rows]);})}>{busy?'处理中…':'Worker 发起登录'}</button></footer></>;
 return embedded?<div className="pm-settings-form pm-login-workbench">{content}</div>:<Modal title="登录工作台" onClose={onClose} busy={busy}>{content}</Modal>;
}
