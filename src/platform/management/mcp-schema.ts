/** Browser-safe managed MCP contract. Native adapters never consume arbitrary JSON. */
export const MCP_CLIS=['pi','codex','claude-code','zcode','traex','dsh'] as const;
export type McpCli=typeof MCP_CLIS[number];
export type McpTransport='stdio'|'http'|'sse';
export type McpConfig={name:string;displayName:string;description:string;transport:McpTransport;command?:string;args?:string[];cwd?:string;env:Record<string,string>;url?:string;headers:Record<string,string>;apiKey?:string;auth:{type:'none'|'bearer'|'oauth';token?:string;clientId?:string;clientSecret?:string;callbackPort?:number};cliIds:McpCli[];options:Partial<Record<McpCli,Record<string,unknown>>>;secretKeys:string[]};
export const MCP_API_KEY_VARIABLE='${MCP_API_KEY}';
export const usesMcpApiKey=(config:Pick<McpConfig,'headers'>)=>Object.values(config.headers).some(v=>v.includes(MCP_API_KEY_VARIABLE));
export const MCP_CAPABILITIES:Record<McpCli,{transports:McpTransport[];oauth:boolean;fields:string[]}>={
 pi:{transports:['stdio','http'],oauth:true,fields:['timeoutSec','exposure']},codex:{transports:['stdio','http'],oauth:true,fields:['timeoutSec','startupTimeoutSec']},
 'claude-code':{transports:['stdio','http','sse'],oauth:true,fields:[]},zcode:{transports:['stdio','http','sse'],oauth:true,fields:['timeoutSec','alwaysLoad']},
 traex:{transports:['stdio','http'],oauth:true,fields:['timeoutSec','startupTimeoutSec']},dsh:{transports:['stdio','http'],oauth:false,fields:['timeoutSec','failOnStartupError']},
};
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>!['__proto__','constructor','prototype'].includes(k));
function record(v:unknown,name:string){if(v==null)return {};if(!plain(v)||Object.keys(v).length>64||Object.entries(v).some(([k,s])=>typeof s!=='string'||s.length>16384||!k||k.length>150||/[\r\n\0]/.test(k)))throw Error('invalid_mcp_'+name);return {...v} as Record<string,string>;}
function text(v:unknown,name:string,max=1000){if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))throw Error('invalid_mcp_'+name);return v.trim();}
export function validateMcpConfig(input:unknown):McpConfig{
 if(!plain(input)||Object.keys(input).some(k=>!['name','displayName','description','transport','command','args','cwd','env','url','headers','apiKey','auth','cliIds','options','secretKeys'].includes(k)))throw Error('invalid_mcp_config');
 const name=text(input.name,'name',32);if(!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)||['botmux','constructor','prototype'].includes(name)||name.startsWith('botmux-')||name.startsWith('platform-'))throw Error('reserved_or_invalid_mcp_name');
 const transport=input.transport;if(!['stdio','http','sse'].includes(transport))throw Error('invalid_mcp_transport');
 const env=record(input.env,'env'),headers=record(input.headers,'headers');if(Object.keys(env).some(k=>!/^[_A-Za-z][_A-Za-z0-9]*$/.test(k)))throw Error('invalid_mcp_env_key');
 if(Object.values(headers).some(s=>/[\r\n\0]/.test(s)))throw Error('invalid_mcp_header');
 if(input.apiKey!==undefined&&(typeof input.apiKey!=='string'||input.apiKey.length>16384||/[\r\n\0]/.test(input.apiKey)))throw Error('invalid_mcp_api_key');
 if(input.transport==='stdio'&&input.apiKey)throw Error('mcp_stdio_auth_uses_env');
 const args=input.args??[];if(!Array.isArray(args)||args.length>128||args.some(a=>typeof a!=='string'||a.length>4096||a.includes('\0')))throw Error('invalid_mcp_args');
 let command:string|undefined,url:string|undefined,cwd:string|undefined;
 if(transport==='stdio'){command=text(input.command,'command',1024);if(/\s/.test(command)&&!command.startsWith('/'))throw Error('mcp_command_must_be_executable');if(input.cwd)cwd=text(input.cwd,'cwd',1024);if(cwd&&(!/^\//.test(cwd)||cwd.split('/').includes('..')))throw Error('invalid_mcp_cwd');if(input.url||Object.keys(headers).length)throw Error('mcp_stdio_remote_fields');}
 else{url=text(input.url,'url',4000);let parsed:URL;try{parsed=new URL(url);}catch{throw Error('invalid_mcp_url');}if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.hash)throw Error('invalid_mcp_url');if(input.command||args.length||input.cwd||Object.keys(env).length)throw Error('mcp_http_local_fields');}
 const auth=input.auth??{type:'none'};if(!plain(auth)||!['none','bearer','oauth'].includes(auth.type)||Object.keys(auth).some(k=>!['type','token','clientId','clientSecret','callbackPort'].includes(k)))throw Error('invalid_mcp_auth');
 if(auth.type==='none'&&(auth.token||auth.clientId||auth.clientSecret||auth.callbackPort)||auth.type==='oauth'&&auth.token||auth.type==='bearer'&&(auth.clientId||auth.clientSecret||auth.callbackPort))throw Error('invalid_mcp_auth_fields');
 if(transport==='stdio'&&auth.type!=='none')throw Error('mcp_stdio_auth_uses_env');
 for(const key of ['token','clientId','clientSecret'])if(auth[key]!==undefined&&(typeof auth[key]!=='string'||auth[key].length>16384||/[\r\n\0]/.test(auth[key])))throw Error('invalid_mcp_auth');
 if(auth.callbackPort!==undefined&&(!Number.isSafeInteger(auth.callbackPort)||auth.callbackPort<1024||auth.callbackPort>65535))throw Error('invalid_mcp_callback_port');
 const cliIds=input.cliIds??[...MCP_CLIS];if(!Array.isArray(cliIds)||!cliIds.length||cliIds.some(c=>!MCP_CLIS.includes(c)))throw Error('invalid_mcp_clis');
 const options=input.options??{};if(!plain(options)||Object.keys(options).some(c=>!MCP_CLIS.includes(c as McpCli)))throw Error('invalid_mcp_options');
 for(const [cli,value] of Object.entries(options)){if(!plain(value)||Object.keys(value).some(k=>!MCP_CAPABILITIES[cli as McpCli].fields.includes(k)))throw Error('unsupported_mcp_option');for(const [key,v] of Object.entries(value)){if(['timeoutSec','startupTimeoutSec'].includes(key)&&(!Number.isInteger(v)||v<1||v>3600))throw Error('invalid_mcp_timeout');if(key==='exposure'&&!['direct','deferred','codemode','hidden'].includes(v))throw Error('invalid_mcp_exposure');if(['alwaysLoad','failOnStartupError'].includes(key)&&typeof v!=='boolean')throw Error('invalid_mcp_option');}}
 const addresses=[...Object.keys(env).map(k=>'env.'+k),...Object.keys(headers).map(k=>'headers.'+k),'apiKey','auth.token','auth.clientSecret'];const secretKeys=input.secretKeys??[...Object.keys(env).map(k=>'env.'+k),...Object.keys(headers).filter(k=>!headers[k]!.includes(MCP_API_KEY_VARIABLE)).map(k=>'headers.'+k)];if(!Array.isArray(secretKeys)||secretKeys.some(k=>!addresses.includes(k)))throw Error('invalid_mcp_secret_keys');
 return {name,displayName:input.displayName?text(input.displayName,'display_name',100):name,description:typeof input.description==='string'?input.description.slice(0,2000):'',transport,command,args,cwd,env,url,headers,...(input.apiKey===undefined?{}:{apiKey:input.apiKey}),auth:{...auth,type:auth.type},cliIds:[...new Set(cliIds)] as McpCli[],options,secretKeys:[...new Set([...secretKeys.filter(k=>!k.startsWith('headers.')||!headers[k.slice(8)]?.includes(MCP_API_KEY_VARIABLE)),...(input.apiKey!==undefined?['apiKey']:[]),...['token','clientSecret'].filter(k=>!!auth[k]).map(k=>'auth.'+k)])]};
}
export function mcpTargets(config:McpConfig,clis:string[]){return clis.filter(cli=>config.cliIds.includes(cli as McpCli)&&MCP_CAPABILITIES[cli as McpCli]?.transports.includes(config.transport)&&(config.auth.type!=='oauth'||MCP_CAPABILITIES[cli as McpCli].oauth)&&(config.auth.callbackPort===undefined||['pi','claude-code'].includes(cli))&&(!config.auth.clientId||['pi','claude-code','zcode'].includes(cli))&&(!config.auth.clientSecret||['pi','zcode'].includes(cli)));}
export const MCP_HEADER_SECRET_MASK='********';
const secretAddress=(address:string)=>[address.slice(0,address.indexOf('.')),address.slice(address.indexOf('.')+1)];
const getSecret=(config:McpConfig,address:string)=>address==='apiKey'?config.apiKey:(config as any)[secretAddress(address)[0]!]?.[secretAddress(address)[1]!];
function setSecret(config:McpConfig,address:string,value:string){if(address==='apiKey')config.apiKey=value;else{const [group,name]=secretAddress(address);(config as any)[group!][name!]=value;}}
/** Legacy Bearer records remain runnable; the editor converts them without exposing tokens. */
export function editableMcpConfig(config:McpConfig):McpConfig{
 if(config.auth.type!=='bearer')return config;
 return {...config,apiKey:config.auth.token??'',auth:{type:'none'},headers:{...config.headers,Authorization:'Bearer '+MCP_API_KEY_VARIABLE},secretKeys:[...config.secretKeys.filter(k=>!['auth.token','headers.Authorization'].includes(k)),'apiKey']};
}
export function resolvedMcpHeaders(config:McpConfig){
 if(usesMcpApiKey(config)&&!config.apiKey)throw Error('mcp_api_key_required');
 return Object.fromEntries(Object.entries(config.headers).map(([k,v])=>[k,v.split(MCP_API_KEY_VARIABLE).join(config.apiKey??'')]));
}
function headerMask(name:string,value:string){
 // Retain only the caller-configured Authorization scheme, never invent one.
 const scheme=name.toLowerCase()==='authorization'?value.match(/^([A-Za-z][A-Za-z0-9+.-]{0,31}[ \t]+)/)?.[1]:undefined;
 return (scheme??'')+MCP_HEADER_SECRET_MASK;
}
export function publicMcpConfig(config:McpConfig){
 const copy=JSON.parse(JSON.stringify(config)) as McpConfig;
 const secretKeys=config.secretKeys.filter(k=>!!getSecret(config,k)&&!(k.startsWith('headers.')&&String(getSecret(config,k)).includes(MCP_API_KEY_VARIABLE)));
 for(const k of secretKeys){const [group,name]=secretAddress(k);setSecret(copy,k,group==='headers'?headerMask(name!,config.headers[name!]!):'');}
 return {...copy,secretKeys:config.secretKeys,secretsConfigured:secretKeys};
}
export function mergeMcpSecrets(next:McpConfig,previous:McpConfig|undefined,clear:unknown){
 if(clear!==undefined&&(!Array.isArray(clear)||clear.some(k=>!next.secretKeys.includes(k)&&!previous?.secretKeys.includes(k))))throw Error('invalid_mcp_clear_secrets');
 const result=JSON.parse(JSON.stringify(next)) as McpConfig;
 for(const k of next.secretKeys){
  const [group,key]=secretAddress(k),value=getSecret(result,k);
  const prior=previous?(k==='apiKey'?editableMcpConfig(previous):previous):undefined;
  const old=prior?.secretKeys.includes(k)?getSecret(prior,k):undefined;
  if((clear as string[]|undefined)?.includes(k)){setSecret(result,k,'');continue;}
  if(group==='headers'&&typeof value==='string'&&/^(?:[A-Za-z][A-Za-z0-9+.-]{0,31}[ \t]+)?\*{8}$/.test(value)){
   if(!old||value!==headerMask(key!,old))throw Error('mcp_header_placeholder_requires_original_secret');
   setSecret(result,k,old);
  }else if(!value&&old)setSecret(result,k,old);
 }
 if(result.auth.type==='bearer'&&!result.auth.token)throw Error('mcp_bearer_token_required');
 if(usesMcpApiKey(result)&&!result.apiKey)throw Error('mcp_api_key_required');
 return result;
}
export function importMcpJson(input:unknown){
 if(!plain(input))throw Error('invalid_mcp_import');
 const single=typeof input.name==='string',servers=single?{[input.name]:input}:plain(input.mcpServers)?input.mcpServers:input;
 if(input.mcpServers&&Object.keys(input).some(k=>k!=='mcpServers'))throw Error('unsupported_mcp_import_field');
 if(!Object.keys(servers).length||Object.keys(servers).length>100)throw Error('invalid_mcp_import');
 return Object.entries(servers).map(([name,v])=>{
  if(!plain(v)||Object.keys(v).some(k=>!['name','displayName','description','type','transport','command','args','cwd','env','url','headers','http_headers','apiKey','oauth','auth','timeout','exposure','cliIds','options'].includes(k)))throw Error('unsupported_mcp_import_field');
  if(v.headers&&v.http_headers)throw Error('ambiguous_mcp_headers');
  const transport=v.transport??(v.type==='streamable-http'?'http':v.type??(v.command?'stdio':'http'));
  const options={...v.options};if(v.timeout!==undefined||v.exposure!==undefined)options.pi={...options.pi,...(v.timeout!==undefined?{timeoutSec:v.timeout}:{}),...(v.exposure!==undefined?{exposure:v.exposure}:{})};
  if(v.oauth&&(!plain(v.oauth)||Object.keys(v.oauth).some(k=>!['clientId','clientSecret','callbackPort'].includes(k))))throw Error('unsupported_mcp_import_oauth');
  return validateMcpConfig({name,displayName:v.displayName??name,description:v.description,transport,command:v.command,args:v.args,cwd:v.cwd,env:v.env,url:v.url,headers:v.headers??v.http_headers,apiKey:v.apiKey,cliIds:v.cliIds,options,auth:v.auth??(v.oauth?{...v.oauth,type:'oauth'}:{type:'none'})});
 });
}
