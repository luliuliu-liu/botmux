/** Image-local native Botmux configuration; no control-plane credentials. */
import { createHash } from 'node:crypto';
import {spawnSync} from 'node:child_process';
import { mkdirSync,readFileSync,existsSync,realpathSync,unlinkSync } from 'node:fs';
import {dirname,join} from 'node:path';
import {withFileLock} from '../../utils/file-lock.js';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import {mutateBotsJsonAtomic} from '../../setup/bots-store.js';
import {piNativeConfigurationDigest,synchronizePiNativeConfiguration} from './pi-native-config.mjs';
import {agentEnvironmentKeys,containerAgentDirectories,nativeConfigurationPublicDigest,writeContainerAgentConfiguration,readContainerAgentEnvironment,readContainerAgentModel,managedClaudeEnvironment} from './container-agent-files.mjs';
import {dshModelPatchPath} from './dsh-model-patch.js';
import {proxyEnvironment,readProxy} from './container-proxy.mjs';

export type NativeReasoningLevel='low'|'medium'|'high'|'xhigh'|'max'|'ultra';
export type NativeReasoningSummary='none'|'auto'|'concise'|'detailed';
export type NativeModelCapability={modelId:string;inputModalities:Array<'text'|'image'>;contextWindow:number;maxTokens:number;
  reasoningLevels:NativeReasoningLevel[];defaultReasoningLevel:NativeReasoningLevel|null;
  supportsReasoningSummaries?:boolean;defaultReasoningSummary?:NativeReasoningSummary};
export type NativeModel={provider:string;baseUrl:string;modelId:string;modelIds?:string[];modelCapabilities?:NativeModelCapability[];
  claudeModelRouting?:{haiku?:string;sonnet?:string;opus?:string;subagent?:string};apiKey?:string;protocol?:string;authMethod?:string};
export type NativeBinding={appId:string;generation:string;appSecret:string;displayName:string;brand:'feishu'|'lark';owner:{allowedUsers:string[];ownerOpenId?:string}};
export type NativeCliConfiguration={agentType:'pi'|'codex'|'claude-code'|'zcode'|'dsh'|'traex';revision:number;model:NativeModel};
export type NativeConfiguration={hostMounts?:Array<{id:string;name:string;path:string}>;generation:string;revision:number;agentType:'pi'|'codex'|'claude-code'|'zcode'|'dsh'|'traex';model:NativeModel;binding:NativeBinding|null;proxy?:import('./container-proxy.mjs').ProxyConfiguration|null;clis?:NativeCliConfiguration[]};
type Fleet={supervisorAlive:boolean;rows:Array<{appId:string;alive:boolean;status:string}>};
type Dependencies={home:string;stop:(appId:string)=>Promise<{ok:boolean}>;start:(appId:string)=>Promise<{ok:boolean}>;fleet:()=>Fleet;busy:()=>Promise<boolean>};
const read=(path:string,fallback:any)=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):fallback;
const save=(path:string,value:unknown)=>atomicWriteFileSync(path,JSON.stringify(value),{mode:0o600});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const managedEnvKeys=new Set([...Object.values(agentEnvironmentKeys).flat(),'CODEX_HOME','CLAUDE_CONFIG_DIR','PI_CODING_AGENT_DIR']);
const rosterDigest=(bots:any[])=>hash(bots.map(bot=>({appId:bot.larkAppId,secret:bot.larkAppSecret,cli:bot.cliId,model:bot.model,workingDir:bot.workingDir,
  allowedUsers:bot.allowedUsers,ownerOpenId:bot.ownerOpenId,env:Object.fromEntries(Object.entries(bot.env||{}).filter(([key])=>managedEnvKeys.has(key)).sort())})));
function modelDigest(home:string,config:NativeConfiguration){
  const file=config.agentType==='codex'?join(home,'.codex','config.toml'):null;
  return hash({native:config.agentType==='pi'?piNativeConfigurationDigest(home,config.model):file&&existsSync(file)?hash(codexManagedProjection(readFileSync(file,'utf8'))):null,
    codexCatalog:config.agentType==='codex'&&existsSync(join(home,'.codex',CODEX_CATALOG_FILE))
      ?hash(readFileSync(join(home,'.codex',CODEX_CATALOG_FILE),'utf8')):null,
    dsh:config.agentType==='dsh'&&existsSync(dshModelPatchPath(home))?hash(readFileSync(dshModelPatchPath(home),'utf8')):null,
    environment:readContainerAgentEnvironment(home,config.agentType),model:readContainerAgentModel(home,config.agentType)});
}
const runtimeModel=(config:NativeConfiguration)=>config.model.modelId
  ?config.agentType==='pi'?`${config.model.provider}/${config.model.modelId}`:config.model.modelId
  :null;
const CODEX_ROOT_BEGIN='# botmux-platform-root:begin',CODEX_ROOT_END='# botmux-platform-root:end';
const CODEX_PROVIDER_BEGIN='# botmux-platform-provider:begin',CODEX_PROVIDER_END='# botmux-platform-provider:end';
const CODEX_CATALOG_FILE='platform-models.json';
const NATIVE_REASONING_LEVELS=['low','medium','high','xhigh','max','ultra'] as const;
const defaultNativeCapability=(modelId:string):NativeModelCapability=>({modelId,inputModalities:['text'],contextWindow:128_000,maxTokens:8192,
  reasoningLevels:['low','medium','high','xhigh'],defaultReasoningLevel:'medium',
  supportsReasoningSummaries:false,defaultReasoningSummary:'none'});
function nativeModelCapabilities(model:NativeModel):NativeModelCapability[]{
  const ids=model.modelIds?.length?model.modelIds:[model.modelId];
  const source=model.modelCapabilities??ids.map(defaultNativeCapability);
  if(source.length!==ids.length||source.some((item,index)=>item.modelId!==ids[index]
    ||!Array.isArray(item.inputModalities)||!item.inputModalities.includes('text')
    ||item.inputModalities.some(value=>!['text','image'].includes(value))
    ||!Number.isSafeInteger(item.contextWindow)||item.contextWindow<1024||item.contextWindow>10_000_000
    ||!Number.isSafeInteger(item.maxTokens)||item.maxTokens<1||item.maxTokens>item.contextWindow
    ||!Array.isArray(item.reasoningLevels)||item.reasoningLevels.some(value=>!NATIVE_REASONING_LEVELS.includes(value))
    ||item.defaultReasoningLevel!==null&&!item.reasoningLevels.includes(item.defaultReasoningLevel)
    ||item.supportsReasoningSummaries!==undefined&&typeof item.supportsReasoningSummaries!=='boolean'
    ||item.defaultReasoningSummary!==undefined&&!['none','auto','concise','detailed'].includes(item.defaultReasoningSummary)
    ||item.supportsReasoningSummaries===false&&item.defaultReasoningSummary!==undefined&&item.defaultReasoningSummary!=='none'))
    throw Error('invalid_model_capabilities');
  return source.map(item=>({...item,inputModalities:[...new Set(item.inputModalities)],
    reasoningLevels:[...new Set(item.reasoningLevels)],
    supportsReasoningSummaries:item.supportsReasoningSummaries??false,
    defaultReasoningSummary:item.supportsReasoningSummaries?(item.defaultReasoningSummary??'auto'):'none'}));
}
function codexModelCatalog(model:NativeModel){
  return {models:nativeModelCapabilities(model).map((capability,priority)=>({
    slug:capability.modelId,display_name:capability.modelId,description:'Platform managed model',
    default_reasoning_level:capability.defaultReasoningLevel??capability.reasoningLevels[0]??'medium',
    supported_reasoning_levels:capability.reasoningLevels.map(effort=>({effort,description:effort})),
    shell_type:'unified_exec',visibility:'list',supported_in_api:true,priority,
    base_instructions:'You are a coding agent. Follow the user instructions and use the available tools.',
    support_verbosity:false,default_reasoning_summary:capability.defaultReasoningSummary,
    truncation_policy:{mode:'tokens',limit:Math.min(10_000,capability.contextWindow)},context_window:capability.contextWindow,
    experimental_supported_tools:[],tool_mode:'direct',use_responses_lite:false,
    input_modalities:capability.inputModalities,supports_image_detail_original:capability.inputModalities.includes('image'),
    supports_reasoning_effort_updates:capability.reasoningLevels.length>0,
  }))};
}
function codexLegacyManagedProjection(text:string){
  return text.match(/# botmux-platform-(?:root|provider):begin[\s\S]*?# botmux-platform-(?:root|provider):end/g)??[];
}
function markedBlock(text:string,begin:string,end:string){
  const from=text.indexOf(begin),to=from<0?-1:text.indexOf(end,from);
  return from<0||to<0?'':text.slice(from,to+end.length);
}
function codexManagedProjection(text:string){
  const root=markedBlock(text,CODEX_ROOT_BEGIN,CODEX_ROOT_END);
  const ownedRoot=root?[
    CODEX_ROOT_BEGIN,
    ...root.split(/\r?\n/).filter(line=>/^\s*(?:model|model_provider|model_catalog_json|model_supports_reasoning_summaries|cli_auth_credentials_store)\s*=/.test(line)),
    CODEX_ROOT_END,
  ].join('\n'):'';
  return [ownedRoot,providerProjection(text)].filter(Boolean);
}
// The native /model menu persists its selection in config.toml, sometimes
// outside our marker. Model selection is mutable; provider/auth routing is not.
function codexRoutingProjection(text:string){
  return codexManagedProjection(text).map(block=>block.split(/\r?\n/).filter(line=>!/^\s*model\s*=/.test(line)).join('\n'));
}
function codexUnmanagedMarkedRoot(text:string){
  const root=markedBlock(text,CODEX_ROOT_BEGIN,CODEX_ROOT_END);
  if(!root)return '';
  return root.split(/\r?\n/).filter(line=>line!==CODEX_ROOT_BEGIN&&line!==CODEX_ROOT_END
    &&line.trim()&&!/^\s*(?:model|model_provider|model_catalog_json|model_supports_reasoning_summaries|cli_auth_credentials_store)\s*=/.test(line)).join('\n');
}
function codexManagedProjectionCandidates(text:string){
  const root=markedBlock(text,CODEX_ROOT_BEGIN,CODEX_ROOT_END);
  if(!root)return [hash([])];
  const provider=providerProjection(text);
  const fields=root.split(/\r?\n/).filter(line=>/^\s*(?:model|model_provider|model_catalog_json|model_supports_reasoning_summaries|cli_auth_credentials_store)\s*=/.test(line));
  // Older releases hashed the whole block. Codex may later add/change values
  // inside that marker (for example model + reasoning). Recognize the exact
  // sidecar-owned subset, but never accept an unmarked/provider mutation.
  const candidates=[];for(let mask=0;mask<2**fields.length;mask++){
    const block=[CODEX_ROOT_BEGIN,...fields.filter((_,i)=>(mask&(1<<i))!==0),CODEX_ROOT_END].join('\n');
    candidates.push(hash([block,...provider?[provider]:[]]));
  }
  candidates.push(hash(codexLegacyManagedProjection(text)));
  return [...new Set(candidates)];
}
/** Codex appends its own tables (for example [tui]) after the platform
 * provider table, landing inside our end marker. Only the provider table
 * itself is platform-owned; later tables stay unmanaged user content. */
export function providerProjection(text:string){
  const block=markedBlock(text,CODEX_PROVIDER_BEGIN,CODEX_PROVIDER_END);
  if(!block)return '';
  const lines=block.split(/\r?\n/);
  let tables=0;
  for(let i=0;i<lines.length;i++){
    if(/^\s*\[/.test(lines[i]!)&&++tables===2){
      // Codex separates appended tables with a blank line; the platform block
      // never contained it, so trim back to the owned table exactly.
      let end=i;while(end>1&&!lines[end-1]!.trim())end--;
      return [CODEX_PROVIDER_BEGIN,...lines.slice(1,end),CODEX_PROVIDER_END].join('\n');
    }
  }
  return block;
}
function providerTrailingTables(text:string){
  const block=markedBlock(text,CODEX_PROVIDER_BEGIN,CODEX_PROVIDER_END);
  if(!block)return '';
  const lines=block.split(/\r?\n/).slice(1,-1);
  let tables=0;
  for(let i=0;i<lines.length;i++){
    if(/^\s*\[/.test(lines[i]!)&&++tables===2)return lines.slice(i).join('\n');
  }
  return '';
}
function removeMarkedBlock(text:string,begin:string,end:string){
  const starts=text.split(begin).length-1,stops=text.split(end).length-1;
  if(starts!==stops||starts>1)throw new Error('codex_global_config_conflict');
  if(!starts)return text;
  const from=text.indexOf(begin),to=text.indexOf(end,from);
  return text.slice(0,from)+text.slice(to+end.length).replace(/^\r?\n/,'');
}
/** Interrupted historical rewrites can leave orphaned marker lines (an end
 * without a begin, or duplicates). They fence every later apply, so strip
 * marker lines that are not part of a well-formed begin/end pair. */
function repairOrphanMarkers(text:string){
  const dropOrphans=(begin:string,end:string)=>{
    let out=text.split(/\r?\n/);
    for(;;){
      const firstBegin=out.findIndex(line=>line.trim()===begin);
      const firstEnd=out.findIndex(line=>line.trim()===end);
      if(firstEnd>=0&&(firstBegin<0||firstEnd<firstBegin)){out.splice(firstEnd,1);continue;}
      const lastBegin=out.reduce((acc,line,index)=>line.trim()===begin?index:acc,-1);
      const lastEnd=out.reduce((acc,line,index)=>line.trim()===end?index:acc,-1);
      if(lastBegin>=0&&(lastEnd<0||lastBegin>lastEnd)){out.splice(lastBegin,1);continue;}
      break;
    }
    return out;
  };
  return dropOrphans(CODEX_PROVIDER_BEGIN,CODEX_PROVIDER_END).join('\n');
}
function codexManagedConfiguration(previous:string|null,owned:any,pending:any,file:string,config:NativeConfiguration){
  let base=previous?repairOrphanMarkers(previous):'';
  const marked=base.includes(CODEX_ROOT_BEGIN)||base.includes(CODEX_PROVIDER_BEGIN);
  if(marked){
    const candidates=codexManagedProjectionCandidates(base);
    const routingDigest=hash(codexRoutingProjection(base));
    if(routingDigest!==owned?.routingDigest&&routingDigest!==pending?.nextRoutingDigest
      &&!candidates.includes(owned?.managedDigest)&&!candidates.includes(pending?.nextManagedDigest))throw new Error('codex_global_config_conflict');
    const unmanagedRoot=codexUnmanagedMarkedRoot(base);
    // Native-appended tables inside the provider marker are user content.
    const trailing=providerTrailingTables(base);
    base=removeMarkedBlock(removeMarkedBlock(base,CODEX_ROOT_BEGIN,CODEX_ROOT_END),CODEX_PROVIDER_BEGIN,CODEX_PROVIDER_END);
    if(unmanagedRoot)base=`${unmanagedRoot}\n${base.replace(/^\s*\n/,'')}`;
    if(trailing)base=`${base.replace(/\s+$/,'')}\n${trailing}\n`;
    // Only remove root-level native selections after verifying platform
    // ownership. Nested profiles and unrelated settings remain untouched.
    const table=base.search(/^\s*\[/m),end=table<0?base.length:table;
    base=base.slice(0,end).replace(/^\s*model\s*=.*(?:\r?\n|$)/gm,'')+base.slice(end);
  }else if(base){
    // Compatibility with the prior full-file writer. Only a byte-identical
    // file recorded by its ownership sidecar may be retired wholesale.
    let ownedSameFile=false;
    try{ownedSameFile=typeof owned?.file==='string'&&realpathSync(owned.file)===realpathSync(file);}catch{}
    if(ownedSameFile){
      if(owned.digest!==hash(base))throw new Error('codex_global_config_conflict');
      base='';
    }
  else if(/^\s*(?:model|model_provider|model_catalog_json|model_supports_reasoning_summaries|cli_auth_credentials_store)\s*=/m.test(base)
      ||/^\s*\[model_providers\.platform\]\s*$/m.test(base))throw new Error('codex_global_config_conflict');
  }
  const preservedRoot=base.split(/^\s*\[/m,1)[0];
  if(/^\s*(?:model|model_provider|model_catalog_json|model_supports_reasoning_summaries|cli_auth_credentials_store)\s*=/m.test(preservedRoot)
    ||/^\s*\[model_providers\.platform\]\s*$/m.test(base))throw new Error('codex_global_config_conflict');
  const {model}=config;
  const root=[
    CODEX_ROOT_BEGIN,
    ...(model.modelId?[`model = ${JSON.stringify(model.modelId)}`]:[]),
    ...(model.authMethod==='oauth'?['cli_auth_credentials_store = "file"']:[
      'model_provider = "platform"',
      `model_catalog_json = ${JSON.stringify(join(dirname(file),CODEX_CATALOG_FILE))}`,
      // Codex supports this native setting. Platform providers use it by
      // default so their Responses-compatible gateway receives reasoning
      // metadata when a selected model supports a requested summary.
      'model_supports_reasoning_summaries = true',
    ]),
    CODEX_ROOT_END,
  ].join('\n')+'\n';
  const provider=model.authMethod==='oauth'?'':[
    CODEX_PROVIDER_BEGIN,
    '[model_providers.platform]',
    'name = "Platform"',
    `base_url = ${JSON.stringify(model.baseUrl)}`,
    'env_key = "PLATFORM_MODEL_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    CODEX_PROVIDER_END,
    '',
  ].join('\n');
  const preserved=base.replace(/^\s*\n/,'').replace(/\s+$/,'');
  return root+(preserved?`${preserved}\n`:'')+provider;
}

export function nativeModelEnvironment(home:string,agentType:string,model:NativeModel):Record<string,string>{
  const environment=nativeModelEnvironmentBase(home,agentType,model);
  return {...(agentType==='claude-code'?managedClaudeEnvironment(environment):environment),...proxyEnvironment(readProxy(home))};
}
function nativeModelEnvironmentBase(home:string,agentType:string,model:NativeModel):Record<string,string>{
  const protocol=model.protocol||'openai-completions',oauth=model.authMethod==='oauth';
  if(agentType==='traex'){
    if(protocol!=='openai-responses'||!oauth&&(!model.modelId||!model.apiKey||!/^https?:\/\//.test(model.baseUrl)))throw Error('traex_requires_responses');
    return {TRAE_HOME:join(home,'.trae'),TRAECLI_HOME:join(home,'.trae','cli'),...oauth?{}:{PLATFORM_TRAEX_API_KEY:model.apiKey!}};
  }
  if(agentType==='claude-code'&&model.provider==='vercel'&&!model.apiKey?.trim())throw Error('vercel_key_required');
  if(agentType==='zcode'){
    // Account login keeps the Coding Plan protocol; only the credential source
    // differs and the native CLI manages its own session.
    if(protocol!=='zcode-coding-plan'||model.provider!=='zai'||model.baseUrl!=='https://api.z.ai'||model.modelId!==''||(model.modelIds?.length??0)>0)throw Error('invalid_zcode_coding_plan');
    if(!oauth&&!model.apiKey?.trim())throw Error('invalid_zcode_coding_plan');
    return oauth?{}:{ZCODE_CODING_PLAN_API_KEY:model.apiKey!};
  }
  if(!/^[A-Za-z0-9._-]+$/.test(model.provider)||typeof model.modelId!=='string'||(!oauth&&!model.modelId)||!/^https?:\/\//.test(model.baseUrl))throw new Error('invalid_model');
  if(oauth&&model.modelId===''){
    if(agentType==='codex'&&protocol==='openai-responses')return {};
    if(agentType==='claude-code'&&protocol==='anthropic-messages')return {...(model.provider==='vercel'?{ANTHROPIC_BASE_URL:'https://ai-gateway.vercel.sh',ANTHROPIC_CUSTOM_HEADERS:`x-ai-gateway-api-key: Bearer ${model.apiKey||''}`}:{})};
    throw new Error('incompatible_model');
  }
  const ids=model.modelIds??[model.modelId];
  if(!Array.isArray(ids)||!ids.length||ids.length>100||!ids.includes(model.modelId)||ids.some(id=>typeof id!=='string'||!id.trim()||id!==id.trim()||id.length>300||/[\u0000-\u001f\u007f]/.test(id)))throw new Error('invalid_models');
  if(agentType!=='claude-code')nativeModelCapabilities(model);
  if(agentType==='pi'){
    if(oauth||!['openai-completions','openai-responses','anthropic-messages'].includes(protocol))throw new Error('incompatible_model');
    return {PI_MODEL_PROVIDER:model.provider,PI_MODEL_ID:model.modelId,PI_MODEL_API_KEY:model.apiKey||''};
  }
  if(agentType==='codex'){
    if(protocol!=='openai-responses')throw new Error('codex_requires_responses');
    return oauth?{}:{PLATFORM_MODEL_API_KEY:model.apiKey||''};
  }
  if(agentType==='claude-code'){
    if(protocol!=='anthropic-messages')throw new Error('claude_requires_anthropic');
    const routing=model.claudeModelRouting??{};
    if(!routing||typeof routing!=='object'||Array.isArray(routing)||Object.keys(routing).some(k=>!['haiku','sonnet','opus','subagent'].includes(k))||Object.values(routing).some(v=>typeof v!=='string'||!ids.includes(v)))throw Error('invalid_claude_model_routing');
    return {...(oauth?(model.provider==='vercel'?{ANTHROPIC_BASE_URL:'https://ai-gateway.vercel.sh',ANTHROPIC_CUSTOM_HEADERS:`x-ai-gateway-api-key: Bearer ${model.apiKey||''}`}:{}) :{ANTHROPIC_BASE_URL:model.baseUrl,ANTHROPIC_AUTH_TOKEN:model.apiKey||'',ANTHROPIC_MODEL:model.modelId,ANTHROPIC_DEFAULT_HAIKU_MODEL:routing.haiku||model.modelId,ANTHROPIC_DEFAULT_SONNET_MODEL:routing.sonnet||model.modelId,ANTHROPIC_DEFAULT_OPUS_MODEL:routing.opus||model.modelId,CLAUDE_CODE_SUBAGENT_MODEL:routing.subagent||model.modelId,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'})};
  }
  if(agentType==='dsh'){
    if(oauth||!['openai-completions','openai-responses','anthropic-messages'].includes(protocol))throw Error('dsh_requires_api_key_protocol');
    return {DEEPSEEK_API_KEY:model.apiKey||'',PLATFORM_DSH_API_KEY:model.apiKey||'',DEEPSEEK_BASE_URL:model.baseUrl};
  }
  throw new Error('unsupported_agent');
}

export async function writeNativeAgentModel(home:string,config:NativeConfiguration){
  const {model,agentType}=config;
  const environment=nativeModelEnvironment(home,agentType,model),selected=runtimeModel(config);
  if(agentType==='traex'){
    const directory=join(home,'.trae');mkdirSync(directory,{recursive:true,mode:0o700});
    const file=join(directory,'traecli.toml'),begin='# platform-traex:begin',end='# platform-traex:end';
    let previous=existsSync(file)?readFileSync(file,'utf8'):'';
    if(previous.includes(begin)!==previous.includes(end))throw Error('traex_configuration_conflict');
    previous=previous.replace(/# platform-traex:begin[\s\S]*?# platform-traex:end\n?/g,'');
    previous=previous.replace(/# platform-traex-provider:begin[\s\S]*?# platform-traex-provider:end\n?/g,'');
    const boundary=previous.search(/^\s*\[/m),root=boundary<0?previous:previous.slice(0,boundary),tables=boundary<0?'':previous.slice(boundary);
    const clean=root.replace(/^\s*(?:model|model_provider)\s*=.*(?:\r?\n|$)/gm,'');
    const managed=model.authMethod==='oauth'?'':`${begin}\nmodel = ${JSON.stringify(model.modelId)}\nmodel_provider = "platform"\n${end}\n`;
    const provider=model.authMethod==='oauth'?'':`\n# platform-traex-provider:begin\n[model_providers.platform]\nname = "Platform"\nbase_url = ${JSON.stringify(model.baseUrl)}\nenv_key = "PLATFORM_TRAEX_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\n# platform-traex-provider:end\n`;
    const userTables=tables.replace(/# platform-traex-provider:begin[\s\S]*?# platform-traex-provider:end\n?/g,'');
    if(/^\s*\[model_providers\.platform\]/m.test(userTables))throw Error('traex_provider_conflict');
    atomicWriteFileSync(file,managed+clean+'\n'+userTables+provider,{mode:0o600});
  }
  if(agentType==='pi'){
    await synchronizePiNativeConfiguration(home,model);
  }
  if(agentType==='zcode'){
    // Use the pinned upstream credential API. Never send keys through argv or logs.
    // Account login owns its credentials; writing an API-key identity would
    // clobber the native session, so the writer only runs for key auth.
    if(model.authMethod==='oauth'){/* keep native credentials untouched */}
    else{
    const marker=join(home,'.botmux','platform','zcode-key-owned.json'),keyDigest=hash(model.apiKey);
    const nativeFiles=['credentials.json','provider_config.json'].map(name=>join(home,'.zcode','v2',name));
    if(read(marker,null)?.keyDigest!==keyDigest||nativeFiles.some(file=>!existsSync(file))){
      const result=spawnSync('/usr/local/bin/node',['/opt/agent/zcode/native-config.cjs'],{
        input:JSON.stringify({apiKey:model.apiKey}),encoding:'utf8',timeout:30000,
        env:{...process.env,HOME:home,ZCODE_DATA_BASE_DIR:home},maxBuffer:65536,
      });
      if(result.status!==0||result.error)throw Error('zcode_native_configuration_failed');
      save(marker,{keyDigest});
    }
    }
  }
  if(agentType==='dsh'){
    const directory=containerAgentDirectories(home).dsh;
    mkdirSync(directory,{recursive:true,mode:0o700});
    const official=model.protocol==='anthropic-messages'&&/^https:\/\/api\.deepseek\.com\/anthropic\/?$/.test(model.baseUrl);
    const next:Record<string,any>={'agent-default-model':{provider:official?'deepseek-official':'platform',model:model.modelId}};
    if(official)next['llm-deepseek']={baseURL:model.baseUrl,apiKeyEnv:'PLATFORM_DSH_API_KEY'};
    else next['llm-pi-ai']={providers:{platform:{
      api:model.protocol||'openai-completions',baseURL:model.baseUrl,apiKeyEnv:'PLATFORM_DSH_API_KEY',
      models:nativeModelCapabilities(model).map(capability=>({id:capability.modelId,name:capability.modelId,
        reasoning:capability.reasoningLevels.length>0,input:capability.inputModalities,
        contextWindow:capability.contextWindow,maxTokens:capability.maxTokens})),
    }}};
    // Use the native overlay only; never rewrite the user's settings/profile.
    save(dshModelPatchPath(home),[
      {insert:[{id:'platform-sdk-progress',name:'/opt/agent/dsh-progress.mjs'}]},
      {id:'agent-default-model',config:next['agent-default-model']},
      ...(official?[{id:'llm-deepseek',config:next['llm-deepseek']}]:[{id:'llm-pi-ai',config:next['llm-pi-ai']}]),
    ]);
  }
  if(agentType==='codex'){
    const directory=containerAgentDirectories(home).codex;
    mkdirSync(directory,{recursive:true,mode:0o700});
    const file=join(directory,'config.toml');
    const ownership=join(home,'.botmux','platform','codex-model-owned.json');
    const transaction=join(home,'.botmux','platform','codex-model-pending.json');
    const previousText=existsSync(file)?readFileSync(file,'utf8'):null;
    const owned=read(ownership,null),pending=read(transaction,null);
    const next=codexManagedConfiguration(previousText,owned,pending,file,config);
    const nextManagedDigest=hash(codexManagedProjection(next));
    const nextRoutingDigest=hash(codexRoutingProjection(next));
    save(transaction,{schemaVersion:3,file,previousManagedDigest:hash(codexManagedProjection(previousText??'')),nextManagedDigest,nextRoutingDigest});
    const catalog=join(directory,CODEX_CATALOG_FILE);
    if(model.authMethod!=='oauth')atomicWriteFileSync(catalog,JSON.stringify(codexModelCatalog(model)),{mode:0o600});
    atomicWriteFileSync(file,next,{mode:0o600});
    if(model.authMethod==='oauth'){
      try{unlinkSync(catalog);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    save(ownership,{file,managedDigest:nextManagedDigest,routingDigest:nextRoutingDigest});
    try{unlinkSync(transaction);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  writeContainerAgentConfiguration(home,agentType,{env:environment,model:selected});
}

export function createNativeWorkerConfigurator(deps:Dependencies){
 const directory=join(deps.home,'.botmux','platform');mkdirSync(directory,{recursive:true,mode:0o700});
 const currentPath=join(directory,'native-config.json'),pendingPath=join(directory,'native-config-pending.json');
 const roster=join(deps.home,'.botmux','bots.json');
 const cliModelDigest=(cli:NativeCliConfiguration)=>modelDigest(deps.home,{generation:'',revision:0,agentType:cli.agentType,model:cli.model,binding:null});
 const writeCliModels=async(clis:NativeCliConfiguration[])=>{for(const cli of clis)await writeNativeAgentModel(deps.home,{generation:'',revision:cli.revision,agentType:cli.agentType,model:cli.model,binding:null});};
 return async(input:NativeConfiguration)=>withFileLock(join(directory,'native-configuration'),async()=>{
    if(!input.generation||!Number.isInteger(input.revision)||input.revision<1)throw new Error('invalid_configuration');
    nativeModelEnvironment(deps.home,input.agentType,input.model);
    const binding=input.binding;
    if(binding&&(!/^[A-Za-z0-9._-]+$/.test(binding.appId)||!binding.generation||!binding.appSecret||!binding.owner?.allowedUsers?.length))throw new Error('invalid_binding');
    // Peer CLI configurations are file-level only; the active agent is applied
    // through the regular fleet path below.
    const clis:NativeCliConfiguration[]=[];
    for(const cli of input.clis??[]){
      if(!cli||!Number.isInteger(cli.revision)||cli.revision<1||!cli.model
        ||clis.some(item=>item.agentType===cli.agentType))throw new Error('invalid_cli_configuration');
      // The active agent always rides along; it is applied through the fleet path below.
      if(cli.agentType===input.agentType)continue;
      nativeModelEnvironment(deps.home,cli.agentType,cli.model);
      clis.push({agentType:cli.agentType,revision:cli.revision,model:cli.model});
    }
    const previous=read(currentPath,null),pending=read(pendingPath,null);
    // The active digest covers generation/revision/agent/model/binding/proxy with
    // a stable field order; legacy summaries only recorded hash(input) of the
    // pre-multi-CLI body, so both shapes are accepted when fencing a revision.
    const activeDigest=hash({generation:input.generation,revision:input.revision,agentType:input.agentType,model:input.model,binding,proxy:input.proxy??null});
    const legacyDigest=hash({generation:input.generation,revision:input.revision,model:input.model,binding,proxy:input.proxy??null,agentType:input.agentType});
    const digest=hash(input);
    if(previous&&(previous.generation!==input.generation||previous.revision>input.revision))throw new Error('stale_configuration');
    if(previous?.revision===input.revision&&previous.digest!==digest&&previous.digest!==legacyDigest&&previous.activeDigest!==activeDigest)throw new Error('configuration_revision_conflict');
    // An incomplete pending is only intent. A strictly newer revision of the
    // same generation supersedes it (e.g. an upgrade retry after the first
    // apply was interrupted); conflicting intents at the same revision, or a
    // stale rollback, still refuse to proceed.
    if(pending&&!pending.completed){
      if(pending.generation!==input.generation||input.revision<pending.revision||(input.revision===pending.revision&&pending.digest!==digest))throw new Error('pending_configuration_conflict');
    }
    const allowed=new Set([previous?.binding?.appId,binding?.appId,pending?.binding?.appId].filter(Boolean));
    const bots=read(roster,[]);
    if(!Array.isArray(bots)||bots.some(bot=>!allowed.has(bot.larkAppId)))throw new Error('unmanaged_bot_present');
    const clisState=()=>{const state:Record<string,{revision:number;modelDigest:string;configurationDigest:string;publicDigest:string}>={};for(const cli of clis)state[cli.agentType]={revision:cli.revision,modelDigest:cliModelDigest(cli),configurationDigest:hash(cli.model),publicDigest:nativeConfigurationPublicDigest({generation:'',revision:cli.revision,agentType:cli.agentType,model:cli.model,binding:null})};return state;};
    if((previous?.activeDigest===activeDigest||previous?.digest===legacyDigest||previous?.digest===digest)
      &&previous?.rosterDigest===rosterDigest(bots)&&previous?.modelDigest===modelDigest(deps.home,input)){
      const stale=clis.filter(cli=>previous?.clis?.[cli.agentType]?.modelDigest!==cliModelDigest(cli)||previous?.clis?.[cli.agentType]?.revision!==cli.revision||previous?.clis?.[cli.agentType]?.configurationDigest!==hash(cli.model));
      if(stale.length){
        // The active configuration, roster and files are all confirmed current;
        // only peer CLI files lag. Repairing them never touches the fleet.
        if(await deps.busy())throw new Error('agent_busy');
        await writeCliModels(stale);
        const summary={...previous,agentType:input.agentType,digest,activeDigest,clis:clisState(),completed:true};
        save(currentPath,summary);save(pendingPath,summary);
        return {generation:previous.generation,revision:previous.revision,binding:previous.binding};
      }
      const fleet=deps.fleet(),live=fleet.rows.filter(row=>allowed.has(row.appId)&&row.alive);
      if(fleet.supervisorAlive&&(binding?live.length===1&&live[0]?.appId===binding.appId:live.length===0)){
        return {generation:previous.generation,revision:previous.revision,binding:previous.binding};
      }
    }
    if(await deps.busy())throw new Error('agent_busy');
    save(pendingPath,{generation:input.generation,revision:input.revision,digest,binding:binding?{appId:binding.appId,generation:binding.generation}:null});
    // A successful native stop is necessary but not sufficient: re-attest the
    // live supervisor while holding its mutation lock before removing secrets.
    for(const appId of new Set(bots.map(bot=>String(bot.larkAppId)))){
      if(!(await deps.stop(appId)).ok)throw new Error('native_stop_unconfirmed');
    }
    await withFileLock(join(deps.home,'.botmux','pm2-fleet-mutation'),async()=>{
      const fleet=deps.fleet();
      if(!fleet.supervisorAlive||fleet.rows.some(row=>allowed.has(row.appId)&&(row.alive||!['stopped','errored'].includes(row.status))))throw new Error('native_stop_unconfirmed');
      await writeNativeAgentModel(deps.home,input);
      // The fleet is stopped here, the safest moment to refresh peer CLI files.
      await writeCliModels(clis);
      mutateBotsJsonAtomic(roster,current=>{
        if(current.some(bot=>!allowed.has(bot.larkAppId)))throw new Error('unmanaged_bot_present');
        const old=binding?current.find(bot=>bot.larkAppId===binding.appId):undefined;
        const localEnv=Object.fromEntries(Object.entries(old?.env||{}).filter(([key])=>!managedEnvKeys.has(key)));
        return binding?[{...old,name:binding.displayName||binding.appId,displayName:binding.displayName||binding.appId,
          larkAppId:binding.appId,larkAppSecret:binding.appSecret,brand:binding.brand,cliId:input.agentType,workingDir:'/workspace',
          ...(input.agentType==='codex'?{codexAuthSync:'shared',codexInstancePool:undefined}:{}),
          allowedUsers:binding.owner.allowedUsers,ownerOpenId:binding.owner.ownerOpenId,env:localEnv} as any]:[];
      });
    });
    if(binding&&!(await deps.start(binding.appId)).ok)throw new Error('native_start_unconfirmed');
    const observed=read(roster,[]);
    if(binding?observed.length!==1||observed[0].larkAppId!==binding.appId:observed.length!==0)throw new Error('native_configuration_readback_failed');
    const summary={generation:input.generation,revision:input.revision,agentType:input.agentType,digest,activeDigest,publicDigest:nativeConfigurationPublicDigest(input),rosterDigest:rosterDigest(observed),modelDigest:modelDigest(deps.home,input),binding:binding?{appId:binding.appId,generation:binding.generation}:null,clis:clisState()};
    save(currentPath,summary);save(pendingPath,{...summary,completed:true});
    return {generation:summary.generation,revision:summary.revision,binding:summary.binding};
  });
}

/** File-level apply for one non-active CLI. It shares the configuration lock
 * with full applies but never stops or starts the fleet, and records state in
 * the same summary so a later full apply can skip unchanged peers. */
export async function applyNativeCliConfiguration(home:string,cli:NativeCliConfiguration){
  const directory=join(home,'.botmux','platform');mkdirSync(directory,{recursive:true,mode:0o700});
  const currentPath=join(directory,'native-config.json');
  if(!Number.isInteger(cli.revision)||cli.revision<1||!cli.model)throw new Error('invalid_cli_configuration');
  nativeModelEnvironment(home,cli.agentType,cli.model);
  const shape={generation:'',revision:0,agentType:cli.agentType,model:cli.model,binding:null};
  return withFileLock(join(directory,'native-configuration'),async()=>{
    const current=read(currentPath,null);
    if(!current?.generation)throw new Error('native_configuration_missing');
    if(current?.agentType===cli.agentType)throw new Error('active_cli_uses_apply');
    const previous=current?.clis?.[cli.agentType];
    if(previous&&cli.revision<previous.revision)throw new Error('stale_configuration');
    // Same file-based digest the full apply records, so both paths agree on
    // whether a peer CLI's files already match its configuration.
    if(previous&&cli.revision===previous.revision&&previous.modelDigest===modelDigest(home,shape)&&previous.configurationDigest===hash(cli.model))
      return {agentType:cli.agentType,revision:cli.revision,modelId:cli.model.modelId};
    await writeNativeAgentModel(home,{generation:'',revision:cli.revision,agentType:cli.agentType,model:cli.model,binding:null});
    save(currentPath,{...current,agentType:current?.agentType,clis:{...current?.clis,[cli.agentType]:{revision:cli.revision,modelDigest:modelDigest(home,shape),configurationDigest:hash(cli.model),publicDigest:nativeConfigurationPublicDigest({...shape,revision:cli.revision})}}});
    return {agentType:cli.agentType,revision:cli.revision,modelId:cli.model.modelId};
  });
}
