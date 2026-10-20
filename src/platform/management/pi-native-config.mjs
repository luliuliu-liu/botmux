/** Synchronize native Pi auth/defaults from container-global configuration.
 * Node built-ins only. Never log this module's input/files. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,lstatSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,rmdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fileStat(path){try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function objectFile(path){
  const stat=fileStat(path);if(!stat)return {};
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('unsafe_pi_native_file');
  let value;try{value=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));}catch{throw new Error('invalid_pi_native_json');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_pi_native_json');
  return value;
}
function directory(path){mkdirSync(path,{recursive:true,mode:0o700});if(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink())throw new Error('unsafe_pi_native_directory');}
function atomic(path,value){
  const temporary=`${path}.${randomUUID()}.tmp`;
  let fd;try{
    fd=openSync(temporary,'wx',0o600);writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);closeSync(fd);fd=undefined;
    renameSync(temporary,path);
    if(process.platform!=='win32'){const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
  }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}}
}
/** Pi uses proper-lockfile's directory `<file>.lock` with realpath:false.
 * Match that protocol, never unlink an existing/stale lock owned by Pi. A
 * conflict fails closed and can be retried after the native writer finishes. */
async function locked(path,timeoutMs,fn){
  const lock=`${path}.lock`,deadline=Date.now()+timeoutMs;
  for(;;){try{mkdirSync(lock,{mode:0o700});break;}catch(error){
    if(error.code!=='EEXIST')throw error;
    if(Date.now()>=deadline)throw new Error('pi_native_lock_busy');await delay(25);
  }}
  const owned=lstatSync(lock);
  try{return await fn();}finally{const observed=fileStat(lock);if(observed?.ino===owned.ino&&observed.dev===owned.dev&&observed.isDirectory())rmdirSync(lock);}
}
function paths(home){const agent=join(home,'.pi','agent');return {agent,models:join(agent,'models.json'),auth:join(agent,'auth.json'),settings:join(agent,'settings.json'),owner:join(home,'.botmux','platform','pi-native-owner.json')};}
function validate(model){
  if(!model||typeof model.provider!=='string'||!/^[A-Za-z0-9._-]+$/.test(model.provider)||typeof model.apiKey!=='string'||!model.apiKey.trim())throw new Error('invalid_pi_native_model');
  if(!['openai-completions','openai-responses','anthropic-messages'].includes(model.protocol||'openai-completions')||model.authMethod==='oauth')throw new Error('incompatible_pi_native_model');
  const url=new URL(model.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('invalid_pi_native_endpoint');
  const ids=model.modelIds??[model.modelId];
  if(!Array.isArray(ids)||!ids.length||ids.length>100||!ids.includes(model.modelId)||ids.some(id=>typeof id!=='string'||!id.trim()||id!==id.trim()||id.length>300||/[\u0000-\u001f\u007f]/.test(id)))throw new Error('invalid_pi_native_models');
  return ids;
}
export function piNativeConfigurationDigest(home,model){
  try{
    const p=paths(home),models=objectFile(p.models),auth=objectFile(p.auth),settings=objectFile(p.settings);
    return digest({registry:models.providers?.[model.provider],credential:auth[model.provider],
      defaultProvider:settings.defaultProvider,defaultModel:settings.defaultModel,
      modes:[p.models,p.auth,p.settings].map(path=>(fileStat(path)?.mode??0)&0o777)});
  }catch{return null;}
}
export async function synchronizePiNativeConfiguration(home,model,{allowWrite=true,lockTimeoutMs=5000}={}){
  const ids=validate(model),p=paths(home);
  directory(join(home,'.pi'));directory(p.agent);directory(join(home,'.botmux'));directory(dirname(p.owner));
  return locked(p.owner,lockTimeoutMs,()=>locked(p.auth,lockTimeoutMs,()=>locked(p.settings,lockTimeoutMs,()=>{
    const models=objectFile(p.models),auth=objectFile(p.auth),settings=objectFile(p.settings),previous=objectFile(p.owner);
    if(models.providers!==undefined&&(!models.providers||typeof models.providers!=='object'||Array.isArray(models.providers)))throw new Error('invalid_pi_native_json');
    const providers={...(models.providers||{})},credentials={...auth};
    // Retire only the previous platform-owned entries when switching Provider.
    // User-created Providers/OAuth and user-modified old credentials stay intact.
    if(previous.provider&&previous.provider!==model.provider){
      if(digest(credentials[previous.provider]??null)===previous.credentialDigest)delete credentials[previous.provider];
      if(digest(providers[previous.provider]??null)===previous.registryDigest)delete providers[previous.provider];
    }
    const registry={baseUrl:model.baseUrl,api:model.protocol||'openai-completions',apiKey:'$PI_MODEL_API_KEY',
      models:ids.map(id=>({id,name:id,reasoning:false,input:['text'],contextWindow:128000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}))};
    // The secret's single authority is agent-environment.json and every launch
    // path injects PI_MODEL_API_KEY. Pi keeps only the native env reference.
    const credential={type:'api_key',key:'$PI_MODEL_API_KEY'};
    Object.defineProperty(providers,model.provider,{value:registry,enumerable:true,configurable:true,writable:true});
    Object.defineProperty(credentials,model.provider,{value:credential,enumerable:true,configurable:true,writable:true});
    const entries=[
      [p.auth,credentials,auth],[p.models,{...models,providers},models],
      [p.settings,{...settings,defaultProvider:model.provider,defaultModel:model.modelId},settings],
      [p.owner,{provider:model.provider,credentialDigest:digest(credential),registryDigest:digest(registry)},previous],
    ];
    const changed=entries.filter(([path,next,current])=>digest(next)!==digest(current)||((fileStat(path)?.mode??0)&0o777)!==0o600);
    if(changed.length&&!allowWrite)throw new Error('pi_native_configuration_busy');
    for(const [path,value] of changed)atomic(path,value);
    return {provider:model.provider,modelId:model.modelId,models:ids.length,changed:changed.length>0};
  })));
}
