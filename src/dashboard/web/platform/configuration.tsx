import {useState,useEffect} from 'react';
import {mountReactPage} from '../react-mount.js';
import {ManagementPage,platformApi,Modal,WorkspaceSettings} from './management-page.js';
import {clearManagementCache} from './management-cache.js';
import {ProxyPage} from './proxies.js';
import {AgentActions} from './compact-controls.js';
import {ui} from '../ui.js';
import {CreateActionButton,RefreshIconButton} from '../dashboard-components.js';
import {CONFIGURATION_SECTIONS,ManagementLayout,useManagementSection} from './management-layout.js';

const kinds:Record<string,string>={docker:'Docker Registry',github:'GitHub',feishu:'飞书',jimeng:'即梦',other:'其他 CLI'};
function Credentials(){
 const [rows,setRows]=useState<any[]>([]),[edit,setEdit]=useState<any>(undefined),[error,setError]=useState('');
 const refresh=()=>platformApi('/credentials').then(r=>{setRows(r.credentials);setError('');}).catch(e=>setError(String(e)));
 useEffect(()=>{void refresh();},[]);
 return <><div className="page-heading"><div><h2 className="pm-panel-title">CLI 凭证</h2><p className="hint">集中保管 CLI 访问密钥，只写不回显。</p></div><div className="page-heading-actions"><RefreshIconButton label="刷新凭证" onClick={()=>void refresh()}/><CreateActionButton onClick={()=>setEdit(null)}>新建凭证</CreateActionButton></div></div>
 <p className="pm-info-note">凭证加密保存，不会自动登录或分发到 Agent。OAuth 与浏览器 Cookie 仍由所属 Agent 的原生登录流程管理。</p>{error?<p role="alert">{error}</p>:null}
 <div className="pm-table-wrap"><table><thead><tr><th>名称 / ID</th><th>用途</th><th>服务 / 用户</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map(r=><tr key={r.credentialId}><td>{r.displayName}<small>{r.credentialId}</small></td><td>{kinds[r.kind]}</td><td>{r.endpoint||'默认服务'}<small>{r.username}</small></td><td>密钥已保存 · v{r.revision}</td><td><AgentActions name={r.displayName} actions={[{label:'编辑',run:()=>setEdit(r)},{label:'删除',danger:true,run:()=>{if(window.confirm(`删除凭证「${r.displayName}」？不会注销 Agent 上已有登录态。`))void platformApi('/credentials/'+r.credentialId,'DELETE',{revision:r.revision}).then(refresh).catch(e=>setError(String(e)));}}]}/></td></tr>)}</tbody></table>{!rows.length?<p className="empty">暂无 CLI 凭证</p>:null}</div>
 <details className="pm-disclosure"><summary>原生登录入口与边界</summary><p>Docker 使用 docker login；GitHub 使用 gh auth login；飞书使用 lark-cli auth login；即梦使用 dreamina-canvas auth login。在目标 Agent 终端执行，登录态保留在该 Agent 的 /state。飞书管理账号在 <a href="#/platform-agents?section=bots">Bot 管理</a> 登录，Agent OAuth 在 <a href="#/platform-agents?section=logins">登录工作台</a> 发起。</p></details>
 {edit!==undefined?<CredentialForm row={edit} close={()=>setEdit(undefined)} done={()=>{setEdit(undefined);void refresh();}}/>:null}</>;
}
function CredentialForm({row,close,done}:{row:any;close:()=>void;done:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 return <Modal title={row?'编辑 CLI 凭证':'新建 CLI 凭证'} busy={busy} onClose={close}><form autoComplete="off" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');const f=Object.fromEntries(new FormData(e.currentTarget));try{await platformApi('/credentials/'+encodeURIComponent(String(f.id)),'PUT',{displayName:f.name,kind:f.kind,endpoint:f.endpoint,username:f.username,revision:row?.revision??0,...(f.secret?{secret:f.secret}:{})});done();}catch(e){setError(String(e));}finally{setBusy(false);}}}>
 <label>凭证 ID<input name="id" required pattern="[A-Za-z0-9._-]+" maxLength={100} defaultValue={row?.credentialId} readOnly={!!row}/></label>
 <label>名称<input name="name" required maxLength={200} defaultValue={row?.displayName}/></label>
 <label>用途<select name="kind" defaultValue={row?.kind||'docker'}>{Object.entries(kinds).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
 <label>服务地址（可选）<input name="endpoint" maxLength={500} placeholder="registry.example.com" defaultValue={row?.endpoint}/></label>
 <label>用户名（可选）<input name="username" maxLength={200} defaultValue={row?.username}/></label>
 <label>密钥 / Token<input name="secret" type="password" autoComplete="new-password" required={!row} maxLength={16384} placeholder={row?'留空保留原密钥':'填写密钥或 Token'}/></label>
 {error?<p role="alert">{error}</p>:null}<footer><button type="button" onClick={close} disabled={busy}>取消</button><button className="primary" disabled={busy}>保存</button></footer></form></Modal>;
}
export function WorkspacePage(){
 const [options,setOptions]=useState<any>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{let live=true;void platformApi('/workspaces').then(value=>{if(live)setOptions(value);}).catch(e=>{if(live)setError(String(e));}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[]);
 const refresh=async()=>{clearManagementCache();setLoading(true);try{setOptions(await platformApi('/workspaces'));setError('');}catch(e){setError(String(e));}finally{setLoading(false);}};
 return <><div className="page-heading"><div><h2 className="pm-panel-title">工作区设置</h2><p className="hint">设置新建 Agent 的默认目录，已有挂载保持不变。</p></div><RefreshIconButton label="刷新工作区设置" busy={loading} onClick={()=>void refresh()}/></div>
 {error?<p className="hint-warn" role="alert">{error}</p>:null}{notice?<p className="pm-info-note" role="status">{notice}</p>:null}
 {loading?<p role="status">正在加载工作区设置…</p>:options?<WorkspaceSettings key={options.defaultHostPath||'default'} embedded options={options} onClose={()=>{}} onDone={message=>{setNotice(message);void refresh();}}/>:<button onClick={()=>void refresh()}>重新加载</button>}</>;
}
export function Configuration({initial='models'}:{initial?:string}){
 const tab=useManagementSection(CONFIGURATION_SECTIONS,initial);
 if(!ui.platformManaged)return <section className="page"><h1>平台管理未启用</h1></section>;
 return <ManagementLayout title="密钥与配置管理" description="集中管理模型连接、网络代理、CLI 凭证与工作区" route="#/platform-configuration" sections={CONFIGURATION_SECTIONS} section={tab}>{tab==='models'?<ManagementPage page="models" embedded/>:tab==='proxies'?<ProxyPage embedded/>:tab==='workspaces'?<WorkspacePage/>:<Credentials/>}</ManagementLayout>;
}
export function renderConfigurationPage(root:HTMLElement){return mountReactPage(root,<Configuration/>);}
export function renderModelsConfigurationPage(root:HTMLElement){return mountReactPage(root,<Configuration initial="models"/>);}
export function renderProxyConfigurationPage(root:HTMLElement){return mountReactPage(root,<Configuration initial="proxies"/>);}
