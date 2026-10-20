/** Container-local configuration only. No database or credential transport. */
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,renameSync,symlinkSync,readdirSync,rmdirSync,unlinkSync,realpathSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const agentEnvironmentKeys={
  pi:['PI_MODEL_PROVIDER','PI_MODEL_ID','PI_MODEL_API_KEY'],
  codex:['PLATFORM_MODEL_API_KEY','OPENAI_API_KEY','OPENAI_AUTH_TOKEN','CODEX_API_KEY','OPENAI_BASE_URL'],
  'claude-code':['ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_MODEL','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'],
  zcode:['ZCODE_CODING_PLAN_API_KEY','ZCODE_DATA_BASE_DIR','ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'],
  dsh:['DEEPSEEK_API_KEY','PLATFORM_DSH_API_KEY','DEEPSEEK_BASE_URL','DSH_HOME'],
};
export const containerAgentDirectories=home=>({codex:join(home,'.codex'),'claude-code':join(home,'.claude'),pi:join(home,'.pi','agent'),zcode:join(home,'.zcode'),dsh:join(home,'.dsh')});
export const containerAgentEnvironmentFile=home=>join(home,'.botmux','platform','agent-environment.json');
/** Secret-free, canonical identity shared by Botmux apply and Native Runtime
 * crash recovery. Property order is explicit; raw API/Bot credentials excluded. */
export function nativeConfigurationPublicDigest(config){
  const projection={
    generation:config.generation,revision:config.revision,agentType:config.agentType,
    model:{
      provider:config.model?.provider,baseUrl:config.model?.baseUrl,modelId:config.model?.modelId,
      modelIds:config.model?.modelIds??[],protocol:config.model?.protocol??null,authMethod:config.model?.authMethod??null,
    },
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
/** One stable native home, without copying credentials or racing token refresh.
 * Existing processes keep writing the original directory; future Bot bindings
 * always use the stable alias. Never overwrite a configured global home. */
export function adoptLegacyContainerAgentHome(home,agent,botIds,{archiveUnauthenticated=false}={}){
  if(!['codex','claude-code'].includes(agent))return {adopted:false};
  const target=containerAgentDirectories(home)[agent],credential=agent==='codex'?'auth.json':'.credentials.json';
  const marker=join(home,'.botmux','platform',`${agent}-global-home-migration.json`);
  const claudeState=join(home,'.claude.json');
  const botsRoot=join(home,'.botmux','bots'),leaf=agent==='codex'?'codex':'claude';
  const canonicalLegacy=path=>{
    const id=basename(dirname(path));
    if(basename(path)!==leaf||!/^[-A-Za-z0-9._]+$/.test(id)||id==='.'||id==='..')throw Error('unsafe_container_agent_home');
    let root=botsRoot,parent=dirname(dirname(path));
    try{root=realpathSync(root);}catch{}
    try{parent=realpathSync(parent);}catch{}
    if(parent!==root)throw Error('unsafe_container_agent_home');
    return join(root,id,leaf);
  };
  const atomicMarker=value=>{
    mkdirSync(dirname(marker),{recursive:true,mode:0o700});
    const temporary=`${marker}.${randomUUID()}.tmp`;
    try{writeFileSync(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});renameSync(temporary,marker);}
    finally{try{unlinkSync(temporary);}catch{}}
  };
  const finishClaudeState=()=>{
    if(agent!=='claude-code'||!existsSync(join(target,'.claude.json')))return;
    if(existsSync(claudeState))throw Error('ambiguous_legacy_agent_state');
    renameSync(join(target,'.claude.json'),claudeState);
  };
  const reconcile=journal=>{
    const source=journal.legacy?canonicalLegacy(journal.legacy):null;
    const completed=journal.phase==='complete';
    // Old first implementation: global symlink -> physical App-ID home.
    if(existsSync(target)&&lstatSync(target).isSymbolicLink()){
      const observed=realpathSync(target);
      if(!source||observed!==realpathSync(source))throw Error('unsafe_container_agent_home');
      unlinkSync(target);
    }
    if(source&&existsSync(source)&&!lstatSync(source).isSymbolicLink()){
      if(existsSync(target)){
        if(!lstatSync(target).isDirectory()||lstatSync(target).isSymbolicLink())throw Error('unsafe_container_agent_home');
        if(readdirSync(target).length){
          if(!journal.archive)throw Error('global_agent_home_needs_migration');
          if(!existsSync(journal.archive))renameSync(target,journal.archive);
          else throw Error('ambiguous_global_agent_archive');
        }else rmdirSync(target);
      }
      renameSync(source,target);
    }
    if(!existsSync(target)||!lstatSync(target).isDirectory()||lstatSync(target).isSymbolicLink())throw Error('container_agent_home_missing_after_migration');
    if(source){
      if(!existsSync(source)){mkdirSync(dirname(source),{recursive:true,mode:0o700});symlinkSync(target,source,'dir');}
      else if(!lstatSync(source).isSymbolicLink()||realpathSync(source)!==realpathSync(target))throw Error('legacy_agent_home_conflict');
    }
    finishClaudeState();
    atomicMarker({...journal,schemaVersion:2,agent,phase:'complete'});
    return {adopted:!completed&&journal.adopted===true,...(journal.archive?{archive:journal.archive}:{})};
  };
  if(existsSync(marker)){
    const journal=JSON.parse(readFileSync(marker,'utf8'));
    if(journal.agent!==agent||!['complete','moving',undefined].includes(journal.phase))throw Error('invalid_agent_migration_marker');
    return reconcile(journal);
  }
  const knownIds=[...new Set([
    ...botIds,
    ...(existsSync(botsRoot)?readdirSync(botsRoot,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^[-A-Za-z0-9._]+$/.test(entry.name)&&entry.name!=='.'&&entry.name!=='..').map(entry=>entry.name):[]),
  ])];
  const candidates=knownIds.map(id=>{
    if(typeof id!=='string'||!/^[-A-Za-z0-9._]+$/.test(id)||id==='.'||id==='..')throw Error('invalid_legacy_bot_id');
    return join(botsRoot,id,leaf);
  }).filter(dir=>{
    if(!existsSync(dir))return false;
    const stat=lstatSync(dir);
    return stat.isDirectory()&&!stat.isSymbolicLink()&&readdirSync(dir).length>0;
  });
  // Normalize the first implementation even after Bot rebinding: accept any
  // canonical home below this container's private bots root, not only current IDs.
  if(existsSync(target)&&lstatSync(target).isSymbolicLink()){
    const source=canonicalLegacy(realpathSync(target));
    const journal={schemaVersion:2,agent,phase:'moving',legacy:source,archive:null,adopted:true};
    atomicMarker(journal);return reconcile(journal);
  }
  // A credential-bearing physical global home is authoritative. A history-only
  // home is authoritative only when no legacy home exists; otherwise the latter
  // is the pre-global state and the former must be archived in maintenance mode.
  if(existsSync(target)&&!lstatSync(target).isSymbolicLink()&&readdirSync(target).length>0
    &&(existsSync(join(target,credential))||!candidates.length)){
    const journal={schemaVersion:2,agent,phase:'moving',legacy:null,archive:null,adopted:false};
    atomicMarker(journal);return reconcile(journal);
  }
  if(candidates.length>1)throw Error('ambiguous_legacy_agent_credentials');
  if(!candidates.length){
    if(existsSync(target)&&(!lstatSync(target).isDirectory()||lstatSync(target).isSymbolicLink()))throw Error('unsafe_container_agent_home');
    return {adopted:false};
  }
  const source=candidates[0],stat=lstatSync(source);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.getuid&&stat.uid!==process.getuid()))throw Error('unsafe_legacy_agent_home');
  if(existsSync(join(source,credential))){
    const auth=lstatSync(join(source,credential));
    if(!auth.isFile()||auth.isSymbolicLink())throw Error('unsafe_legacy_agent_credential');
  }
  if(agent==='claude-code'&&existsSync(join(source,'.claude.json'))&&existsSync(claudeState))throw Error('ambiguous_legacy_agent_state');
  let archive;
  if(existsSync(target)&&readdirSync(target).length){
    if(!archiveUnauthenticated)throw Error('global_agent_home_needs_migration');
    const backups=join(home,'.botmux','platform','global-home-backups');mkdirSync(backups,{recursive:true,mode:0o700});
    archive=join(backups,`${agent}-${randomUUID()}`);
  }
  const journal={schemaVersion:2,agent,phase:'moving',legacy:source,archive:archive??null,adopted:true};
  atomicMarker(journal);return reconcile(journal);
}
