export type AgentConfiguration={containerId:string;status:string;revision:number;appliedRevision:number;authMethod?:string;modelProfileId:string|null;modelId?:string|null;botId:string|null};
type Api=(path:string,method:string,body:unknown)=>Promise<any>;
/** A successful HTTP response alone is not proof that the runtime applied it.
 * Model-only updates must not rotate an unchanged Bot binding generation. */
export async function syncAgentConfiguration(api:Api,current:AgentConfiguration,modelProfileId:string|null,botId=current.botId,modelId=modelProfileId===current.modelProfileId?current.modelId:undefined){
  const result=await api(`/containers/${current.containerId}`,'PUT',{revision:current.revision,modelProfileId,
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
