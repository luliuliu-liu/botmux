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
  apiKey?:string;protocol?:string;authMethod?:string};
export type NativeBinding={appId:string;generation:string;appSecret:string;displayName:string;brand:'feishu'|'lark';owner:{allowedUsers:string[];ownerOpenId?:string}};
export type NativeConfiguration={generation:string;revision:number;agentType:'pi'|'codex'|'claude-code'|'zcode'|'dsh';model:NativeModel;binding:NativeBinding|null;proxy?:import('./container-proxy.mjs').ProxyConfiguration|null};
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
  const provider=markedBlock(text,CODEX_PROVIDER_BEGIN,CODEX_PROVIDER_END);
  return [ownedRoot,provider].filter(Boolean);
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
  const provider=markedBlock(text,CODEX_PROVIDER_BEGIN,CODEX_PROVIDER_END);
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
function removeMarkedBlock(text:string,begin:string,end:string){
  const starts=text.split(begin).length-1,stops=text.split(end).length-1;
  if(starts!==stops||starts>1)throw new Error('codex_global_config_conflict');
  if(!starts)return text;
  const from=text.indexOf(begin),to=text.indexOf(end,from);
  return text.slice(0,from)+text.slice(to+end.length).replace(/^\r?\n/,'');
}
function codexManagedConfiguration(previous:string|null,owned:any,pending:any,file:string,config:NativeConfiguration){
  let base=previous??'';
  const marked=base.includes(CODEX_ROOT_BEGIN)||base.includes(CODEX_PROVIDER_BEGIN);
  if(marked){
    const candidates=codexManagedProjectionCandidates(base);
    const routingDigest=hash(codexRoutingProjection(base));
    if(routingDigest!==owned?.routingDigest&&routingDigest!==pending?.nextRoutingDigest
      &&!candidates.includes(owned?.managedDigest)&&!candidates.includes(pending?.nextManagedDigest))throw new Error('codex_global_config_conflict');
    const unmanagedRoot=codexUnmanagedMarkedRoot(base);
    base=removeMarkedBlock(removeMarkedBlock(base,CODEX_ROOT_BEGIN,CODEX_ROOT_END),CODEX_PROVIDER_BEGIN,CODEX_PROVIDER_END);
    if(unmanagedRoot)base=`${unmanagedRoot}\n${base.replace(/^\s*\n/,'')}`;
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
  if(agentType==='claude-code'&&model.provider==='vercel'&&!model.apiKey?.trim())throw Error('vercel_key_required');
  if(agentType==='zcode'){
    if(oauth||protocol!=='zcode-coding-plan'||model.provider!=='zai'||model.baseUrl!=='https://api.z.ai'||model.modelId!==''||(model.modelIds?.length??0)>0||!model.apiKey?.trim())throw Error('invalid_zcode_coding_plan');
    return {ZCODE_CODING_PLAN_API_KEY:model.apiKey};
  }
  if(!/^[A-Za-z0-9._-]+$/.test(model.provider)||typeof model.modelId!=='string'||(!oauth&&!model.modelId)||!/^https?:\/\//.test(model.baseUrl))throw new Error('invalid_model');
  if(oauth&&model.modelId===''){
    if(agentType==='codex'&&protocol==='openai-responses')return {};
    if(agentType==='claude-code'&&protocol==='anthropic-messages')return {...(model.provider==='vercel'?{ANTHROPIC_BASE_URL:'https://ai-gateway.vercel.sh',ANTHROPIC_CUSTOM_HEADERS:`x-ai-gateway-api-key: Bearer ${model.apiKey||''}`}:{})};
    throw new Error('incompatible_model');
  }
  const ids=model.modelIds??[model.modelId];
  if(!Array.isArray(ids)||!ids.length||ids.length>100||!ids.includes(model.modelId)||ids.some(id=>typeof id!=='string'||!id.trim()||id!==id.trim()||id.length>300||/[\u0000-\u001f\u007f]/.test(id)))throw new Error('invalid_models');
  nativeModelCapabilities(model);
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
    return {...(oauth?(model.provider==='vercel'?{ANTHROPIC_BASE_URL:'https://ai-gateway.vercel.sh',ANTHROPIC_CUSTOM_HEADERS:`x-ai-gateway-api-key: Bearer ${model.apiKey||''}`}:{}) :{ANTHROPIC_BASE_URL:model.baseUrl,ANTHROPIC_API_KEY:model.apiKey||'',ANTHROPIC_MODEL:model.modelId,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'})};
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
  if(agentType==='pi'){
    await synchronizePiNativeConfiguration(home,model);
  }
  if(agentType==='zcode'){
    // Use the pinned upstream credential API. Never send keys through argv or logs.
    const marker=join(home,'.botmux','platform','zcode-key-owned.json'),keyDigest=hash(model.apiKey);
    const nativeFiles=['credentials.json','provider_config.json'].map(name=>join(home,'.zcode','v2',name));
    if(read(marker,null)?.keyDigest!==keyDigest||nativeFiles.some(file=>!existsSync(file))){
      const result=spawnSync('node',['/opt/agent/zcode/native-config.cjs'],{
        input:JSON.stringify({apiKey:model.apiKey}),encoding:'utf8',timeout:30000,
        env:{...process.env,HOME:home,ZCODE_DATA_BASE_DIR:home},maxBuffer:65536,
      });
      if(result.status!==0||result.error)throw Error('zcode_native_configuration_failed');
      save(marker,{keyDigest});
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
  return async(input:NativeConfiguration)=>withFileLock(join(directory,'native-configuration'),async()=>{
    if(!input.generation||!Number.isInteger(input.revision)||input.revision<1)throw new Error('invalid_configuration');
    nativeModelEnvironment(deps.home,input.agentType,input.model);
    const binding=input.binding;
    if(binding&&(!/^[A-Za-z0-9._-]+$/.test(binding.appId)||!binding.generation||!binding.appSecret||!binding.owner?.allowedUsers?.length))throw new Error('invalid_binding');
    const previous=read(currentPath,null),pending=read(pendingPath,null);
    const digest=hash(input);
    if(previous&&(previous.generation!==input.generation||previous.revision>input.revision))throw new Error('stale_configuration');
    if(previous?.revision===input.revision&&previous.digest!==digest)throw new Error('configuration_revision_conflict');
    if(pending&&!pending.completed&&(pending.generation!==input.generation||pending.revision!==input.revision||pending.digest!==digest))throw new Error('pending_configuration_conflict');
    const allowed=new Set([previous?.binding?.appId,binding?.appId,pending?.binding?.appId].filter(Boolean));
    const bots=read(roster,[]);
    if(!Array.isArray(bots)||bots.some(bot=>!allowed.has(bot.larkAppId)))throw new Error('unmanaged_bot_present');
    if(previous?.digest===digest&&previous.rosterDigest===rosterDigest(bots)&&previous.modelDigest===modelDigest(deps.home,input)){
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
    const summary={generation:input.generation,revision:input.revision,digest,publicDigest:nativeConfigurationPublicDigest(input),rosterDigest:rosterDigest(observed),modelDigest:modelDigest(deps.home,input),binding:binding?{appId:binding.appId,generation:binding.generation}:null};
    save(currentPath,summary);save(pendingPath,{...summary,completed:true});
    return {generation:summary.generation,revision:summary.revision,binding:summary.binding};
  });
}
