/** Container-local configuration only. No database or credential transport. */
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

import {proxyEnvironmentKeys} from './container-proxy.mjs';
export const agentEnvironmentKeys={
  traex:['PLATFORM_TRAEX_API_KEY','TRAE_HOME','TRAECLI_HOME','TRAECLI_PERSONAL_ACCESS_TOKEN'],
  pi:['PI_MODEL_PROVIDER','PI_MODEL_ID','PI_MODEL_API_KEY'],
  codex:['PLATFORM_MODEL_API_KEY','OPENAI_API_KEY','OPENAI_AUTH_TOKEN','CODEX_API_KEY','OPENAI_BASE_URL'],
  'claude-code':['ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_MODEL','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'],
  zcode:['ZCODE_CODING_PLAN_API_KEY','ZCODE_DATA_BASE_DIR','ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'],
  dsh:['DEEPSEEK_API_KEY','PLATFORM_DSH_API_KEY','DEEPSEEK_BASE_URL','DSH_HOME'],
};
for(const keys of Object.values(agentEnvironmentKeys))keys.push(...proxyEnvironmentKeys);
agentEnvironmentKeys['claude-code'].push('ANTHROPIC_CUSTOM_HEADERS','DISABLE_UPDATES','DISABLE_AUTOUPDATER','CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS');
/** Managed images own CLI upgrades; login shells deliberately do not inherit
 * daemon environment. Keep this policy at the container launch boundary, not
 * in upstream host-terminal's security-sensitive inheritance policy. */
export function managedClaudeEnvironment(environment){
 const env={...environment,DISABLE_UPDATES:'1',DISABLE_AUTOUPDATER:'1'};
 // Model connections store the provider root. Claude Code's wire protocol
 // requires Vercel's dedicated compatibility surface, including OAuth mode.
 if(['https://ai-gateway.vercel.sh','https://ai-gateway.vercel.sh/'].includes(env.ANTHROPIC_BASE_URL))
  env.ANTHROPIC_BASE_URL='https://ai-gateway.vercel.sh/claude-code';
 // Vercel sessions with inline MCP tool_addition blocks have failed at
 // messages.N.content. Use native compatibility mode: load tools upfront,
 // without rewriting requests or dropping tools, thinking, or OAuth headers.
 if(['https://ai-gateway.vercel.sh/claude-code','https://ai-gateway.vercel.sh/claude-code/'].includes(env.ANTHROPIC_BASE_URL))
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS='1';
 return env;
}
export const containerAgentDirectories=home=>({codex:join(home,'.codex'),'claude-code':join(home,'.claude'),pi:join(home,'.pi','agent'),zcode:join(home,'.zcode'),dsh:join(home,'.dsh')});
export const containerAgentEnvironmentFile=home=>join(home,'.botmux','platform','agent-environment.json');
/** Secret-free, canonical identity shared by Botmux apply and Native Runtime
 * crash recovery. Property order is explicit; raw API/Bot credentials excluded. */
export function nativeConfigurationPublicDigest(config){
  const projection={
    generation:config.generation,revision:config.revision,agentType:config.agentType,
    model:{
      provider:config.model?.provider,baseUrl:config.model?.baseUrl,modelId:config.model?.modelId,
      modelIds:config.model?.modelIds??[],modelCapabilities:config.model?.modelCapabilities??[],
      protocol:config.model?.protocol??null,authMethod:config.model?.authMethod??null,
    },
    proxy:config.proxy??null,
    binding:config.binding?{
      appId:config.binding.appId,generation:config.binding.generation,displayName:config.binding.displayName,
      brand:config.binding.brand,owner:{
        allowedUsers:config.binding.owner?.allowedUsers??[],ownerOpenId:config.binding.owner?.ownerOpenId??null,
      },
    }:null,
  };
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}
const environmentLock=home=>`${containerAgentEnvironmentFile(home)}.write-lock`;
const validateAgent=agent=>{if(!agentEnvironmentKeys[agent])throw Error('unsupported_container_agent');};
const validateModel=model=>{
  if(model===null)return;
  if(typeof model!=='string'||!model.trim()||model!==model.trim()||model.length>300||/[\u0000-\u001f\u007f]/.test(model))throw Error('invalid_container_agent_model');
};
function readPrivateObject(file){
  if(!existsSync(file))return {};
  const s=lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||(process.getuid&&s.uid!==process.getuid()))throw Error('unsafe_container_agent_environment');
  const value=JSON.parse(readFileSync(file,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_container_agent_environment');
  return value;
}
export function readContainerAgentEnvironment(home,agent){
  validateAgent(agent);
  const value=readPrivateObject(containerAgentEnvironmentFile(home));
  if(!value.agents||!Object.hasOwn(value.agents,agent))return null;
  const entry=value.agents[agent];
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.entries(entry).some(([k,v])=>!agentEnvironmentKeys[agent].includes(k)||typeof v!=='string'||v.includes('\0')))throw Error('invalid_container_agent_environment');
  return entry;
}
export function readContainerAgentModel(home,agent){
  validateAgent(agent);
  const value=readPrivateObject(containerAgentEnvironmentFile(home)),model=value.models?.[agent];
  if(model===undefined)return null;
  validateModel(model);return model;
}
export function writeContainerAgentConfiguration(home,agent,{env,model}){
  validateAgent(agent);validateModel(model);
  if(Object.entries(env).some(([k,v])=>!agentEnvironmentKeys[agent].includes(k)||typeof v!=='string'||v.includes('\0')))throw Error('invalid_container_agent_environment');
  const file=containerAgentEnvironmentFile(home),lock=environmentLock(home);
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  let lockFd;
  const deadline=Date.now()+5000;
  for(;;){try{lockFd=openSync(lock,'wx',0o600);break;}catch(error){
    if(error.code!=='EEXIST')throw Error('container_agent_environment_busy');
    if(Date.now()>=deadline)throw Error('container_agent_environment_busy');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
  }}
  writeFileSync(lockFd,String(process.pid));fsyncSync(lockFd);
  const temporary=`${file}.${randomUUID()}.tmp`;
  try{
    const current=readPrivateObject(file);
    writeFileSync(temporary,JSON.stringify({schemaVersion:1,agents:{...current.agents,[agent]:env},models:{...current.models,[agent]:model}}),{mode:0o600,flag:'wx'});
    renameSync(temporary,file);
  }finally{
    try{unlinkSync(temporary);}catch{}
    if(lockFd!==undefined)closeSync(lockFd);try{unlinkSync(lock);}catch{}
  }
}
/** Startup-maintenance only: no Agent process may be writing yet. Runtime
 * writers never stale-break by pathname, avoiding ABA/unlink races. */
export function repairContainerAgentEnvironmentLock(home){
  const lock=environmentLock(home);if(!existsSync(lock))return false;
  let pid=0;try{const raw=readFileSync(lock,'utf8').trim();if(/^\d+$/.test(raw))pid=Number(raw);}catch{}
  if(pid>1){try{process.kill(pid,0);throw Error('container_agent_environment_busy');}catch(error){
    if(error.message==='container_agent_environment_busy')throw error;
  }}
  unlinkSync(lock);return true;
}
export function writeContainerAgentEnvironment(home,agent,env){
  writeContainerAgentConfiguration(home,agent,{env,model:readContainerAgentModel(home,agent)});
}
