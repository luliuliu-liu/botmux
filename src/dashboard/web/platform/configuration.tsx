import {McpPage} from './mcp.js';
import {useState,useEffect} from 'react';
import {mountReactPage} from '../react-mount.js';
import {ManagementPage,platformApi,Modal,WorkspaceSettings} from './management-page.js';
import {clearManagementCache} from './management-cache.js';
import {ProxyPage} from './proxies.js';
import {AgentActions,CompactText,ConfigHelp} from './compact-controls.js';
import {ui} from '../ui.js';
import {CreateActionButton,RefreshIconButton} from '../dashboard-components.js';
import {CONFIGURATION_SECTIONS,ManagementLayout,useManagementSection} from './management-layout.js';

const kinds:Record<string,string>={docker:'Docker Registry',github:'GitHub'};
const legacyKinds:Record<string,string>={...kinds,feishu:'飞书',jimeng:'即梦',other:'其他 CLI'};
const gitRowOf=(profiles:any[],row:any)=>profiles.find(p=>p.credentialId===row.credentialId);
function Credentials(){
 const [rows,setRows]=useState<any[]>([]),[gitProfiles,setGitProfiles]=useState<any[]>([]),[edit,setEdit]=useState<any>(undefined),[error,setError]=useState('');
 const refresh=async()=>{try{const [credentials,profiles]=await Promise.all([platformApi('/credentials'),platformApi('/github-git-profiles')]);setRows(credentials.credentials);setGitProfiles(profiles.profiles||[]);setError('');}catch(e){setError(String(e));}};
 useEffect(()=>{void refresh();},[]);
 return <><div className="page-heading"><div><h2 className="pm-panel-title">CLI 凭证 <ConfigHelp>集中保管 Docker Registry 与 GitHub CLI 密钥；登录态由目标 Agent 原生 CLI 管理，密钥只写不回显。</ConfigHelp></h2></div><div className="page-heading-actions"><RefreshIconButton label="刷新凭证" onClick={()=>void refresh()}/><CreateActionButton onClick={()=>setEdit(null)}>新建凭证</CreateActionButton></div></div>
{error?<p role="alert">{error}</p>:null}
 <div className="pm-table-wrap"><table className="pm-summary-table pm-credential-table"><thead><tr><th>名称 / ID</th><th>用途</th><th>服务 / 用户</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map(r=><tr key={r.credentialId}><td><CompactText text={r.displayName}/><small><CompactText text={r.credentialId}/></small></td><td>{legacyKinds[r.kind]||r.kind}</td><td><CompactText text={r.endpoint||'默认服务'}/><small><CompactText text={r.username||''}/></small></td><td>密钥已保存 · v{r.revision}{r.kind==='github'?gitRowOf(gitProfiles,r)?<small>Git：{gitRowOf(gitProfiles,r).gitName} · {gitRowOf(gitProfiles,r).registrationState==='registered'?`已登记${gitRowOf(gitProfiles,r).githubAccount?` · ${gitRowOf(gitProfiles,r).githubAccount}`:''}`:'公钥登记待完成'}</small>:<small>未建 Git 配置</small>:null}</td><td><AgentActions name={r.displayName} actions={[{label:'编辑',run:()=>setEdit(r)},...(r.kind==='github'&&gitRowOf(gitProfiles,r)&&gitRowOf(gitProfiles,r).registrationState!=='registered'?[{label:'重试公钥登记',run:()=>void platformApi('/github-git-profiles/'+r.credentialId+'/register','POST',{}).then(refresh).catch(e=>setError(String(e)))}]:[]),{label:'删除',danger:true,run:()=>{if(window.confirm(`删除凭证「${r.displayName}」？${r.kind==='github'?'关联的 Git 配置一并删除；':''}不会注销 Agent 上已有登录态与 GitHub 公钥。`))void platformApi('/credentials/'+r.credentialId,'DELETE',{revision:r.revision}).then(refresh).catch(e=>setError(String(e)));}}]}/></td></tr>)}</tbody></table>{!rows.length?<p className="empty">暂无 CLI 凭证</p>:null}</div>

 {edit!==undefined?<CredentialForm row={edit} gitProfile={edit?gitProfiles.find(p=>p.credentialId===edit.credentialId):undefined} close={()=>setEdit(undefined)} done={()=>{setEdit(undefined);void refresh();}}/>:null}</>;
}
function CredentialForm({row,gitProfile,close,done}:{row:any;gitProfile:any;close:()=>void;done:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const [kind,setKind]=useState(row?.kind||'docker');
 // GitHub credentials carry the Git identity and SSH registration with them;
 // Docker credentials keep the registry address and username.
 return <Modal title={row?'编辑 CLI 凭证':'新建 CLI 凭证'} busy={busy} onClose={close}><form autoComplete="off" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');const f=Object.fromEntries(new FormData(e.currentTarget));try{
  if(kind==='github'){
   await platformApi('/credentials/'+encodeURIComponent(String(f.id)),'PUT',{displayName:f.name,kind:'github',endpoint:'github.com',username:'',revision:row?.revision??0,...(f.secret?{secret:f.secret}:{})});
   await platformApi('/github-git-profiles/'+encodeURIComponent(String(f.id)),'PUT',{displayName:f.name,gitName:f.gitName,gitEmail:f.gitEmail,credentialId:String(f.id),...(f.secret?{token:String(f.secret)}:row?{token:''}:{token:undefined}),revision:gitProfile?.revision??0});
  }else{
   await platformApi('/credentials/'+encodeURIComponent(String(f.id)),'PUT',{displayName:f.name,kind:'docker',endpoint:f.endpoint,username:f.username,revision:row?.revision??0,...(f.secret?{secret:f.secret}:{})});
  }
  done();}catch(e){setError(String(e));}finally{setBusy(false);}}}>
 <label>凭证 ID<input name="id" required pattern="[A-Za-z0-9._-]+" maxLength={100} defaultValue={row?.credentialId} readOnly={!!row}/></label>
 <label>名称<input name="name" required maxLength={200} defaultValue={row?.displayName}/></label>
 <label>用途<select name="kind" value={kind} onChange={e=>setKind(e.target.value)} disabled={!!row}>{Object.entries(kinds).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
 {kind==='github'?<>
  <label>GitHub Classic Token<input name="secret" type="password" autoComplete="new-password" required={!row&&!gitProfile} maxLength={16384} placeholder={row||gitProfile?'留空保留已保存的 Token':'ghp_…（需要 repo 与 write:public_key 权限）'}/></label>
  <label>Git 提交者姓名<input name="gitName" required maxLength={200} defaultValue={gitProfile?.gitName}/></label>
  <label>Git 提交者邮箱<input name="gitEmail" required maxLength={200} defaultValue={gitProfile?.gitEmail}/></label>
  <ConfigHelp>保存后生成 SSH 密钥并用该 Token 向 GitHub 登记公钥；Agent 的“登录 CLI”里可选择此凭证应用 gh / Git 配置。</ConfigHelp>
 </>:<>
  <label>服务地址（可选）<input name="endpoint" maxLength={500} placeholder="registry.example.com" defaultValue={row?.endpoint}/></label>
  <label>用户名（可选）<input name="username" maxLength={200} defaultValue={row?.username}/></label>
  <label>密钥 / Token<input name="secret" type="password" autoComplete="new-password" required={!row} maxLength={16384} placeholder={row?'留空保留原密钥':'填写密钥或 Token'}/></label>
 </>}
 {error?<p role="alert">{error}</p>:null}<footer><button type="button" onClick={close} disabled={busy}>取消</button><button className="primary" disabled={busy}>保存</button></footer></form></Modal>;
}
export function WorkspacePage(){
 const [options,setOptions]=useState<any>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{let live=true;void platformApi('/workspaces').then(value=>{if(live)setOptions(value);}).catch(e=>{if(live)setError(String(e));}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[]);
 const refresh=async()=>{clearManagementCache();setLoading(true);try{setOptions(await platformApi('/workspaces'));setError('');}catch(e){setError(String(e));}finally{setLoading(false);}};
 return <><div className="page-heading"><div><h2 className="pm-panel-title">工作区设置 <ConfigHelp>设置新建 Agent 的默认目录，已有挂载保持不变。</ConfigHelp></h2></div><RefreshIconButton label="刷新工作区设置" busy={loading} onClick={()=>void refresh()}/></div>
 {error?<p className="hint-warn" role="alert">{error}</p>:null}{notice?<p className="pm-info-note" role="status">{notice}</p>:null}
 {loading?<p role="status">正在加载工作区设置…</p>:options?<WorkspaceSettings key={(options.defaultHostPath||'default')+'|'+(options.globalReadOnlyHostPath||'')} embedded options={options} onClose={()=>{}} onDone={message=>{setNotice(message);void refresh();}}/>:<button onClick={()=>void refresh()}>重新加载</button>}</>;
}
export function Configuration({initial='models'}:{initial?:string}){
 const tab=useManagementSection(CONFIGURATION_SECTIONS,initial);
 if(!ui.platformManaged)return <section className="page"><h1>平台管理未启用</h1></section>;
 return <ManagementLayout title="密钥与配置管理" description="集中管理模型连接、网络代理、CLI 凭证与工作区" route="#/platform-configuration" sections={CONFIGURATION_SECTIONS} section={tab}>{tab==='models'?<ManagementPage page="models" embedded/>:tab==='proxies'?<ProxyPage embedded/>:tab==='workspaces'?<WorkspacePage/>:tab==='mcps'?<McpPage/>:<Credentials/>}</ManagementLayout>;
}
export function renderConfigurationPage(root:HTMLElement){return mountReactPage(root,<Configuration/>);}
export function renderModelsConfigurationPage(root:HTMLElement){return mountReactPage(root,<Configuration initial="models"/>);}
export function renderProxyConfigurationPage(root:HTMLElement){return mountReactPage(root,<Configuration initial="proxies"/>);}
