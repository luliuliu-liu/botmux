type Api=(path:string,method?:string,body?:any)=>Promise<any>;
const sameIds=(a:string[],b:string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
async function syncMcp(api:Api,target:string,base:any,draft:any,requestId:string){
 const r=await api('/mcp-targets/'+target,'POST',{revision:base.mcp.revision,requestId:base.mcp.pendingRequestId??requestId,serverIds:base.mcp.pendingRequestId?base.mcp.serverIds:draft.mcpServerIds});
 if(r.applied!==true)throw Error('MCP 保存未确认，请重试原选择');
}
export async function saveInstanceConfiguration(api:Api,base:any,draft:any,requestId:string){
 const id=base.row.containerId;let stage='MCP';
 try{
  const mountChange=draft.workspaceKind!==base.initial.workspaceKind||draft.workspaceSource!==base.initial.workspaceSource||draft.workspaceReadOnly!==base.initial.workspaceReadOnly||!sameIds(draft.hostMountIds,base.initial.hostMountIds);
  if(mountChange&&!draft.confirmRestart)throw Error('请确认重建');
  if(draft.agentType!==base.row.agentType&&!base.clis.some((c:any)=>c.agentType===draft.agentType&&c.configured))throw Error('请先配置目标 Agent 模型');
  await syncMcp(api,id,base,draft,requestId);
  stage='模型与机器人';const update=await api('/containers/'+id,'PUT',{revision:base.row.revision,proxyProfileId:draft.proxyProfileId||null,...(base.row.botId!==(draft.botId||null)?{botId:draft.botId||null}:{}),...(base.clis.length<=1?(()=>{const [modelProfileId,modelId]=JSON.parse(draft.modelChoice);return {modelProfileId,modelId,authMethod:modelProfileId===null?'oauth':'api-key'};})():{})});
  let row=update.container;if(!row||row.status!=='ready'||row.appliedRevision!==row.revision)throw Error('实例未确认生效');
  if(draft.agentType!==row.agentType){stage='Agent 切换';const cli=base.clis.find((c:any)=>c.agentType===draft.agentType);if(!cli?.configured)throw Error('请先配置目标 Agent 模型');const r=await api('/containers/'+id+'/clis/'+draft.agentType+'/activate','POST',{revision:cli.revision});if(!r.clis?.some((c:any)=>c.agentType===draft.agentType&&c.active&&c.appliedRevision===c.revision))throw Error('切换未确认');row=(await api('/containers')).containers.find((c:any)=>c.containerId===id);}
  if(mountChange){stage='挂载重建';if(!draft.confirmRestart)throw Error('请确认重建');const r=await api('/containers/'+id+'/upgrade','POST',{revision:row.revision,image:row.image,confirmRestart:true,hostMountIds:draft.hostMountIds,...(!row.poolId?{workspaceKind:draft.workspaceKind,workspaceSource:draft.workspaceSource,workspaceReadOnly:draft.workspaceReadOnly}:{})});if(r.container?.status!=='ready')throw Error('重建未确认');}
  return {applied:true};
 }catch(e){throw Error(stage+'未完成；此前确认的步骤已保留，可重试。'+String(e));}
}
export async function saveLocalConfiguration(api:Api,base:any,draft:any,requestId:string){
 let stage='MCP';try{
  const change=draft.workspaceKind!==base.initial.workspaceKind||draft.workspaceSource!==base.initial.workspaceSource||!sameIds(draft.hostMountIds,base.initial.hostMountIds);
  if(change&&!draft.confirmRestart)throw Error('请确认重建');
  let mcpUnchanged=false;
  if(base.mcp.synchronized===true&&!base.mcp.pendingRequestId&&sameIds(draft.mcpServerIds,base.mcp.serverIds)){
   const observed=await api('/mcp-targets/control');
   if(observed.revision!==base.mcp.revision||!sameIds(observed.serverIds,base.mcp.serverIds))throw Error('MCP 配置已变化，请刷新后核对');
   mcpUnchanged=observed.synchronized===true&&!observed.pendingRequestId;
  }
  if(!mcpUnchanged)await syncMcp(api,'control',base,draft,requestId);
  stage='Proxy';let proxyUnchanged=false;
  if(base.proxy.synchronized===true&&(draft.proxyProfileId||null)===(base.proxy.proxyProfileId||null)){
   const observed=await api('/control-proxy');
   if(observed.revision!==base.proxy.revision||(observed.proxyProfileId||null)!==(base.proxy.proxyProfileId||null))throw Error('Proxy 配置已变化，请刷新后核对');
   proxyUnchanged=observed.synchronized===true;
  }
  if(!proxyUnchanged){const proxy=await api('/control-proxy','PUT',{revision:base.proxy.revision,proxyProfileId:draft.proxyProfileId||null});if(proxy.applied!==true)throw Error('Proxy 未确认');}
  stage='机器人与 Agent';const bot=base.row.bots.find((b:any)=>b.appId===draft.botId);
  if(bot){if(bot.cliId!==draft.agentType){const r=await api('/local-agent/bots/'+bot.appId,'PUT',{cliId:draft.agentType,confirmRestart:true});if(!r.changed)throw Error('Agent 切换未确认');}}
  else if(draft.botId){const b=base.bots.find((b:any)=>b.appId===draft.botId);const r=await api('/local-bots/'+draft.botId+'/bind','POST',{bindingRevision:b?.bindingRevision,cliId:draft.agentType,confirmRestart:true,...(draft.owner?{owner:draft.owner}:{})});if(!r.applied)throw Error('绑定未确认');if(draft.originalBotId){const original=(await api('/bots')).bots.find((b:any)=>b.appId===draft.originalBotId);if(original?.localConfigured)await api('/local-bots/'+draft.originalBotId+'/unbind','POST',{localRevision:original.localRevision,confirmLocalStop:true});}}
  else if(draft.originalBotId){const b=(await api('/bots')).bots.find((b:any)=>b.appId===draft.originalBotId);await api('/local-bots/'+draft.originalBotId+'/unbind','POST',{localRevision:b.localRevision,confirmLocalStop:true});}
  if(change){stage='挂载重建';if(!draft.confirmRestart)throw Error('请确认重建');const r=await api('/control-workspace','POST',{revision:base.controlWorkspace.revision,expectedContainerId:base.controlWorkspace.actual.containerId,workspaceKind:draft.workspaceKind,workspaceSource:draft.workspaceSource,hostMountIds:draft.hostMountIds,confirmRestart:true});if(r.noop===true)return {applied:true,noop:true};if(r.queued!==true)throw Error('重建排队未确认');return {queued:true};}
  return {applied:true};
 }catch(e){throw Error(stage+'未完成；此前确认的步骤已保留，可重试。'+String(e));}
}
