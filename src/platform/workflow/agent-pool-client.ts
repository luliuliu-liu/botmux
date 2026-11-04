import {readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {requestPersistenceSync} from './sync-request.js';
import {containerRole} from '../management/container-role.js';

/** Control identity and workspace as recorded by the container entrypoint.
 * CLI panes strip BOTMUX_* variables, yet `botmux workflow architect` runs
 * inside one; without this the Architect silently lost the pool catalogue.
 * The record only counts on a Dev image: a Worker-only image never becomes
 * Control because of a copied state file. */
export function controlRuntime(home=homedir(),env:NodeJS.ProcessEnv=process.env,
 deps:{role?:()=>'control'|'worker'|undefined;imageRole?:()=>string|undefined}={}):{workspaceKind:string;workspaceClaim:string}|undefined{
 const role=deps.role??(()=>containerRole()),imageRole=deps.imageRole??readImageRole;
 let recorded:any;
 try{recorded=JSON.parse(readFileSync(join(home,'.botmux/platform/control-runtime.json'),'utf8'));}catch{recorded=undefined;}
 if(role()!=='control'&&!(recorded?.role==='control'&&imageRole()==='dev'))return undefined;
 const field=(name:string)=>typeof recorded?.[name]==='string'&&recorded[name]?recorded[name]:undefined;
 return {
  workspaceKind:env.BOTMUX_WORKSPACE_KIND||field('workspaceKind')||'volume',
  workspaceClaim:env.BOTMUX_WORKSPACE_CLAIM||field('workspaceClaim')||'agent-workspace',
 };
}
function readImageRole(){try{return readFileSync('/etc/botmux-platform-role','utf8').trim();}catch{return undefined;}}

export function currentPoolCatalog(home=homedir()) {
 const runtime=controlRuntime(home);
 if(!runtime)return undefined;
 const path=join(home,'.botmux/platform/workflow-storage.json');
 if(!existsSync(path))throw Error('workflow_storage_bootstrap_not_ready');
 let identity;try{identity=JSON.parse(readFileSync(path,'utf8'));}catch{throw Error('workflow_storage_bootstrap_not_ready');}
 const pool=requestPersistenceSync({...identity,path:'/agent-pools',method:'POST',body:{
  workspaceKind:runtime.workspaceKind,workspaceSource:runtime.workspaceClaim}});
 return {poolId:pool.poolId,members:pool.members};
}
export function workflowResourceRequest(runDir:string,suffix='',method='GET',body?:unknown) {
 const identity=JSON.parse(readFileSync(join(runDir,'journal.api.json'),'utf8'));
 return requestPersistenceSync({...identity,path:`/runs/${identity.runId}/resources${suffix}`,method,...(body===undefined?{}:{body})});
}
