import {readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {requestPersistenceSync} from './sync-request.js';
import {containerRole} from '../management/container-role.js';

export function currentPoolCatalog(home=homedir()) {
 if(containerRole()!=='control')return undefined;
 const path=join(home,'.botmux/platform/workflow-storage.json');
 if(!existsSync(path))throw Error('workflow_storage_bootstrap_not_ready');
 let identity;try{identity=JSON.parse(readFileSync(path,'utf8'));}catch{throw Error('workflow_storage_bootstrap_not_ready');}
 const pool=requestPersistenceSync({...identity,path:'/agent-pools',method:'POST',body:{
  workspaceKind:process.env.BOTMUX_WORKSPACE_KIND||'volume',workspaceSource:process.env.BOTMUX_WORKSPACE_CLAIM||'agent-workspace'}});
 return {poolId:pool.poolId,members:pool.members};
}
export function workflowResourceRequest(runDir:string,suffix='',method='GET',body?:unknown) {
 const identity=JSON.parse(readFileSync(join(runDir,'journal.api.json'),'utf8'));
 return requestPersistenceSync({...identity,path:`/runs/${identity.runId}/resources${suffix}`,method,...(body===undefined?{}:{body})});
}
