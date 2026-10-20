import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {agentEnvironmentKeys} from './container-agent-files.mjs';
import {readContainerAgentEnvironment,readContainerAgentModel} from './container-agent-files.mjs';

/** Immutable image marker, not an agent/Bot-configurable environment flag.
 * Host installations and upstream multi-Bot installations are unchanged. */
export function containerGlobalAgentMode(rolePath='/etc/botmux-platform-role'):boolean{
  try{return ['control','worker'].includes(readFileSync(rolePath,'utf8').trim());}catch{return false;}
}
const globalMode=containerGlobalAgentMode();
export function containerAgentGlobalConfiguration<T>(input:T,enabled=globalMode,home=homedir()):T{
  const record=input as Record<string,unknown>;
  if(!enabled||!record||typeof record!=='object'||!agentEnvironmentKeys[String(record.cliId)])return input;
  const result:Record<string,unknown>={...record};
  const agent=String(record.cliId),globalEnvironment=readContainerAgentEnvironment(home,agent);
  if(globalEnvironment!==null){
    const keys=new Set(Object.values(agentEnvironmentKeys).flat()),local=Object.fromEntries(
      Object.entries((record.env&&typeof record.env==='object'&&!Array.isArray(record.env))?record.env:{}).filter(([key])=>!keys.has(key)),
    );
    result.env={...local,...globalEnvironment};
  }
  const globalModel=readContainerAgentModel(home,String(record.cliId));
  if(globalModel===null)delete result.model;else result.model=globalModel;
  if(record.cliId!=='codex')return result as T;
  // The entire container is the authority boundary, not the communication Bot.
  result.codexAuthSync='shared';
  delete result['codexInstancePool'];delete result['cliInstanceBinding'];
  return result as T;
}

export function splitContainerAgentEnvironment(
  agent:string,
  value:Record<string,string>|null,
):{global:Record<string,string>;local:Record<string,string>|null}{
  const supported=!!agentEnvironmentKeys[agent],keys=new Set(Object.values(agentEnvironmentKeys).flat());
  if(!supported)return{global:{},local:value};
  const global:Record<string,string>={},local:Record<string,string>={};
  for(const [key,item] of Object.entries(value??{}))(keys.has(key)?global:local)[key]=item;
  return{global,local:Object.keys(local).length?local:null};
}
