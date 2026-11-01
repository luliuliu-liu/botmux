export type ModelOption={profileId:string;displayName:string;provider:string;modelId:string;modelIds?:string[];protocol?:string;authMethod?:string;enabled:boolean};
export const dynamicModel=(model:ModelOption)=>['zcode-coding-plan','vercel-claude'].includes(model.protocol||'');
export const idsOf=(model:ModelOption)=>dynamicModel(model)?['']:model.modelIds?.length?model.modelIds:[model.modelId];
export const modelOptionLabel=(model:ModelOption,id:string)=>dynamicModel(model)
  ?model.protocol==='vercel-claude'?'Claude 订阅登录（Vercel 网关 · 需已存 Vercel Key）':'BigModel Coding Plan API Key · 模型由 ZCode /model 选择'
  :`${id}${id===model.modelId?' · 默认':''}`;
export const modelGroupLabel=(model:ModelOption)=>`${model.displayName} · ${model.provider}${!model.enabled?'（已停用）':''}`;
