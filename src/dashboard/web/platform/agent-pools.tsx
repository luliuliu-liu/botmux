import {CompactText,AgentActions,ConfigHelp} from './compact-controls.js';
import {McpSelection} from './mcp.js';
import {HostMountSelection} from './host-mounts.js';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Modal,platformApi,type Container} from './management-page.js';
import {clearManagementCache} from './management-cache.js';
import {dynamicModel,idsOf} from './model-options.js';
import {newPlatformRequestId} from './request-id.js';

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const requiresPoolRebuild=(member:any,value:any)=>value.cpu!==member.cpu||value.memoryMiB!==member.memoryMiB||value.mountGlobalReadOnly!==!!member.globalReadOnlyHostPath||value.hostMountIds!==undefined&&JSON.stringify([...value.hostMountIds].sort())!==JSON.stringify((member.hostMounts??[]).map((m:any)=>m.id).sort());
const availableMember=(member:any)=>member.enabled&&!member.quarantined&&!member.configurationPending&&member.status==='ready'&&member.runtimeHealth!=='unhealthy';

export function AgentPoolPage(){
 const [data,setData]=useState<any>({pools:[],members:[],jobs:[],agents:[],models:[],containers:[],workspaces:[]});
 const [poolId,setPoolId]=useState(''),[error,setError]=useState(''),[modal,setModal]=useState<any>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const selectedPool=useRef(''),refreshVersion=useRef(0),mounted=useRef(true),submitting=useRef(false);
 const refresh=async(force=false)=>{
  if(force)clearManagementCache();
  const version=++refreshVersion.current,requestedPool=selectedPool.current;
  try{
   const [pools,catalog,models,containers,workspaces,waits]=await Promise.all(['/agent-pools','/catalog','/models','/containers','/workspaces','/workflow-resources'].map(path=>platformApi(path)));
   const id=(pools.pools.some((p:any)=>p.poolId===requestedPool)?requestedPool:'')||pools.pools[0]?.poolId||'',detail=id?await platformApi('/agent-pools/'+id):{members:[]};
   if(!mounted.current||version!==refreshVersion.current)return;
   selectedPool.current=id;setPoolId(id);
   setData({pools:pools.pools,members:detail.members,jobs:waits.jobs,agents:catalog.agents,models:models.models,containers:containers.containers,workspaces:workspaces.workspaces,globalReadOnlyMounts:workspaces.globalReadOnlyMounts,globalReadOnlyHostPath:workspaces.globalReadOnlyHostPath});setError('');
  }catch(error){if(mounted.current&&version===refreshVersion.current)setError(message(error));}
  finally{if(mounted.current&&version===refreshVersion.current)setLoading(false);}
 };
 useEffect(()=>{mounted.current=true;void refresh();return()=>{mounted.current=false;refreshVersion.current++;};},[]);
 const polling=data.jobs.length>0||data.members.some((member:any)=>member.configurationPending);
 useEffect(()=>{if(!polling)return;const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[polling]);
 const action=async(path:string,method:string,body:any,close=true,confirmed?:(result:any)=>boolean)=>{
  if(submitting.current)throw new Error('操作正在进行，请等待确认');
  submitting.current=true;setBusy(true);
  try{
   const result=await platformApi(path,method,body);
   if(confirmed&&!confirmed(result))throw new Error('后端尚未确认操作完成，请刷新后重试');
   if(mounted.current&&close)setModal(null);
   await refresh();
  }finally{submitting.current=false;if(mounted.current)setBusy(false);}
 };
 const listAction=async(path:string,method:string,body:any,confirmed?:(result:any)=>boolean)=>{setError('');try{await action(path,method,body,false,confirmed);}catch(error){if(mounted.current)setError(message(error));}};
 const pool=data.pools.find((row:any)=>row.poolId===poolId);
 const open=(kind:string,extra:any={})=>{if(!submitting.current)setModal({kind,pool,...extra});};
 return <><div className="page-heading"><div><h2>Workflow Agent 池 <ConfigHelp>共享工作区，复用 Agent 容器；每个任务开启独立 session。</ConfigHelp></h2></div><button disabled={busy} onClick={()=>void refresh(true)}>刷新</button></div>
 {error?<p role="alert" className="hint-warn">{error}</p>:null}
 <div className="pm-list-filters"><select aria-label="Agent 池" disabled={busy} value={poolId} onChange={event=>{selectedPool.current=event.target.value;setPoolId(event.target.value);setData((old:any)=>({...old,members:[]}));setLoading(true);void refresh();}}><option value="">选择工作区池</option>{data.pools.map((row:any)=><option key={row.poolId} value={row.poolId}>{row.displayName} · {row.workspaceKind} · {row.workspaceSource}</option>)}</select><AgentActions name="工作区池" disabled={busy||loading} actions={[{label:'删除工作区池',disabled:!pool, danger:true,run:()=>open('delete-pool')},{label:'新建池成员',disabled:!pool,run:()=>open('create')},{label:'纳入已有 Agent',disabled:!pool,run:()=>open('enroll')}]}/></div>
 {loading?<p role="status">正在加载池成员…</p>:null}
 <div className="pm-table-wrap"><table className="pm-pool-table"><thead><tr><th>成员 / 能力范围</th><th>CLI / 模型</th><th>资源与任务</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.members.map((member:any)=><tr key={member.memberId}><td><strong><CompactText text={member.displayName}/></strong><p><CompactText text={member.description}/></p></td><td>{member.agentType}<p><CompactText text={member.modelProfileId+" · "+(member.modelId||'原生动态模型')}/></p></td><td>{member.cpu} CPU · {member.memoryMiB} MiB<p>{member.occupied} / {member.capacity} 个任务</p>{member.hostMounts?.length?<small><CompactText text={member.hostMounts.map((m:any)=>m.path).join('、')+' · 只读'}/></small>:member.globalReadOnlyHostPath?<small>/host · 旧版只读挂载</small>:null}</td><td>{member.configurationPending?'配置待确认':member.quarantined?'隔离，等待停止确认':!member.enabled?'已停用':member.runtimeHealth==='unhealthy'?'服务恢复未确认':member.status==='ready'?'可用':member.status}{member.configurationError?<p><CompactText text={member.configurationError}/></p>:null}</td><td><AgentActions name={member.displayName+' 池成员'} disabled={busy} actions={[
 ...(member.configurationPending?[{label:'重试配置',run:()=>void listAction(`/agent-pools/${poolId}/members/${member.memberId}/configuration`,'POST',{},r=>r.members?.some((m:any)=>m.memberId===member.memberId&&!m.configurationPending)||r.configurationConfirmed===true)},{label:'撤销待确认配置',disabled:member.occupied>0,run:()=>open('cancel-configuration',{member})}]:member.quarantined?[{label:'核对恢复',run:()=>void listAction(`/agent-pools/${poolId}/members/${member.memberId}/reconcile`,'POST',{})}]:[]),
 {label:'修改配置',disabled:member.occupied>0||member.configurationPending,run:()=>open('edit',{member})},
 {label:member.enabled?'停用':'启用',disabled:member.occupied>0||member.configurationPending,run:()=>void listAction(`/agent-pools/${poolId}/members/${member.memberId}`,'PUT',{revision:member.revision,enabled:!member.enabled})},
 {label:'移出',disabled:member.occupied>0||member.configurationPending,run:()=>open('remove',{member})}]}/></td></tr>)}</tbody></table></div>
 <h3>等待资源的节点 <ConfigHelp>容量不足自动排队；缺少能力时选择成员或补建，其他独立节点继续执行。</ConfigHelp></h3>
 {data.jobs.length?data.jobs.map((job:any)=><div className="pm-info-note" key={job.jobId}><strong>{job.runId} · {job.attemptId}</strong><p>{job.selection?.requirement}</p><small>{job.waitReason==='capacity'?'等待可用额度':'等待合适的 Agent'}{job.lastError?' · '+job.lastError:''}</small>{job.waitReason==='capability'?<button disabled={busy} onClick={()=>open('resolve',{job})}>选择 / 补建 Agent</button>:null}<button disabled={busy} onClick={()=>void listAction(`/workflow-resources/${job.runId}/${job.jobId}/cancel`,'POST',{})}>取消节点</button></div>):<p>没有等待资源的节点</p>}
 {modal?.kind==='delete-pool'?<PoolActionDialog title="删除工作区池" submitLabel="确认删除池" busy={busy} onClose={()=>setModal(null)} onSave={()=>action(`/agent-pools/${modal.pool.poolId}`,'DELETE',{confirmDelete:true,workspaceKind:modal.pool.workspaceKind,workspaceSource:modal.pool.workspaceSource},true,result=>result.deleted===true)}><p>删除「{modal.pool.displayName}」的工作区池登记。</p><ConfigHelp>仅空池且没有未结束任务或 Workflow 引用时允许删除。成员容器、workspace 文件和历史执行记录保留。</ConfigHelp></PoolActionDialog>:null}
 {modal?.kind==='remove'?<PoolActionDialog title="移出池成员" submitLabel="确认移出" busy={busy} onClose={()=>setModal(null)} onSave={()=>action(`/agent-pools/${modal.pool.poolId}/members/${modal.member.memberId}`,'DELETE',{revision:modal.member.revision})}><p>移出「{modal.member.displayName}」后保留 Agent 容器；已有 Workflow 的候选可能需要重新选择。</p></PoolActionDialog>:null}
 {modal?.kind==='cancel-configuration'?<PoolActionDialog title="撤销待确认配置" submitLabel="确认撤销" busy={busy} onClose={()=>setModal(null)} onSave={()=>action(`/agent-pools/${modal.pool.poolId}/members/${modal.member.memberId}/configuration/cancel`,'POST',{revision:modal.member.revision},true,result=>result.cancelled===true)}><p>恢复「{modal.member.displayName}」的已提交配置。Worker 确认恢复前仍保持隔离与待确认状态；撤销失败可继续重试。</p></PoolActionDialog>:null}
 {modal&&['create','edit','enroll','resolve'].includes(modal.kind)?<PoolMemberDialog key={modal.kind+(modal.job?.jobId||modal.member?.memberId||'')} modal={modal} data={data} busy={busy} onClose={()=>setModal(null)} onSave={(value:any)=>{
  if(modal.kind==='resolve'){const body=value.memberId?{memberId:value.memberId}:{requestId:modal.job.jobId,create:value};return action(`/workflow-resources/${modal.job.runId}/${modal.job.jobId}/resolve`,'POST',body);}
  if(modal.kind==='edit'){const member=modal.member,rebuilt=requiresPoolRebuild(member,value);if(rebuilt&&!value.confirmRestart)throw new Error('请先确认重建空闲容器');return action(`/agent-pools/${modal.pool.poolId}/members/${member.memberId}${rebuilt?'/rebuild':''}`,rebuilt?'POST':'PUT',{...value,revision:member.revision});}
  return action(`/agent-pools/${modal.pool.poolId}/${modal.kind==='enroll'?'enroll':'members'}`,'POST',value);
 }}/> :null}
 </>;
}

function PoolActionDialog({title,children,busy,onClose,onSave,submitLabel='保存'}:{title:string;children:ReactNode;busy:boolean;onClose:()=>void;onSave:(value:Record<string,FormDataEntryValue>)=>Promise<unknown>;submitLabel?:string}){
 const submitting=useRef(false),[error,setError]=useState('');
 return <Modal title={title} onClose={onClose} busy={busy}><form onSubmit={async event=>{event.preventDefault();if(busy||submitting.current)return;submitting.current=true;setError('');try{await onSave(Object.fromEntries(new FormData(event.currentTarget)));}catch(error){setError(message(error));}finally{submitting.current=false;}}}>{children}{error?<p role="alert">{error}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button disabled={busy}>{busy?'处理中…':submitLabel}</button></footer></form></Modal>;
}

function PoolMemberDialog({modal,data,busy,onClose,onSave}:any){
 const needsLoad=['resolve','enroll'].includes(modal.kind),[target,setTarget]=useState<any>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  if(!needsLoad)return;
  let active=true;setTarget(null);setError('');
  if(modal.kind==='enroll')clearManagementCache();
  const id=modal.job?.poolId||modal.pool.poolId;
  void Promise.all([platformApi('/agent-pools'),platformApi('/agent-pools/'+id),platformApi('/workspaces'),...(modal.kind==='enroll'?[platformApi('/containers')]:[])]).then(([pools,detail,workspaces,containers])=>{
   if(!active)return;
   const pool=detail.pool||pools.pools.find((row:any)=>row.poolId===id);
   if(!pool)throw new Error('目标 Agent 池已不存在，请刷新后重试');
   setTarget({pool,members:detail.members,workspaces:workspaces.workspaces,globalReadOnlyMounts:workspaces.globalReadOnlyMounts,globalReadOnlyHostPath:workspaces.globalReadOnlyHostPath,...(containers?{containers:containers.containers}:{})});
  }).catch(error=>{if(active)setError(message(error));});
  return()=>{active=false;};
 },[modal,needsLoad,attempt]);
 return <PoolMemberForm modal={modal} data={target?{...data,...target}:needsLoad?{...data,members:[],containers:[]}:data} pool={target?.pool||(!needsLoad?modal.pool:null)} busy={busy} loading={needsLoad&&!target} loadError={error} onReload={()=>setAttempt(value=>value+1)} onClose={onClose} onSave={onSave}/>;
}

function PoolMemberForm({modal,data,pool,busy,loading=false,loadError='',onReload,onClose,onSave}:any){
 const member=modal.member,request=useRef(newPlatformRequestId()),submitting=useRef(false);
 const [agentType,setAgentType]=useState(member?.agentType||'pi'),[mode,setMode]=useState(modal.kind==='enroll'?'existing':'new'),[error,setError]=useState('');
 const [hostMountIds,setHostMountIds]=useState<string[]>(member?.hostMounts?.map((m:any)=>m.id)??[]);
 const [mcpIds,setMcpIds]=useState<string[]>([]);
 const [cpu,setCpu]=useState(member?.cpu??2),[memoryMiB,setMemoryMiB]=useState(member?.memoryMiB??4096),[mountGlobalReadOnly,setMountGlobalReadOnly]=useState(!!member?.globalReadOnlyHostPath),[confirmRestart,setConfirmRestart]=useState(false);
 const agent=data.agents.find((row:any)=>row.id===agentType),models=data.models.filter((profile:any)=>profile.enabled&&agent?.protocols?.includes(profile.protocol||'openai-completions'));
 const choices=models.flatMap((profile:any)=>idsOf(profile).filter(id=>dynamicModel(profile)||!!id).map(id=>({profile,id})));
 const containers=data.containers.filter((container:Container)=>!container.poolId&&!container.poolMemberId&&!container.botId&&container.status==='ready'&&container.workspaceClaim===pool?.workspaceSource&&(container.workspaceKind||'volume')===pool?.workspaceKind&&!container.workspaceReadOnly);
 const members=data.members.filter(availableMember),rebuild=member&&requiresPoolRebuild(member,{cpu,memoryMiB,mountGlobalReadOnly,...(data.globalReadOnlyMounts?{hostMountIds}:{})});
 const unavailable=mode==='existing'?(modal.kind==='resolve'?!members.length:!containers.length):!member&&!choices.length;
 const emptyExisting=!loading&&mode==='existing'&&unavailable?(modal.kind==='resolve'?'池中没有可用成员；请补建新 Agent，或先恢复停用 / 隔离的成员。':'没有可纳入的 Agent：需要 ready、未绑定 Bot、未入池，并使用此池可写 workspace 的 Agent。'):'';
 // R4: catch a per-task budget the container cannot hold before submitting.
 const [taskCpu,setTaskCpu]=useState(Number(member?.taskCpu??1)),[taskMemoryMiB,setTaskMemoryMiB]=useState(Number(member?.taskMemoryMiB??2048));
 const [chosenContainer,setChosenContainer]=useState('');
 const enrollTarget=containers.find((c:Container)=>c.containerId===chosenContainer)??containers[0];
 const budgetCpu=mode==='existing'&&modal.kind==='enroll'?Number(enrollTarget?.cpu):cpu;
 const budgetMemory=mode==='existing'&&modal.kind==='enroll'?Number(enrollTarget?.memoryMiB):memoryMiB;
 const budgetError=!(mode==='existing'&&modal.kind==='resolve')&&Number.isFinite(budgetCpu)&&Number.isFinite(budgetMemory)&&taskCpu>0&&taskMemoryMiB>0&&
  (taskCpu>budgetCpu||taskMemoryMiB>budgetMemory)?`每任务预算超过容器配额（${budgetCpu} CPU · ${budgetMemory} MiB），至少要能容纳一个任务。`:'';
 const disabled=busy||loading||unavailable||!!budgetError||!!(rebuild&&!confirmRestart);
 return <Modal title={member?'编辑池成员':modal.kind==='resolve'?'选择或补建 Agent':'加入 Agent 池'} onClose={onClose} busy={busy}><form onSubmit={async event=>{
  event.preventDefault();if(busy||loading||submitting.current)return;setError('');
  if(unavailable){setError(mode==='new'?'请先配置并启用兼容模型连接':'没有可用的已有 Agent');return;}
  if(rebuild&&!confirmRestart){setError('请先确认重建空闲容器');return;}
  const values=Object.fromEntries(new FormData(event.currentTarget));
  const body:any={description:values.description,taskCpu:Number(values.taskCpu||1),taskMemoryMiB:Number(values.taskMemoryMiB||2048)};
  if(mode==='existing'){if(modal.kind==='resolve')body.memberId=values.memberId;else body.containerId=values.containerId;}
  else{const choice=values.modelChoice?JSON.parse(String(values.modelChoice)):[member?.modelProfileId,member?.modelId];Object.assign(body,{requestId:request.current,displayName:values.displayName,agentType,modelProfileId:choice[0],modelId:choice[1],cpu,memoryMiB,mountGlobalReadOnly,confirmRestart,...(mcpIds.length?{mcpServerIds:mcpIds}:{}),...(data.globalReadOnlyMounts?{hostMountIds}:{})});}
  submitting.current=true;try{await onSave(body);}catch(error){setError(message(error));}finally{submitting.current=false;}
 }}>
 {loading?<p role={loadError?'alert':'status'}>{loadError||'正在加载目标池、成员与共享工作区…'}{loadError?<button type="button" disabled={busy} onClick={onReload}>重试加载</button>:null}</p>:<p>共享 workspace：{pool?.workspaceSource}</p>}
 {modal.kind==='resolve'?<label>处理方式<select aria-label="处理方式" value={mode} disabled={busy} onChange={event=>setMode(event.target.value)}><option value="new">补建新 Agent</option><option value="existing">选择已有池成员</option></select></label>:null}
 {mode==='existing'?modal.kind==='resolve'?<label>池成员<select name="memberId" required disabled={loading}>{members.map((row:any)=><option key={row.memberId} value={row.memberId}>{row.displayName} · {row.description}</option>)}</select></label>:<label>已有 Agent<select name="containerId" required disabled={loading} value={enrollTarget?.containerId??''} onChange={event=>setChosenContainer(event.target.value)}>{containers.map((container:Container)=><option key={container.containerId} value={container.containerId}>{container.displayName} · {container.agentType}</option>)}</select></label>:<>
  <label>名称<input name="displayName" required defaultValue={member?.displayName} maxLength={64}/></label>
  <label>Agent 类型<select name="agentType" value={agentType} disabled={!!member||busy} onChange={event=>setAgentType(event.target.value)}>{data.agents.filter((row:any)=>row.supported&&row.id!=='browser').map((row:any)=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
  {!member?<McpSelection clis={[agentType]} value={mcpIds} onChange={setMcpIds} disabled={busy}/>:null}
  {!member?<><label>固定模型配置<select name="modelChoice" required key={agentType}>{choices.map(({profile,id}:any)=><option key={profile.profileId+id} value={JSON.stringify([profile.profileId,id])}>{profile.displayName} · {id||'原生动态模型'}</option>)}</select></label>{!choices.length?<p role="status" className="hint-warn">没有启用的兼容模型连接。请先到 <a href="#/platform-configuration?section=models">模型连接配置</a> 添加或启用连接；仍可选择已有池成员。</p>:null}</>:<ConfigHelp>CLI 和模型使用成员现有配置；可在 Agent 实例页修改。</ConfigHelp>}
  <label>CPU 配额<input name="cpu" type="number" min="0.25" max="128" step="0.25" required value={cpu} onChange={event=>{setCpu(Number(event.target.value));setConfirmRestart(false);}}/></label><label>内存 MiB<input name="memoryMiB" type="number" min="128" max="524288" required value={memoryMiB} onChange={event=>{setMemoryMiB(Number(event.target.value));setConfirmRestart(false);}}/></label>
  <>{data.globalReadOnlyMounts?<HostMountSelection mounts={data.globalReadOnlyMounts} value={hostMountIds} onChange={ids=>{setHostMountIds(ids);setConfirmRestart(false);}} disabled={busy}/>:<label className="pm-check"><input name="mountGlobalReadOnly" type="checkbox" disabled={(!data.globalReadOnlyHostPath&&!member?.globalReadOnlyHostPath)||busy} checked={mountGlobalReadOnly} onChange={event=>{setMountGlobalReadOnly(event.target.checked);setConfirmRestart(false);}}/><span>挂载 /host 全局只读目录</span></label>}</>
  {member&&rebuild?<label className="pm-check"><input name="confirmRestart" type="checkbox" checked={confirmRestart} onChange={event=>setConfirmRestart(event.target.checked)}/><span>资源配额或只读挂载改变时，确认重建空闲容器</span></label>:null}
 </>}
 {!(mode==='existing'&&modal.kind==='resolve')?<><label>身份 / 能力描述<textarea name="description" required maxLength={8000} defaultValue={member?.description}/></label><label>每任务 CPU<input name="taskCpu" type="number" min="0.25" step="0.25" required value={taskCpu} onChange={event=>setTaskCpu(Number(event.target.value))}/></label><label>每任务内存 MiB<input name="taskMemoryMiB" type="number" min="128" required value={taskMemoryMiB} onChange={event=>setTaskMemoryMiB(Number(event.target.value))}/></label></>:null}
 {emptyExisting?<p role="status" className="hint-warn">{emptyExisting}</p>:null}{budgetError?<p role="alert" className="hint-warn">{budgetError}</p>:null}
 {error?<p role="alert">{error}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button disabled={disabled}>{busy?'处理中…':'保存并继续'}</button></footer>
 </form></Modal>;
}
