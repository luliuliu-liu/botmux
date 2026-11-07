import {Parameter} from './compact-controls.js';
import {configuredModelSelection,idsOf,modelGroupLabel,modelOptionLabel,nativeOAuthSupported,type ModelOption} from './model-options.js';

type Props={
  agentType:string;models:ModelOption[];value:string;onChange:(value:string)=>void;
  oauthModelId?:string;onOauthModelIdChange?:(value:string)=>void;currentProfileId?:string|null;
  protocols?:string[];authMethods?:string[];disabled?:boolean;required?:boolean;
  selectName?:string;selectAriaLabel:string;oauthName?:string;oauthAriaLabel?:string;
  label?:string;help?:string;emptyLabel?:string;
};

export function compatibleModelOptions(models:ModelOption[],agentType:string,protocols?:string[],authMethods?:string[],currentProfileId?:string|null){
  return models.filter(model=>model.authMethod!=='oauth'&&(model.enabled||model.profileId===currentProfileId)
    &&(!protocols||protocols.includes(model.protocol||'openai-completions'))
    &&(!authMethods||authMethods.includes(model.authMethod||'api-key')));
}

export function ModelAuthSelector({agentType,models,value,onChange,oauthModelId='',onOauthModelIdChange,currentProfileId,
  protocols,authMethods,disabled=false,required=true,selectName='modelSelection',selectAriaLabel,oauthName='oauthModelId',oauthAriaLabel='OAuth 模型（可选）',
  label='登录方式 / 模型',help,emptyLabel='选择原生登录或具体模型'}:Props){
  const candidates=compatibleModelOptions(models,agentType,protocols,authMethods,currentProfileId);
  const oauth=value===configuredModelSelection('oauth',null,null);
  return <>
    <label><Parameter help={help??(agentType==='claude-code'?'普通 API Key 与 Vercel Key + Claude 订阅是两种连接；此平台不提供无需 Vercel Key 的纯原生 Claude OAuth。':'原生 OAuth 不需要共享模型连接；API Key 模型按连接分组。选择配置不会自动发起登录。')}>{label}</Parameter><select key={agentType} aria-label={selectAriaLabel} name={selectName} value={value} onChange={event=>onChange(event.target.value)} required={required} disabled={disabled}>
      <option value="" disabled>{emptyLabel}</option>
      {nativeOAuthSupported(agentType,authMethods)?<option value={configuredModelSelection('oauth',null,null)}>{agentType==='zcode'?'BigModel 账号 OAuth 登录（浏览器授权）':'Codex 原生 OAuth 登录 · 无需模型连接'}</option>:null}
      {candidates.map(model=><optgroup key={model.profileId} label={modelGroupLabel(model)} disabled={!model.enabled}>{idsOf(model).map(id=><option key={id} value={JSON.stringify([model.profileId,id])}>{modelOptionLabel(model,id)}</option>)}</optgroup>)}
    </select></label>
    {oauth&&agentType==='codex'?<label><Parameter help="留空不固定模型，由 Codex 选择原生默认值；填写时仅保存到此 Agent。">OAuth 模型（可选）</Parameter><input name={oauthName} aria-label={oauthAriaLabel} maxLength={300} value={oauthModelId} onChange={event=>onOauthModelIdChange?.(event.target.value)} disabled={disabled} placeholder="使用 CLI 原生默认模型"/></label>:null}
  </>;
}
