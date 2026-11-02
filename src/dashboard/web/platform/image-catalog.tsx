import {useEffect,useState} from 'react';
import {Modal,platformApi} from './management-page.js';
import {AgentActions,CompactText,Parameter,ConfigHelp} from './compact-controls.js';
import {registryHostOfTags,remoteSourceOfTags,shortImageRef} from './image-utils.js';
import {copyText} from '../clipboard.js';
export type CatalogAgent={id:string;name:string;supported:boolean;version:string|null;protocols?:string[];authMethods?:string[];images:Array<{id:string;image:string;label:string}>};
export type CachedImage={id:string;tags:string[];agents:string[];roles:string[];size:number;architecture?:string;os?:string;digests?:string[];created?:number};
type RemoteImage={key:string;id:string;reference:string;tag:string;registry:string;digest:string;agents:string[];roles:string[];size:number;architecture:string;os:string;created?:string};
type Cache={images:CachedImage[];remote:RemoteImage[];sources:string[];updatedAt:string|null;hostArch?:string};
const empty:Cache={images:[],remote:[],sources:[],updatedAt:null};
export function imageSize(bytes:number){return bytes>0?bytes>=1024**3?`${(bytes/1024**3).toFixed(2)} GB`:`${(bytes/1024**2).toFixed(0)} MB`:'—';}
export function catalogImages(agent:CatalogAgent,cache:Cache){
 const grouped=new Map<string,{id:string;local?:CachedImage;remote:RemoteImage[]}>();
 for(const local of cache.images.filter(i=>i.agents.includes(agent.id)&&(agent.id==='browser'?i.roles.includes('browser'):i.roles.includes('worker'))))grouped.set(local.id,{id:local.id,local,remote:[]});
 for(const remote of cache.remote.filter(i=>i.agents.includes(agent.id)&&(agent.id==='browser'?i.roles.includes('browser'):i.roles.includes('worker')))){
  const item=grouped.get(remote.id)||{id:remote.id,remote:[]};item.remote.push(remote);grouped.set(remote.id,item);
 }
 const archOf=(entry:{local?:CachedImage;remote:RemoteImage[]})=>entry.local?.architecture??entry.remote[0]?.architecture;
 return [...grouped.values()].sort((a,b)=>{
  const af=archOf(a)&&cache.hostArch&&archOf(a)!==cache.hostArch?1:0;
  const bf=archOf(b)&&cache.hostArch&&archOf(b)!==cache.hostArch?1:0;
  return af-bf;
 });
}
export function ImageCatalog({agents}:{agents:CatalogAgent[]}){
 const [cache,setCache]=useState<Cache>(empty),[open,setOpen]=useState<string|null>(null),[registry,setRegistry]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [selected,setSelected]=useState<string[]>([]);
 const reload=async()=>{try{const value=await platformApi('/image-cache');if(!Array.isArray(value.images)||!Array.isArray(value.remote))throw Error('镜像缓存响应无效，请刷新后重试');setCache(value);setError('');}catch(e){setError(String(e));}};
 useEffect(()=>{void reload();},[]);
 const operation=async(path:string,body:unknown)=>{setBusy(true);setError('');try{setCache(await platformApi(path,'POST',body));if(path==='/image-cache/pull')setSelected(current=>current.filter(key=>key!==(body as {key:string}).key));}catch(e){setError(String(e));}finally{setBusy(false);}};
 const pullSelected=async()=>{setBusy(true);setError('');setNotice('');const failed:string[]=[];let succeeded=0;try{for(const key of selected){try{setCache(await platformApi('/image-cache/pull','POST',{key}));succeeded++;}catch{failed.push(key);}}setSelected(failed);if(failed.length)setError(`已拉取 ${succeeded} 个镜像，${failed.length} 个失败；失败项保留选中，请检查网络后重试。`);else setNotice(`已拉取 ${succeeded} 个镜像。`);}finally{setBusy(false);}};
 const copy=async(value:string)=>{if(await copyText(value,'请复制镜像引用'))setNotice('镜像引用已复制');else setError('无法写入剪贴板，请手动复制镜像引用');};
 return <div className="pm-image-catalog"><div className="pm-catalog-toolbar"><span className="hint"><Parameter help="镜像目录按本机架构展示，创建和升级仅使用本地兼容镜像；查询不自动拉取。">本地配置</Parameter> · {cache.updatedAt?`缓存更新于 ${new Date(cache.updatedAt).toLocaleTimeString()}`:'尚未刷新缓存'}</span><div className="pm-inline-actions"><button disabled={busy||!selected.length} onClick={()=>void pullSelected()}>拉取选中（{selected.length}）</button><button disabled={busy} onClick={()=>void operation('/image-cache/refresh',{})}>刷新本地 Docker</button><button disabled={busy} onClick={()=>setRegistry(true)}>查询远端仓库</button></div></div>
  {error?<p role="alert" className="hint-warn">{error}</p>:null}{busy?<p role="status" className="hint">正在读取或拉取镜像，请稍候…</p>:null}{notice?<p role="status" className="hint">{notice}</p>:null}
  <div className="pm-table-wrap"><table className="pm-catalog-table"><thead><tr><th>类型</th><th>部署范围</th><th>认证方式</th><th>模型来源</th><th>可用镜像</th></tr></thead><tbody>{agents.map(agent=>{
   const entries=catalogImages(agent,cache),isBrowser=agent.id==='browser',hasDev=agent.images.some(i=>i.id==='dev');
   return <CatalogRows key={agent.id} agent={agent} entries={entries} isBrowser={isBrowser} hasDev={hasDev} expanded={open===agent.id} busy={busy} hostArch={cache.hostArch} selected={selected} onSelect={(key,checked)=>setSelected(current=>checked?[...new Set([...current,key])]:current.filter(v=>v!==key))} onToggle={()=>setOpen(open===agent.id?null:agent.id)} onCopy={v=>void copy(v)} onPull={key=>void operation('/image-cache/pull',{key})} onPullLatest={(registry,repository,pullAgent,role)=>void operation('/image-cache/pull-latest',{registry,repository,agent:pullAgent,role})} onRemove={id=>void operation('/image-cache/remove',{id})}/>;
  })}</tbody></table></div>

  {registry?<RegistryQuery sources={cache.sources} onClose={()=>setRegistry(false)} onDone={value=>{setCache(value);setSelected([]);setRegistry(false);}}/>:null}
 </div>;
}
function CatalogRows({agent,entries,isBrowser,hasDev,expanded,busy,hostArch,selected,onSelect,onToggle,onCopy,onPull,onPullLatest,onRemove}:{agent:CatalogAgent;entries:ReturnType<typeof catalogImages>;isBrowser:boolean;hasDev:boolean;expanded:boolean;busy:boolean;hostArch?:string;selected:string[];onSelect:(key:string,checked:boolean)=>void;onToggle:()=>void;onCopy:(s:string)=>void;onPull:(s:string)=>void;onPullLatest:(registry:string,repository:string,agent:string,role:string)=>void;onRemove:(id:string)=>void}){
 return <><tr><td><strong>{agent.name}</strong><small>{isBrowser?'浏览器专用镜像':`CLI ${agent.version||'版本随镜像固定'}`}</small></td><td>{hasDev?<span className="pm-role-tag">Dev</span>:null}<span className="pm-role-tag">{isBrowser?'浏览器':'Worker'}</span></td><td>{isBrowser?'无需模型认证':agent.protocols?.includes('vercel-claude')?'Vercel + 订阅':agent.authMethods?.map(a=><span className="pm-auth-tag" key={a}>{a==='oauth'?'OAuth':'API Key'}</span>)}</td><td>{isBrowser?'—':agent.id==='zcode'?'动态模型列表':agent.authMethods?.includes('oauth')?'原生 / 模型管理':'模型管理'}</td><td><button className="pm-image-toggle" aria-expanded={expanded} onClick={onToggle}>{entries.length} 个版本 <span aria-hidden="true">{expanded?'⌄':'›'}</span></button></td></tr>
  {expanded?<tr className="pm-image-expanded"><td colSpan={5}><div className="pm-image-versions"><div className="pm-bot-list-heading"><strong>{agent.name} 镜像 <ConfigHelp>查询远端不会自动下载，创建和升级使用本地已缓存兼容镜像。</ConfigHelp></strong><span>本地与远端按镜像内容摘要合并</span></div><table><thead><tr><th>镜像 / Tag</th><th>来源</th><th>架构</th><th><Parameter help="本地显示 Docker 报告的镜像大小；远端显示选定架构的压缩下载大小，两者不能直接比较。">大小</Parameter></th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{entries.map(entry=>{
   return <VersionRow key={entry.id} entry={entry} agentId={agent.id} role={isBrowser?'browser':'worker'} busy={busy} hostArch={hostArch} selected={selected} onSelect={onSelect} onCopy={onCopy} onPull={onPull} onPullLatest={onPullLatest} onRemove={onRemove}/>;
  })}</tbody></table>{!entries.length?<p className="empty">没有可用镜像，请刷新本地 Docker 或查询远端仓库。</p>:null}</div></td></tr>:null}
 </>;
}
function formatCreated(value:number|string|undefined){
 if(value===undefined||value===null||value==='')return '—';
 const date=typeof value==='number'?new Date(value*1000):new Date(value);
 return Number.isNaN(date.getTime())?'—':date.toLocaleString(undefined,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function VersionRow({entry,agentId,role,busy,hostArch,selected,onSelect,onCopy,onPull,onPullLatest,onRemove}:{entry:{id:string;local?:CachedImage;remote:RemoteImage[]};agentId:string;role:string;busy:boolean;hostArch?:string;selected:string[];onSelect:(key:string,checked:boolean)=>void;onCopy:(s:string)=>void;onPull:(s:string)=>void;onPullLatest:(registry:string,repository:string,agent:string,role:string)=>void;onRemove:(id:string)=>void}){
 const [confirmRemove,setConfirmRemove]=useState(false);
 useEffect(()=>{if(!confirmRemove)return;const timer=setTimeout(()=>setConfirmRemove(false),4000);return ()=>clearTimeout(timer);},[confirmRemove]);
 const tags=entry.local?.tags.length?entry.local.tags:entry.remote.map(r=>r.reference),remote=entry.remote[0];
 const shorts=[...new Set(tags.map(shortImageRef))];
 const localRegistry=entry.local?registryHostOfTags(entry.local.tags):null;
 const architecture=entry.local?.architecture??remote?.architecture,os=entry.local?.os??remote?.os??'linux';
 const foreign=!!architecture&&!!hostArch&&architecture!==hostArch;
 const remoteSource=remote?{registry:remote.registry,repository:remote.reference.slice(remote.reference.lastIndexOf('/')+1).split(':')[0]!}:remoteSourceOfTags(entry.local?.tags??[]);
 const created=formatCreated(entry.local?.created??remote?.created);
 const actions=[
  ...(entry.local?[{label:'复制引用',run:()=>onCopy(tags[0]||entry.id)}]:[]),
  ...(remoteSource?[{label:'拉取最新',run:()=>onPullLatest(remoteSource.registry,remoteSource.repository,agentId,role)}]:[]),
  ...(!entry.local&&remote?[{label:'拉取',run:()=>onPull(remote.key)}]:[]),
  ...(entry.local?[{label:confirmRemove?'确认删除':'删除',danger:true,run:()=>{if(confirmRemove){setConfirmRemove(false);onRemove(entry.id);}else setConfirmRemove(true);}}]:[]),
 ];
 return <tr><td><div className="pm-image-reference">{!entry.local&&remote?<input type="checkbox" aria-label={`选择镜像 ${remote.reference}`} checked={selected.includes(remote.key)} disabled={busy||foreign} onChange={e=>onSelect(remote.key,e.target.checked)}/>:null}<div>{shorts.length?shorts.slice(0,2).map(tag=><div key={tag} title={tags.join('\n')}><CompactText text={tag}/></div>).concat(shorts.length>2?<div key="more" className="pm-arch-note">…另有 {shorts.length-2} 个 Tag</div>:[]):<CompactText text={entry.id}/>}<small><CompactText text={entry.id}/></small></div></div></td>
  <td>{entry.local?<span className="pm-role-tag" title={localRegistry?`本地 Docker · ${localRegistry}`:'本地 Docker'}>本地</span>:null}{remote?<span className="pm-role-tag" title={remote.registry}>远端</span>:null}</td>
  <td><span className={foreign?'pm-arch-foreign':'pm-arch-note'}>{os}/{architecture||'—'}</span>{foreign?<small className="pm-arch-note">不可在本机运行</small>:null}</td>
  <td>{entry.local?<div className="pm-image-size">{imageSize(entry.local.size)}<small>本地大小</small></div>:null}{remote?<div className="pm-image-size">{imageSize(remote.size)}<small>压缩大小</small></div>:null}</td>
  <td><span className="pm-arch-note" title={created}>{created}</span></td>
  <td><span className={`pm-sync-dot ${entry.local?'is-synced':''}`}>{entry.local?'本地可用':'未拉取'}</span></td>
  <td><AgentActions name="镜像" actions={actions} disabled={busy}/></td></tr>;
}

function RegistryQuery({sources,onClose,onDone}:{sources:string[];onClose:()=>void;onDone:(cache:Cache)=>void}){
 const [registry,setRegistry]=useState(sources[0]||''),[credentials,setCredentials]=useState<any[]>([]),[credentialId,setCredentialId]=useState(''),[namespace,setNamespace]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const select=(c:any)=>{setCredentialId(c?.credentialId||'');if(c){const endpoint=String(c.endpoint||'').replace(/^https?:\/\//,'').replace(/\/$/,'');const [host,...path]=endpoint.split('/');setRegistry(host||'');setNamespace(path.join('/')||c.username||'');}};
 useEffect(()=>{void platformApi('/credentials').then(v=>{const rows=v.credentials.filter((c:any)=>c.kind==='docker'&&c.endpoint);setCredentials(rows);if(rows.length)select(rows[0]);}).catch(e=>setError(String(e)));},[]);
 return <Modal title="查询远端镜像仓库" onClose={onClose} busy={busy}><form onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');try{onDone(await platformApi('/image-cache/registry','POST',{registry:credentialId?`${registry}/${namespace}`:registry,credentialId:credentialId||null}));}catch(err){setError(String(err));}finally{setBusy(false);}}}><label>Docker 凭证<select value={credentialId} onChange={e=>select(credentials.find(c=>c.credentialId===e.target.value))}><option value="">匿名访问</option>{credentials.map(c=><option key={c.credentialId} value={c.credentialId}>{c.displayName} · {c.endpoint}</option>)}</select></label>{credentialId?<><ConfigHelp>仓库主机：{registry}</ConfigHelp><label>命名空间<input required value={namespace} onChange={e=>setNamespace(e.target.value)} placeholder="仓库命名空间"/></label></>:<label>仓库地址<input required value={registry} onChange={e=>setRegistry(e.target.value)} placeholder="registry.example.com/namespace" list="pm-registry-sources"/><datalist id="pm-registry-sources">{sources.map(s=><option key={s} value={s}/>)}</datalist></label>}<span className="pm-context-help">说明 <ConfigHelp>仓库主机来自 Docker 凭证；命名空间默认使用凭证中的路径或用户名，可按实际仓库修改。仅读取本平台镜像仓库，每类最多查询 30 个 Tag。</ConfigHelp></span>{error?<p role="alert">{error}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy?'查询中…':'查询镜像'}</button></footer></form></Modal>;
}
