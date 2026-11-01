import {useState} from 'react';
import {CompactText,Parameter,AgentActions} from './compact-controls.js';
import {platformApi,Modal} from './management-page.js';
export type NamedMount={id:string;name:string;hostPath:string;description?:string;revision:number};
export function HostMountSelection({mounts,value,onChange,disabled=false}:{mounts:NamedMount[];value:string[];onChange:(v:string[])=>void;disabled?:boolean}){
 return <fieldset disabled={disabled}><legend>全局只读挂载</legend>{mounts.length?mounts.map(m=><label className="pm-check" key={m.id}><input type="checkbox" name="hostMountIds" value={m.id} checked={value.includes(m.id)} onChange={e=>onChange(e.target.checked?[...value,m.id]:value.filter(id=>id!==m.id))}/><span>{m.name} · /host/{m.name}</span></label>):<p role="status">尚未配置只读挂载</p>}</fieldset>;
}
export function HostMountSettings({mounts,onDone}:{mounts:NamedMount[];onDone:()=>void}){
 const [edit,setEdit]=useState<NamedMount|null|undefined>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 return <section><div className="pm-bot-list-heading"><h3><Parameter help="命名挂载用于创建或显式重建实例；修改目录不会改变现有实例快照。">命名全局只读挂载</Parameter></h3><button type="button" onClick={()=>setEdit(null)}>新增挂载</button></div>
 <div className="pm-table-wrap"><table className="pm-summary-table pm-mount-table"><thead><tr><th>名称</th><th>宿主目录</th><th>容器目录</th><th>操作</th></tr></thead><tbody>{mounts.map(m=><tr key={m.id}><td><CompactText text={m.name}/></td><td><CompactText text={m.hostPath}/></td><td><CompactText text={'/host/'+m.name}/></td><td><AgentActions name={m.name+' 挂载'} disabled={busy} actions={[{label:'编辑',run:()=>setEdit(m)},{label:'移除',danger:true,run:async()=>{setBusy(true);try{await platformApi('/host-mounts/'+m.id,'DELETE',{revision:m.revision});onDone();}catch(e){setError(String(e));}finally{setBusy(false);}}}]}/></td></tr>)}</tbody></table></div>
 {error?<p role="alert">{error}</p>:null}{edit!==undefined?<HostMountForm key={edit?.id??'new'} row={edit} onClose={()=>setEdit(undefined)} onDone={()=>{setEdit(undefined);onDone();}}/>:null}</section>;
}
function HostMountForm({row,onClose,onDone}:{row:NamedMount|null;onClose:()=>void;onDone:()=>void}){
 const [name,setName]=useState(row?.name??''),[path,setPath]=useState(row?.hostPath??''),[description,setDescription]=useState(row?.description??''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 return <Modal title={row?'编辑挂载':'新增挂载'} busy={busy} onClose={onClose}><form onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);try{await platformApi('/host-mounts'+(row?'/'+row.id:''),row?'PUT':'POST',{name,hostPath:path,description,revision:row?.revision});onDone();}catch(e){setError(String(e));}finally{setBusy(false);}}}>
 <label><Parameter help="挂载名决定容器路径 /host/挂载名，支持小写字母、数字和短横线。">挂载名</Parameter><input aria-label="挂载名" value={name} onChange={e=>setName(e.target.value)} required maxLength={64}/></label>
 <label><Parameter help="Docker 宿主机绝对目录，受当前部署的目录范围策略校验。">宿主路径</Parameter><input aria-label="宿主路径" value={path} onChange={e=>setPath(e.target.value)} required/></label>
 <label>说明<input aria-label="挂载说明" value={description} onChange={e=>setDescription(e.target.value)}/></label>{error?<p role="alert">{error}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button disabled={busy}>保存挂载</button></footer></form></Modal>;
}
