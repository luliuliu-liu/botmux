import {useEffect,useRef,useState} from 'react';
import {Modal,platformApi,type Container} from './management-page.js';
import {ProxySelect} from './proxies.js';
import {Parameter} from './compact-controls.js';
import {hostFirst,imageOptionLabel} from './image-utils.js';
import type {CachedImage} from './image-catalog.js';
export function BrowserInstanceForm({container,onClose,onDone}:{container:Container|null;onClose:()=>void;onDone:(s:string)=>void}){
 const requestId=useRef(crypto.randomUUID()),[images,setImages]=useState<CachedImage[]>([]),[hostArch,setHostArch]=useState<string|undefined>(),[storage,setStorage]=useState('volume'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{if(container)return;void platformApi('/image-cache').then(v=>{setImages(v.images.filter((i:CachedImage)=>i.roles.includes('browser')&&i.agents.includes('browser')));setHostArch(v.hostArch);}).catch(e=>setError(String(e)));},[]);
 return <Modal title={container?'浏览器实例配置':'创建浏览器实例'} onClose={onClose} busy={busy}><form onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');const v=Object.fromEntries(new FormData(e.currentTarget));try{await platformApi(container?`/browsers/${container.containerId}`:'/browsers',container?'PUT':'POST',container?{revision:container.revision,proxyProfileId:v.proxyProfileId||null}:{...v,requestId:requestId.current,storageKind:storage,proxyProfileId:v.proxyProfileId||null,confirmSensitiveStorage:v.confirmSensitiveStorage==='on'});onDone(container?'浏览器 Proxy 已同步':'浏览器实例已创建，将持续运行直到手动删除');}catch(err){setError(String(err));}finally{setBusy(false);}}}>
  <label>名称<input required name="displayName" maxLength={64} defaultValue={container?.displayName||''} disabled={!!container}/></label>
  <label>浏览器镜像{container?<input disabled value={container.image}/>:<select name="image" required><option value="">选择本地浏览器镜像</option>{hostFirst(images,hostArch).map(i=>{const foreign=!!i.architecture&&!!hostArch&&i.architecture!==hostArch;return <option key={i.id} value={i.id} disabled={foreign}>{imageOptionLabel(i.tags,i.id,i.architecture,hostArch)}</option>;})}</select>}</label>
  {!container&&!images.length?<p className="hint-warn">暂无本地浏览器镜像，请先到“支持的 Agent”刷新或拉取镜像。</p>:null}
  <ProxySelect defaultValue={container?.proxyProfileId}/>
  {container?<label>浏览器数据目录<input disabled value={`${container.workspaceKind} · ${container.workspaceClaim}`}/></label>:<><label><Parameter help="浏览器配置和 Cookie 保存在 /profile。默认创建独立 volume；hostPath 必须使用专用私有目录，不与登录工作台共用。">浏览器数据存储</Parameter><select value={storage} onChange={e=>setStorage(e.target.value)}><option value="volume">新建独立 volume</option><option value="hostpath">hostPath · 专用宿主机目录</option></select></label>{storage==='hostpath'?<><label>hostPath<input required name="storageSource" placeholder="/absolute/path/to/browser-profile"/></label><label className="pm-check"><input type="checkbox" name="confirmSensitiveStorage" required/>确认该目录专供此浏览器使用，包含 Cookie 和登录信息。</label></>:null}</>}
  <p className="pm-info-note">手动管理的浏览器实例，不设置到期时间，不随登录会话结束自动销毁。无需模型或 Bot。删除实例默认保留浏览器数据目录。</p>
  {error?<p className="hint-warn" role="alert">{error}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||!container&&!images.length}>{busy?'处理中…':container?'保存并同步':'创建浏览器实例'}</button></footer>
 </form></Modal>;
}
export function DeleteBrowserInstance({container,onClose,onDone}:{container:Container;onClose:()=>void;onDone:(s:string)=>void}){
 const [confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 return <Modal title="删除浏览器实例" onClose={onClose} busy={busy}><p>关闭并删除「{container.displayName}」的容器，浏览器数据目录保留。</p><label className="pm-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>确认关闭浏览器并删除实例</label>{error?<p role="alert">{error}</p>:null}<footer><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||!confirmed} onClick={async()=>{setBusy(true);try{const r=await platformApi(`/browsers/${container.containerId}`,'DELETE',{revision:container.revision,confirmDelete:true});if(!r.deleted)throw Error('删除未确认');onDone('浏览器实例已删除，数据目录保留');}catch(e){setError(String(e));}finally{setBusy(false);}}}>确认删除</button></footer></Modal>;
}
