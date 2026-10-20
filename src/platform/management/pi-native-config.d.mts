type PiModel={provider:string;baseUrl:string;modelId:string;modelIds?:string[];apiKey?:string;protocol?:string;authMethod?:string};
export function piNativeConfigurationDigest(home:string,model:PiModel):string|null;
export function synchronizePiNativeConfiguration(home:string,model:PiModel,options?:{allowWrite?:boolean;lockTimeoutMs?:number}):Promise<{provider:string;modelId:string;models:number;changed:boolean}>;
