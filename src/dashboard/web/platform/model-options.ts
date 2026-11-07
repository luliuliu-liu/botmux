export type ModelOption={profileId:string;displayName:string;provider:string;modelId:string;modelIds?:string[];protocol?:string;authMethod?:string;enabled:boolean};
export type NormalizedModelSelection={authMethod:'api-key'|'oauth';modelProfileId:string|null;modelId:string|null};
export const dynamicModel=(model:ModelOption)=>['zcode-coding-plan','vercel-claude'].includes(model.protocol||'');
export const idsOf=(model:ModelOption)=>dynamicModel(model)?['']:model.modelIds?.length?model.modelIds:[model.modelId];
export const modelOptionLabel=(model:ModelOption,id:string)=>dynamicModel(model)
  ?model.protocol==='vercel-claude'?'Vercel Key + Claude 订阅登录 · 模型由 Claude 管理':'BigModel Coding Plan API Key · 模型由 ZCode /model 选择'
  :`${id}${id===model.modelId?' · 默认':''}`;
export const modelGroupLabel=(model:ModelOption)=>`${model.displayName} · ${model.provider}${!model.enabled?'（已停用）':''}`;
export const nativeOAuthSupported=(agentType:string,authMethods?:string[])=>['codex','zcode'].includes(agentType)&&(!authMethods||authMethods.includes('oauth'));
export const configuredModelSelection=(authMethod:unknown,profileId:unknown,modelId:unknown)=>JSON.stringify(authMethod==='oauth'?[null,null]:[profileId??null,modelId??'']);
export function normalizeModelSelection(agentType:string,value:string,oauthModelId:unknown,models:ModelOption[]=[]):NormalizedModelSelection{
  let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new Error('请选择有效的登录方式和模型连接');}
  if(!Array.isArray(parsed)||parsed.length!==2)throw new Error('请选择有效的登录方式和模型连接');
  const [profileId,selectedModelId]=parsed;
  if(profileId===null){
    if(!nativeOAuthSupported(agentType))throw new Error('此 Agent 不支持原生 OAuth 登录');
    return {authMethod:'oauth',modelProfileId:null,modelId:agentType==='zcode'?null:String(oauthModelId??'').trim()||null};
  }
  if(typeof profileId!=='string'||!profileId)throw new Error('请选择模型连接');
  const model=models.find(item=>item.profileId===profileId);
  const modelId=model&&dynamicModel(model)?null:String(selectedModelId??'').trim()||null;
  return {authMethod:'api-key',modelProfileId:profileId,modelId};
}
/** 创建接口以省略表示默认/动态模型；更新接口仍使用null，不能混用。 */
export function modelSelectionForCreate(selection:NormalizedModelSelection){
  const {modelId,...fields}=selection;
  return selection.authMethod==='api-key'&&modelId===null?fields:selection;
}
export const normalizedAckModelId=(agentType:string,authMethod:unknown,modelId:unknown,protocol?:string|null)=>
  authMethod==='oauth'&&agentType==='zcode'||['zcode-coding-plan','vercel-claude'].includes(protocol||'')?null:String(modelId??'').trim()||null;
