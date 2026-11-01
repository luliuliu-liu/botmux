export type AgentConfiguration={containerId:string;status:string;revision:number;appliedRevision:number;authMethod?:string;modelProfileId:string|null;modelId?:string|null;botId:string|null};
type Api=(path:string,method:string,body:unknown)=>Promise<any>;
/** A successful HTTP response alone is not proof that the runtime applied it.
 * Model-only updates must not rotate an unchanged Bot binding generation. */
export async function syncAgentConfiguration(api:Api,current:AgentConfiguration,modelProfileId:string|null,botId=current.botId,modelId=modelProfileId===current.modelProfileId?current.modelId:undefined,proxyProfileId?:string|null){
  const result=await api(`/containers/${current.containerId}`,'PUT',{revision:current.revision,modelProfileId,...(proxyProfileId===undefined?{}:{proxyProfileId}),
    ...(modelProfileId===null?{authMethod:'oauth',modelId:modelId||null}:{}),
    ...(modelId===undefined?{}:{modelId}),...(botId!==current.botId?{botId}:{})});
  const observed=result.container as AgentConfiguration|undefined;
  if(!observed||observed.containerId!==current.containerId||observed.status!=='ready'||
    observed.modelProfileId!==modelProfileId||(modelProfileId===null&&observed.authMethod!=='oauth')||(modelId!==undefined&&(observed.modelId||null)!==(modelId||null))||observed.botId!==botId||
    !Number.isInteger(observed.revision)||observed.revision<=current.revision||observed.appliedRevision!==observed.revision){
    throw new Error('配置已提交，但 Agent 尚未确认生效，请刷新状态；不要重复创建 Agent。');
  }
  return observed;
}

export type CliConfigurationRecord={agentType:string;active?:boolean;configured?:boolean;revision:number;appliedRevision:number;authMethod?:string|null;modelProfileId?:string|null;modelProtocol?:string|null;modelName?:string|null;modelId?:string|null;lastError?:string|null;oauthState?:string|null};
/** Per-CLI configuration saves must be attested by the runtime, including the
 * active CLI whose save delegates to the container reconcile path. */
export async function saveCliConfiguration(api:Api,containerId:string,cli:CliConfigurationRecord,modelProfileId:string|null,modelId:string|null){
  const result=await api(`/containers/${containerId}/clis/${encodeURIComponent(cli.agentType)}`,'PUT',{revision:cli.revision,
    ...(modelProfileId===null?{authMethod:'oauth',modelId:modelId||null}:{modelProfileId,modelId:modelId||undefined})});
  const observed=(result?.clis as CliConfigurationRecord[]|undefined)?.find(item=>item.agentType===cli.agentType);
  if(!observed||!Number.isInteger(observed.revision)||observed.revision<=cli.revision||observed.appliedRevision!==observed.revision
    ||observed.modelProfileId!==modelProfileId||(observed.modelId||null)!==(modelId||null)
    ||modelProfileId===null&&observed.authMethod!=='oauth')
    throw new Error('配置已提交，但 Agent 尚未确认生效，请刷新状态；不要重复提交。');
  return observed;
}
export async function syncCliConfiguration(api:Api,containerId:string,agentType:string,revision:number){
  const result=await api(`/containers/${containerId}/clis/${encodeURIComponent(agentType)}/sync`,'POST',{});
  const observed=(result?.clis as CliConfigurationRecord[]|undefined)?.find(item=>item.agentType===agentType);
  if(!observed||observed.appliedRevision!==observed.revision||observed.revision!==revision)
    throw new Error('同步尚未确认生效，请刷新状态后重试。');
  return observed;
}
/** Explicit Bot CLI switch: the instance adopts the target CLI configuration. */
export async function activateCliConfiguration(api:Api,containerId:string,agentType:string,revision:number){
  const result=await api(`/containers/${containerId}/clis/${encodeURIComponent(agentType)}/activate`,'POST',{revision});
  const observed=(result?.clis as CliConfigurationRecord[]|undefined)?.find(item=>item.agentType===agentType);
  if(!observed||observed.active!==true||observed.appliedRevision!==observed.revision)
    throw new Error('切换尚未确认生效，请刷新状态后重试。');
  return observed;
}
/** Instance-level binding/proxy update for multi-CLI instances: the model
 * fields stay owned by per-CLI configuration records. */
export async function syncInstanceBinding(api:Api,current:{containerId:string;revision:number;botId:string|null;proxyProfileId?:string|null},botId:string|null,proxyProfileId?:string|null){
  const result=await api(`/containers/${current.containerId}`,'PUT',{revision:current.revision,
    ...(botId!==current.botId?{botId}:{}),...(proxyProfileId===undefined?{}:{proxyProfileId})});
  const observed=result.container as {containerId:string;status:string;revision:number;appliedRevision:number;botId:string|null;proxyProfileId?:string|null}|undefined;
  if(!observed||observed.containerId!==current.containerId||observed.status!=='ready'||observed.botId!==botId
    ||!Number.isInteger(observed.revision)||observed.revision<=current.revision||observed.appliedRevision!==observed.revision
    ||proxyProfileId!==undefined&&(observed.proxyProfileId??null)!==(proxyProfileId||null))
    throw new Error('配置已提交，但 Agent 尚未确认生效，请刷新状态；不要重复提交。');
  return observed;
}
