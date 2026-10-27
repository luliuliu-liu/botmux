import {useEffect,useState} from 'react';
import {mountReactPage} from '../react-mount.js';
import {platformApi,Modal} from './management-page.js';
import {AgentActions,Parameter,PlatformSwitch} from './compact-controls.js';
import {CreateActionButton,RefreshIconButton} from '../dashboard-components.js';
import {clearManagementCache} from './management-cache.js';
export function ProxySelect({name='proxyProfileId',value,onChange,defaultValue}:{name?:string;value?:string;defaultValue?:string|null;onChange?:(value:string)=>void}){
 const [rows,setRows]=useState<any[]>([]),[error,setError]=useState(''),[selection,setSelection]=useState(defaultValue||'');
 const selected=value??selection;
 useEffect(()=>{setSelection(defaultValue||'');},[defaultValue]);
 useEffect(()=>{void platformApi('/proxies').then(r=>setRows(r.proxies??[])).catch(e=>setError(String(e)));},[]);
 return <label><Parameter help="留空直连。全局模式经上游代理；路由模式按域名规则选择代理/直连。修改配置后需同步 Agent。">Proxy</Parameter><select name={name} value={selected} onChange={e=>{if(value===undefined)setSelection(e.target.value);onChange?.(e.target.value);}}><option value="">不使用 Proxy · 直连</option>{selected&&!rows.some(row=>row.profileId===selected)?<option value={selected}>{selected} · {error?'代理列表加载失败，保留当前选择':'正在加载代理配置…'}</option>:null}{rows.filter(row=>row.enabled||row.profileId===selected).map(row=><option key={row.profileId} value={row.profileId} disabled={!row.enabled}>{row.displayName} · {row.configuration.mode==='global'?'全局':'路由'} · v{row.revision}</option>)}</select>{error?<small role="alert">{error}</small>:null}</label>;
}
export function ProxyPage({embedded=false}:{embedded?:boolean}){
 const [rows,setRows]=useState<any[]>([]),[edit,setEdit]=useState<any>(undefined),[error,setError]=useState('');
 const refresh=()=>platformApi('/proxies').then(r=>setRows(r.proxies)).catch(e=>setError(String(e)));
 useEffect(()=>{void refresh();},[]);
 return <section className={embedded?'pm-page':'page pm-page'}><div className="page-heading"><div>{embedded?<h2 className="pm-panel-title">Proxy</h2>:<h1>Proxy 管理</h1>}<p className="hint">Agent 与浏览器可独立引用，支持全局或按域名路由。</p></div><div className="page-heading-actions"><RefreshIconButton label="刷新 Proxy" onClick={()=>{clearManagementCache();void refresh();}}/><CreateActionButton onClick={()=>setEdit(null)}>新建 Proxy</CreateActionButton></div></div>{error?<p role="alert">{error}</p>:null}<div className="pm-table-wrap"><table><thead><tr><th>名称</th><th>模式 / 端点</th><th>版本 / 状态</th><th>操作</th></tr></thead><tbody>{rows.map(row=><tr key={row.profileId}><td>{row.displayName}<small>{row.profileId}</small></td><td>{row.configuration.mode==='global'?'全局':'路由'}<small>{row.configuration.url}</small></td><td>v{row.revision}<small className={row.enabled?'pm-status-ready':''}>{row.enabled?'已启用':'已停用'}</small></td><td><AgentActions name={row.displayName} actions={[{label:'编辑',run:()=>setEdit(row)},{label:'删除',danger:true,run:()=>{if(window.confirm(`删除 Proxy「${row.displayName}」？被引用的配置不能删除。`))void platformApi('/proxies/'+row.profileId,'DELETE',{}).then(refresh).catch(e=>setError(String(e)));}}]}/></td></tr>)}</tbody></table>{!rows.length?<p className="empty">暂无 Proxy 配置</p>:null}</div><p className="pm-info-note">保存后，请在引用此 Proxy 的 Agent 中同步配置。</p>{edit!==undefined?<ProxyForm row={edit} onClose={()=>setEdit(undefined)} done={()=>{setEdit(undefined);void refresh();}}/>:null}</section>;
}
function ProxyForm({row,onClose,done}:{row:any;onClose:()=>void;done:()=>void}){
 const [mode,setMode]=useState(row?.configuration.mode||'global'),[rules,setRules]=useState(JSON.stringify(row?.configuration.rules||[{host:'*.anthropic.com',action:'proxy'}],null,2)),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 return <Modal title={row?'编辑 Proxy':'新建 Proxy'} onClose={onClose} busy={busy}><form onSubmit={async e=>{e.preventDefault();const fields=Object.fromEntries(new FormData(e.currentTarget));setBusy(true);try{await platformApi('/proxies/'+fields.id,'PUT',{displayName:fields.name,revision:row?.revision??0,enabled:fields.enabled==='on',configuration:{mode,url:fields.url,defaultAction:mode==='global'?'proxy':fields.defaultAction,rules:mode==='global'?[]:JSON.parse(rules)}});done();}catch(e){setError(String(e));}finally{setBusy(false);}}}>
 <label>配置 ID<input name="id" pattern="[A-Za-z0-9._-]+" defaultValue={row?.profileId} readOnly={!!row} required/></label><label>名称<input name="name" defaultValue={row?.displayName} required/></label>
 <label>模式<select value={mode} onChange={e=>setMode(e.target.value)}><option value="global">全局</option><option value="routed">路由</option></select></label>
 <label>上游 HTTP Proxy<input name="url" type="url" required defaultValue={row?.configuration.url} placeholder="http://host.docker.internal:7890"/></label>
 {mode==='routed'?<><label>未命中规则<select name="defaultAction" defaultValue={row?.configuration.defaultAction||'direct'}><option value="direct">直连</option><option value="proxy">代理</option></select></label><label>有序域名规则 JSON<textarea rows={10} value={rules} onChange={e=>setRules(e.target.value)}/></label></>:null}
 <PlatformSwitch name="enabled" defaultChecked={row?.enabled??true} disabled={busy} title="启用 Proxy" description="停用后不再提供给新实例选择。"/>
 {error?<p role="alert">{error}</p>:null}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy}>{busy?'保存中…':'保存'}</button></footer></form></Modal>;
}
export function renderProxiesPage(root:HTMLElement){return mountReactPage(root,<ProxyPage/>);}
