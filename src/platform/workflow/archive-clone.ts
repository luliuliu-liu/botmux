import {homedir} from 'node:os';
import {join} from 'node:path';
import {readFileSync,lstatSync} from 'node:fs';
import {controlRuntime} from './agent-pool-client.js';
import {requestPersistenceSync,type PersistenceRequester} from './sync-request.js';
import type {WorkflowArchiveManifest} from './archive-contract.js';
/** CLI 用 Control 已有 registry 身份读取归档，不签发已清理 run 的执行 token。 */
function registryIdentity(home:string){const path=join(home,'.botmux/platform/workflow-storage.json'),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('unsafe_workflow_storage_identity');return JSON.parse(readFileSync(path,'utf8'));}
export function archivedManifestForClone(runId:string,home=homedir(),request:PersistenceRequester=requestPersistenceSync):WorkflowArchiveManifest|null{
 if(!controlRuntime(home))return null;
 let identity;try{identity=registryIdentity(home);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}
 return readArchiveManifest(runId,identity,request);
}
export function readArchiveManifest(runId:string,identity:{baseUrl:string;token:string;expiresAt:number},request:PersistenceRequester=requestPersistenceSync):WorkflowArchiveManifest|null{
 let result;try{result=request({...identity,path:'/archives/'+encodeURIComponent(runId),method:'GET'});}catch(e:any){if(e.status===404||e.status===409&&e.code==='archive_not_verified')return null;throw e;}
 if(result.schema!=='acp-workflow-archive-v1'||result.runId!==runId||result.summary?.readOnly!==true||result.summary?.logsArchived!==false)throw Error('invalid_workflow_archive');
 return result;
}
export function archivedArtifactBytes(runId:string,key:string,home=homedir(),request:PersistenceRequester=requestPersistenceSync):{data:string;sha256:string;bytes:number}{
 if(!controlRuntime(home)||!/^[a-f0-9]{64}$/.test(key))throw Error('archive_reader_required');
 const result=request({...registryIdentity(home),path:'/archives/'+encodeURIComponent(runId)+'/artifact/'+key,method:'GET'});
 if(typeof result.data!=='string'||result.data.length>6*1024*1024||!Number.isSafeInteger(result.bytes)||result.bytes>4*1024*1024)throw Error('invalid_archive_artifact');
 return result;
}
