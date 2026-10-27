import {useEffect,useRef,useState} from 'react';
import {Modal,platformApi} from './management-page.js';
type Worker={id:string;name:string;agentType:string;status:string;revision:number;supported:boolean;ready:boolean};
type Outcome={installed?:string[];skipped?:string[];error?:string};
export function SkillSyncDialog({names,onClose}:{names:string[];onClose:()=>void}){
 const [workers,setWorkers]=useState<Worker[]>([]),[selected,setSelected]=useState<string[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[outcomes,setOutcomes]=useState<Record<string,Outcome>>({}),[running,setRunning]=useState('');
 const submitting=useRef(false);
 useEffect(()=>{let live=true;void platformApi('/skill-sync').then(result=>{if(live)setWorkers(result.workers);}).catch(e=>{if(live)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[]);
 const eligible=workers.filter(worker=>worker.supported&&worker.ready);
 const sync=async()=>{
  if(submitting.current||!selected.length)return;submitting.current=true;setBusy(true);setError('');
  try{for(const id of selected){
   const worker=workers.find(row=>row.id===id);if(!worker)continue;
   setRunning(id);
   try{const result=await platformApi('/skill-sync/'+id,'POST',{revision:worker.revision,names});
    if(result.applied!==true||!Array.isArray(result.installed)||!Array.isArray(result.skipped))throw Error('Worker 同步结果未确认');
    setOutcomes(rows=>({...rows,[id]:{installed:result.installed,skipped:result.skipped}}));
   }catch(e){setOutcomes(rows=>({...rows,[id]:{error:e instanceof Error?e.message:String(e)}}));}
  }}finally{setRunning('');setBusy(false);submitting.current=false;}
 };
 return <Modal title="同步 Skill 到 Worker" onClose={onClose} busy={busy}>
  <p className="hint">已选 {names.length} 个 Skill。同名 Skill 自动跳过，不覆盖、不移除 Worker 已有内容；新启动的 CLI 会话使用新增 Skill。</p>
  <details className="pm-sync-selection"><summary>查看所选 Skill</summary>{names.map(name=><code key={name}>{name}</code>)}</details>
  {error?<p role="alert" className="hint-warn">{error}</p>:null}
  {loading?<p role="status">正在加载 Worker…</p>:<><label className="pm-check"><input type="checkbox" aria-label="全选可同步的 Worker" checked={eligible.length>0&&eligible.every(row=>selected.includes(row.id))} disabled={busy||!eligible.length} onChange={e=>setSelected(e.target.checked?eligible.map(row=>row.id):[])}/><span>全选可同步的 Worker（{eligible.length}）</span></label>
   <div className="pm-skill-worker-list">{workers.map(worker=><div className="pm-skill-worker" key={worker.id}>
    <label className="pm-check"><input type="checkbox" aria-label={`选择 ${worker.name}`} checked={selected.includes(worker.id)} disabled={busy||!worker.supported||!worker.ready} onChange={e=>setSelected(e.target.checked?[...selected,worker.id]:selected.filter(id=>id!==worker.id))}/><span><strong>{worker.name}</strong><small>{worker.agentType} · {!worker.supported?'暂不支持原生 Skill':worker.ready?'就绪':'未就绪 / 配置待同步'}</small></span></label>
    {running===worker.id?<p role="status">同步中…</p>:outcomes[worker.id]?<p role={outcomes[worker.id]!.error?'alert':'status'} className={outcomes[worker.id]!.error?'hint-warn':'hint'}>{outcomes[worker.id]!.error||`新增 ${outcomes[worker.id]!.installed!.length} 个，跳过 ${outcomes[worker.id]!.skipped!.length} 个同名 Skill`}</p>:null}
   </div>)}{!workers.length?<p className="empty">暂无 Worker Agent，请先创建 Worker。</p>:null}</div></>}
  <footer><button disabled={busy} onClick={onClose}>{Object.keys(outcomes).length?'完成':'取消'}</button><button className="primary" disabled={loading||busy||!selected.length} onClick={()=>void sync()}>{busy?'正在同步…':Object.keys(outcomes).length?'重新同步所选 Worker':`同步到 ${selected.length} 个 Worker`}</button></footer>
 </Modal>;
}
