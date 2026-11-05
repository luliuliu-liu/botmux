import {useEffect,useRef,useState} from 'react';
import {Modal,platformApi,type Container} from './management-page.js';
import {Parameter,CompactText} from './compact-controls.js';
import {HostMountSelection} from './host-mounts.js';
import {ProxySelect} from './proxies.js';
import {mcpTargets} from '../../../platform/management/mcp-schema.js';
import {idsOf} from './model-options.js';
import {saveInstanceConfiguration,saveLocalConfiguration} from './configuration-save.js';
import {newPlatformRequestId} from './request-id.js';
const cliNames:Record<string,string>={pi:'Pi',codex:'Codex','claude-code':'Claude Code',zcode:'ZCode',traex:'Traex',dsh:'dsh'};
const sorted=(ids:string[])=>JSON.stringify([...ids].sort());
export function ConfigureAgent({container,onClose,onDone}:{container?:Container;onClose:()=>void;onDone:(v:string)=>void}){
 const local=!container,multi=local||(container.imageAgents?.length??0)>1;
 const [base,setBase]=useState<any>(),[draft,setDraft]=useState<any>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState('');
 const saving=useRef(false),mcpRequest=useRef(newPlatformRequestId());
 const load=async(preserve=false)=>{
  const [mcp,workspaces,bots,models,current,clis,controlWorkspace,proxy]=await Promise.all([
   platformApi('/mcp-targets/'+(local?'control':container.containerId)),platformApi('/workspaces'),platformApi('/bots'),platformApi('/models'),
   local?platformApi('/local-agent'):platformApi('/containers'),local?Promise.resolve(null):platformApi('/containers/'+container.containerId+'/clis'),
   local?platformApi('/control-workspace'):Promise.resolve(null),local?platformApi('/control-proxy'):Promise.resolve(null)]);
  const row=local?current:current.containers.find((c:Container)=>c.containerId===container.containerId);if(!row)throw Error('Agent 已不存在，请刷新');
  const workspace=local?controlWorkspace.actual.workspace:{kind:row.workspaceKind??'volume',source:row.workspaceClaim,readOnly:row.workspaceReadOnly??false};
  const mounts=local?controlWorkspace.actual.hostMounts:row.hostMounts??[];
  const hostMountIds=mounts.map((m:any)=>m.id??workspaces.globalReadOnlyMounts?.find((w:any)=>w.name===m.name&&(m.hostPath===undefined||w.hostPath===m.hostPath))?.id).filter(Boolean);
  const initial={agentType:local?(row.bots[0]?.cliId??'pi'):row.agentType,botId:local?(row.bots[0]?.appId??''):(row.botId??''),originalBotId:local?(row.bots[0]?.appId??''):'',owner:'',proxyProfileId:local?(proxy.proxyProfileId??''):(row.proxyProfileId??''),workspaceKind:workspace.kind,workspaceSource:workspace.source,workspaceReadOnly:workspace.readOnly,hostMountIds,mcpServerIds:mcp.serverIds,modelChoice:JSON.stringify(row.authMethod==='oauth'?[null,null]:[row.modelProfileId??null,row.modelId??null]),oauthModelId:row.authMethod==='oauth'?(row.modelId??''):'',confirmRestart:false};
  const loaded={row,mcp,workspaces,bots:bots.bots,models:models.models,clis:clis?.clis??[],controlWorkspace,proxy,initial};setBase(loaded);if(!preserve)setDraft(initial);
  mcpRequest.current=mcp.pendingRequestId??newPlatformRequestId();
 };
 useEffect(()=>{void load().catch(e=>setError(String(e)));},[]);
 const change=(key:string,value:any)=>setDraft((d:any)=>({...d,[key]:value}));
 const mountChange=base&&draft&&(draft.workspaceKind!==base.initial.workspaceKind||draft.workspaceSource!==base.initial.workspaceSource||draft.workspaceReadOnly!==base.initial.workspaceReadOnly||sorted(draft.hostMountIds)!==sorted(base.initial.hostMountIds));
 const clis=base?.mcp.cliIds??[];
 const selectedBot=base?.bots.find((b:any)=>b.appId===draft?.botId);
 const oauthSupported=!multi&&(['codex','zcode'].includes(draft?.agentType)||base?.row.authMethod==='oauth');
 const oauthSelected=draft?.modelChoice==='[null,null]';
 const compatibleModels=base?.models.filter((m:any)=>m.enabled&&(draft.agentType==='codex'?m.protocol==='openai-responses':draft.agentType==='zcode'?m.protocol==='zcode-coding-plan':draft.agentType==='claude-code'?['anthropic-messages','vercel-claude'].includes(m.protocol):true))??[];
 return <Modal title={'修改配置 · '+(container?.displayName??'Control Agent')} onClose={onClose} busy={busy}>
 {!draft?<><p role="status">正在加载配置…</p>{error?<p role="alert">{error}</p>:null}<button onClick={()=>void load().catch(e=>setError(String(e)))}>重试加载</button></>:<form onSubmit={async e=>{
  e.preventDefault();if(saving.current)return;if(mountChange&&!draft.confirmRestart){setError('请确认挂载修改会重建空闲容器');return;}
  saving.current=true;setBusy(true);setError('');setDone('');try{
   const result=local?await saveLocalConfiguration(platformApi,base,draft,mcpRequest.current):await saveInstanceConfiguration(platformApi,base,draft,mcpRequest.current);
   if('queued' in result&&result.queued){setDone('配置已保存，挂载重建已排队；页面将短暂断开，请稍后刷新。');}
   else onDone('配置已保存并同步');
  }catch(e){setError(String(e));try{await load(true);}catch{setError(String(e)+'；状态刷新失败，请先刷新页面确认');}}finally{saving.current=false;setBusy(false);}
 }}>
 <fieldset disabled={busy||!!done}>
 <label>名称<input value={container?.displayName??'Control Agent'} disabled/></label>
 <label><Parameter help="选择容器中已配置的 Agent CLI；保存后机器人使用所选项。单 CLI Worker 和池成员保持固定类型。">Agent</Parameter><select aria-label="配置 Agent" value={draft.agentType} disabled={!multi||!!container?.poolId} onChange={e=>change('agentType',e.target.value)}>{clis.map((cli:string)=>{const entry=local?base.row.agents.find((a:any)=>a.agentType===cli):base.clis.find((a:any)=>a.agentType===cli);return <option key={cli} value={cli} disabled={!local&&!entry?.configured}>{cliNames[cli]??cli}{!local&&!entry?.configured?'（先配置模型）':''}</option>;})}</select></label>
 {!local?<label>镜像<input disabled value={container.imageLabel??container.image}/></label>:null}
 <ProxySelect value={draft.proxyProfileId} onChange={v=>change('proxyProfileId',v)}/>
 <label><Parameter help={local?'选择要配置的本地机器人，或将空闲机器人绑定到所选 Agent。其余本地机器人保持当前配置。':'保存后将机器人绑定到上方选定的 Agent CLI；不创建或删除飞书应用。'}>飞书机器人</Parameter><select aria-label="配置机器人" value={draft.botId} disabled={!!container?.poolId} onChange={e=>{change('botId',e.target.value);if(local){const b=base.row.bots.find((b:any)=>b.appId===e.target.value);if(b)change('agentType',b.cliId);}}}><option value="">不绑定机器人</option>{base.bots.filter((b:any)=>local?base.row.bots.some((x:any)=>x.appId===b.appId)||b.usage==='free':b.usage==='free'||b.botId===container.botId).map((b:any)=><option key={b.appId} value={local?b.appId:b.botId}>{b.displayName}</option>)}</select></label>
 {local&&draft.botId&&!base.row.bots.some((b:any)=>b.appId===draft.botId)&&!selectedBot?.ownerConfigured?<label>机器人所有者<input value={draft.owner} onChange={e=>change('owner',e.target.value)} placeholder="邮箱 / 手机号 / union_id" required/></label>:null}
 {!multi?<label>登录方式 / 模型<select aria-label="配置模型" required value={draft.modelChoice} onChange={e=>change('modelChoice',e.target.value)}>{oauthSupported?<option value="[null,null]">原生 OAuth</option>:null}{compatibleModels.flatMap((m:any)=>idsOf(m).map(id=><option key={m.profileId+id} value={JSON.stringify([m.profileId,id])}>{m.displayName} · {id||'原生动态模型'}</option>))}</select></label>:null}
 {oauthSupported&&oauthSelected?<label>OAuth 模型（可选）<input aria-label="配置 OAuth 模型" maxLength={300} value={draft.oauthModelId??''} onChange={e=>change('oauthModelId',e.target.value)} placeholder="留空使用 CLI 原生默认模型"/></label>:null}
 <section className="pm-config-section"><h3><Parameter help="修改挂载需要确认重建；旧 workspace 和私有 state 保留。挂载路径受后台范围策略校验。">工作区与只读挂载</Parameter></h3>
 <label>工作区类型<select aria-label="配置工作区类型" disabled={!!container?.poolId} value={draft.workspaceKind} onChange={e=>{change('workspaceKind',e.target.value);change('workspaceSource',e.target.value==='volume'?base.workspaces.workspaces.find((w:any)=>w.kind==='volume')?.source??'':base.workspaces.defaultHostPath??'');}}><option value="volume">volume</option><option value="hostpath" disabled={!base.workspaces.hostPathEnabled}>hostPath</option></select></label>
 <label>工作区{draft.workspaceKind==='volume'?<select aria-label="配置工作区" disabled={!!container?.poolId} value={draft.workspaceSource} onChange={e=>change('workspaceSource',e.target.value)}>{[...new Set<string>([draft.workspaceSource,...base.workspaces.workspaces.filter((w:any)=>w.kind==='volume').map((w:any)=>w.source)])].map(v=><option key={v} value={v}>{v}</option>)}</select>:<input aria-label="配置工作区" disabled={!!container?.poolId} required value={draft.workspaceSource} onChange={e=>change('workspaceSource',e.target.value)}/>}</label>
 {!local?<label className="pm-check"><input type="checkbox" disabled={!!container?.poolId} checked={draft.workspaceReadOnly} onChange={e=>change('workspaceReadOnly',e.target.checked)}/><span>只读 /workspace</span></label>:null}
 <HostMountSelection mounts={base.workspaces.globalReadOnlyMounts??[]} value={draft.hostMountIds} onChange={v=>change('hostMountIds',v)}/>
 {mountChange?<label className="pm-check"><input type="checkbox" checked={draft.confirmRestart} onChange={e=>change('confirmRestart',e.target.checked)}/><span>确认重建空闲 Agent，保留 state 和旧工作区文件</span></label>:null}</section>
 <section className="pm-config-section"><h3><Parameter help="保存并同步会更新平台 MCP 选择集合；取消选择只移除平台条目。手工与内置配置保留。">MCP</Parameter></h3>
 {base.mcp.pendingRequestId?<p role="status">上次 MCP 同步未确认，保存时将先重试原选择。</p>:null}
 {base.mcp.servers.map((r:any)=>{const targets=mcpTargets(r.configuration,clis);return <label className="pm-check" key={r.id}><input type="checkbox" disabled={!!base.mcp.pendingRequestId||!targets.length&&!draft.mcpServerIds.includes(r.id)} checked={draft.mcpServerIds.includes(r.id)} onChange={e=>{change('mcpServerIds',e.target.checked?[...draft.mcpServerIds,r.id]:draft.mcpServerIds.filter((id:string)=>id!==r.id));mcpRequest.current=newPlatformRequestId();}}/><span><CompactText text={r.configuration.displayName}/><small><CompactText text={targets.length?'应用到 '+targets.map(v=>cliNames[v]??v).join(' / '):'此 CLI 不兼容'}/></small></span></label>;})}
 </section></fieldset>{error?<p role="alert">{error}</p>:null}{done?<p role="status">{done}</p>:null}<footer><button type="button" disabled={busy} onClick={onClose}>关闭</button><button disabled={busy||!!done}>{busy?'保存中…':'保存并同步'}</button></footer></form>}
 </Modal>;
}
