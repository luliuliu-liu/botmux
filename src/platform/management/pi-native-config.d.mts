type PiModelCapability={modelId:string;inputModalities:Array<'text'|'image'>;contextWindow:number;maxTokens:number;
 reasoningLevels:Array<'low'|'medium'|'high'|'xhigh'|'max'|'ultra'>;defaultReasoningLevel:'low'|'medium'|'high'|'xhigh'|'max'|'ultra'|null;
 supportsReasoningSummaries?:boolean;defaultReasoningSummary?:'none'|'auto'|'concise'|'detailed'};
type PiModel={provider:string;baseUrl:string;modelId:string;modelIds?:string[];modelCapabilities?:PiModelCapability[];apiKey?:string;protocol?:string;authMethod?:string};
export function piNativeConfigurationDigest(home:string,model:PiModel):string|null;
export function synchronizePiNativeConfiguration(home:string,model:PiModel,options?:{allowWrite?:boolean;lockTimeoutMs?:number}):Promise<{provider:string;modelId:string;models:number;changed:boolean}>;
