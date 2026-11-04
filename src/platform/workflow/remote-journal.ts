import {createHash,randomUUID} from 'node:crypto';
import {conventionDigest} from './conventions.js';
import {deliveryModeFromArtifacts,WORKFLOW_POLICY_REGISTRATION_PATH} from '../../workflows/v3/delivery-policy.js';
import {existsSync,readFileSync,lstatSync,mkdirSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {withFileLockSync} from '../../utils/file-lock.js';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import type {JournalBackend,JournalBackendResolver} from '../../workflows/v3/journal-backend.js';
import type {JournalMutation,StoredEvent,V3Event} from '../../workflows/v3/event-contract.js';
import {indexConfirmedTerminalEvents,terminalJournalPath,safeTerminalDirectory} from '../../workflows/v3/terminal-session-index.js';
import {promises as fs} from 'node:fs';
import {requestPersistence,requestPersistenceSync,PersistenceRequestError,type AsyncPersistenceRequester,type PersistenceRequester} from './sync-request.js';

type Identity={baseUrl:string;token:string;expiresAt:number;controlId?:string};
type Descriptor=Identity&{conventionsDigest?:string;conventionsVersion?:1;executionMode?:'pool'|'ephemeral';schema:'botmux-journal-api-v1';runId:string;registrationHash:string};
const read=(path:string)=>{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('unsafe_workflow_storage_file');return JSON.parse(readFileSync(path,'utf8'));};
const save=(path:string,value:unknown)=>atomicWriteFileSync(path,JSON.stringify(value),{mode:0o600});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const artifacts=['dag.json','bots.snapshot.json','run.json','spec.json','goal.request.json','params.resolved.json','definition.snapshot.json','grill.state.json','dag.approval.json','authoring.audit.ndjson','lineage.json'];

/** Bounded maintenance, never a terminal request fallback. Only existing,
 * unexpired run-scoped descriptors may issue GET; no bootstrap/renew/acquire. */
export function createRemoteTerminalIndexMaintenance(deps:{home:string;active:boolean;now?:()=>number;maxRuns?:number;request?:(input:Parameters<PersistenceRequester>[0])=>any|Promise<any>}){
  let cursor=0,busy=false;
  return async()=>{
    if(!deps.active||busy)return;busy=true;
    try{
      const root=safeTerminalDirectory(join(deps.home,'.botmux','v3-runs'));
      const entries=(await fs.readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)).sort((a,b)=>a.name.localeCompare(b.name));
      const limit=Math.max(1,Math.min(8,deps.maxRuns??4));
      for(let i=0;i<Math.min(limit,entries.length);i++){
        const entry=entries[(cursor+i)%entries.length]!;
        try{
          const path=terminalJournalPath(root,entry.name),descriptor=read(join(dirname(path),'journal.api.json')) as Descriptor;
          const url=new URL(descriptor.baseUrl);
          if(descriptor.schema!=='botmux-journal-api-v1'||descriptor.runId!==entry.name||typeof descriptor.token!=='string'||!descriptor.token||
            !Number.isSafeInteger(descriptor.expiresAt)||descriptor.expiresAt<=(deps.now??Date.now)()||!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;
          const input={baseUrl:descriptor.baseUrl,token:descriptor.token,path:`/runs/${entry.name}`,method:'GET'};
          let result;
          if(deps.request)result=await deps.request(input);
          else{
            const response=await fetch(descriptor.baseUrl.replace(/\/$/,'')+'/internal/v1/workflow-storage'+input.path,{method:'GET',redirect:'error',
              headers:{authorization:'Bearer '+descriptor.token},signal:AbortSignal.timeout(5000)});
            if(!response.ok)continue;
            result=await response.json();
          }
          if(Array.isArray(result.events))indexConfirmedTerminalEvents(path,result.events);
        }catch{/* Maintenance failure never creates a local authority fallback. */}
        await new Promise<void>(done=>setImmediate(done));
      }
      if(entries.length)cursor=(cursor+limit)%entries.length;
    }catch{/* Storage may not have been initialized yet. */}finally{busy=false;}
  };
}

export function createPlatformJournalResolver(deps:{home:string;active:boolean;request?:PersistenceRequester;requestAsync?:AsyncPersistenceRequester;now?:()=>number;readCacheMs?:number}):JournalBackendResolver{
  const root=join(deps.home,'.botmux','v3-runs'),identityPath=join(deps.home,'.botmux','platform','workflow-storage.json');
  const request=deps.request||requestPersistenceSync,requestAsync=deps.requestAsync||requestPersistence,now=deps.now||Date.now,backends=new Map<string,JournalBackend>();
  return (path,operation)=>{
    if(!deps.active)return undefined;
    const journalPath=resolve(path),directory=dirname(journalPath),id=basename(directory);
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)||journalPath!==join(root,id,'journal.ndjson'))throw new Error('managed_workflow_path_not_allowed');
    if(existsSync(directory)&&lstatSync(directory).isSymbolicLink())throw new Error('unsafe_workflow_directory');
    const descriptorPath=join(directory,'journal.api.json'),pendingPath=join(directory,'journal.api.pending.json');
    if(!existsSync(identityPath))throw new Error('workflow_storage_bootstrap_not_ready');
    if(!existsSync(descriptorPath)&&!existsSync(pendingPath)&&existsSync(journalPath))throw new Error('remote_journal_descriptor_missing');
    let backend=backends.get(journalPath);
    if(!backend){
      let descriptor:Descriptor|undefined,cached:{until:number;events:StoredEvent[]}|undefined;
      function identity():Identity{
        const value=read(identityPath);const url=new URL(value.baseUrl);
        if(!['http:','https:'].includes(url.protocol)||url.username||url.password||typeof value.token!=='string'||!value.token||value.expiresAt<=now())throw new Error('workflow_storage_identity_unavailable');
        return value;
      }
      function descriptorValid(value:Descriptor){
        if(value.schema!=='botmux-journal-api-v1'||value.runId!==id||typeof value.token!=='string'||!value.token||!Number.isSafeInteger(value.expiresAt)||typeof value.baseUrl!=='string'||typeof value.registrationHash!=='string')throw new Error('invalid_remote_journal_descriptor');
        return value;
      }
      function initialize():Descriptor{
        return withFileLockSync(join(directory,'journal.api.initialize'),()=>{
          if(existsSync(descriptorPath))return descriptor=descriptorValid(read(descriptorPath));
          const files:Record<string,string>={};let size=0;
          for(const name of artifacts){const file=join(directory,name);if(!existsSync(file))continue;
            const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('unsafe_workflow_artifact');
            const bytes=readFileSync(file,'utf8');size+=Buffer.byteLength(bytes);if(size>1024*1024)throw new Error('workflow_envelope_too_large');files[name]=bytes;
          }
          if(!files['dag.json'])throw new Error('workflow_definition_not_frozen');
          const definition=JSON.parse(files['dag.json']);if(definition.runId!==id)throw new Error('workflow_definition_identity_mismatch');
          const fresh={runId:id,definition,executionProfiles:files['bots.snapshot.json']?JSON.parse(files['bots.snapshot.json']):{},
            workspaceBinding:{claim:process.env.BOTMUX_WORKSPACE_CLAIM||'agent-workspace',kind:process.env.BOTMUX_WORKSPACE_KIND||'volume',executionMode:process.env.BOTMUX_WORKFLOW_EXECUTION_MODE==='ephemeral'?'ephemeral':'pool',conventionsVersion:1 as const,...(conventionDigest()?{conventionsDigest:conventionDigest()}:{})},authorizationSnapshot:{artifacts:files}};
          const frozenHash=hash(Object.fromEntries(Object.entries(files).filter(([name])=>name!=='grill.state.json'))),pending=existsSync(pendingPath)?read(pendingPath):null;
          if(pending&&pending.frozenHash!==frozenHash)throw new Error('pending_workflow_registration_conflict');
          const registration=pending?.registration||fresh,registrationHash=hash(registration);
          const archiveOnly=deliveryModeFromArtifacts(registration.authorizationSnapshot.artifacts)==='archive-only';
          const registry=identity();save(pendingPath,{registrationHash,frozenHash,registration});
          let result;
          try{result=request({...registry,path:archiveOnly?WORKFLOW_POLICY_REGISTRATION_PATH:'/runs',method:'POST',body:registration});}
          catch(error){
            // 旧服务不能通过忽略未知字段，把仅归档请求变成默认发布。
            if(archiveOnly&&error instanceof PersistenceRequestError&&[404,405].includes(error.status))throw new PersistenceRequestError(409,'workflow_delivery_policy_unsupported');
            throw error;
          }
          descriptor={schema:'botmux-journal-api-v1',runId:id,baseUrl:registry.baseUrl,token:result.token,expiresAt:result.expiresAt,registrationHash,executionMode:registration.workspaceBinding.executionMode,...((registration.workspaceBinding as any).conventionsVersion===1?{conventionsVersion:1,...((registration.workspaceBinding as any).conventionsDigest?{conventionsDigest:(registration.workspaceBinding as any).conventionsDigest}:{})}: {})};
          save(descriptorPath,descriptor);return descriptor;
        });
      }
      function credentials(){
        descriptor=existsSync(descriptorPath)?descriptorValid(read(descriptorPath)):initialize();
        if(descriptor.expiresAt<=now()+60000){
          const registry=identity();if(registry.baseUrl!==descriptor.baseUrl)throw new Error('workflow_storage_endpoint_changed');
          const renewed=request({...registry,path:`/runs/${id}/session`,method:'POST',body:{}});
          descriptor={...descriptor,token:renewed.token,expiresAt:renewed.expiresAt};save(descriptorPath,descriptor);
        }
        return descriptor;
      }
      function renew(){
        const current=descriptorValid(read(descriptorPath)),registry=identity();
        if(current.baseUrl!==registry.baseUrl)throw new Error('workflow_storage_endpoint_changed');
        const result=request({...registry,path:`/runs/${id}/session`,method:'POST',body:{}});
        descriptor={...current,token:result.token,expiresAt:result.expiresAt};save(descriptorPath,descriptor);return descriptor;
      }
      function call(suffix:string,method='GET',body?:unknown){
        const credential=credentials(),input={...credential,path:`/runs/${id}${suffix}`,method,...(body===undefined?{}:{body})};
        try{return request(input);}catch(error){
          // A lost response is not permission to replay the native callback.
          // Retry only the exact request/op ID; the server stores its receipt.
          if(error instanceof PersistenceRequestError&&error.status===0)return request(input);
          if(error instanceof PersistenceRequestError&&error.status===401)return request({...input,token:renew().token});
          throw error;
        }
      }
      function mirror(version:number,events:StoredEvent[]){
        withFileLockSync(join(directory,'journal.api.mirror'),()=>{
          const cachePath=join(directory,'journal.api.cache.json'),previous=existsSync(cachePath)?read(cachePath):null;
          if(previous?.version>version)return;
          atomicWriteFileSync(journalPath,events.map(event=>JSON.stringify(event)+'\n').join(''),{mode:0o600});save(cachePath,{version});
        });
        cached={until:now()+(deps.readCacheMs??250),events:structuredClone(events)};
      }
      backend={
        read(options?:{fresh?:boolean}){
          if(!existsSync(descriptorPath)&&!existsSync(pendingPath)&&!existsSync(join(directory,'dag.json')))return [];
          if(!options?.fresh&&cached&&cached.until>now())return structuredClone(cached.events);
          const result=call('');cached={until:now()+(deps.readCacheMs??250),events:result.events};return structuredClone(result.events);
        },
        // Read-only and registration-free: an unregistered run has nothing to
        // show, and a lost response may be retried because GET has no effect.
        async readAsync(){
          if(!existsSync(descriptorPath))return [];
          let current=descriptorValid(read(descriptorPath));
          const renewAsync=async()=>{
            const registry=identity();if(registry.baseUrl!==current.baseUrl)throw new Error('workflow_storage_endpoint_changed');
            const renewed=await requestAsync({...registry,path:`/runs/${id}/session`,method:'POST',body:{}});
            current={...descriptorValid(read(descriptorPath)),token:renewed.token,expiresAt:renewed.expiresAt};save(descriptorPath,current);descriptor=current;
          };
          if(current.expiresAt<=now()+60000)await renewAsync();
          const get=()=>requestAsync({baseUrl:current.baseUrl,token:current.token,path:`/runs/${id}`,method:'GET'});
          let result;
          try{result=await get();}catch(error){
            if(error instanceof PersistenceRequestError&&error.status===0)result=await get();
            else if(error instanceof PersistenceRequestError&&error.status===401){await renewAsync();result=await get();}
            else throw error;
          }
          cached={until:now()+(deps.readCacheMs??250),events:result.events};return structuredClone(result.events);
        },
        withMutationSync<T>(fn:(mutation:JournalMutation)=>T):T{
          mkdirSync(directory,{recursive:true,mode:0o700});if(lstatSync(directory).isSymbolicLink())throw new Error('unsafe_workflow_directory');
          const holder=randomUUID(),lease=call('/acquire','POST',{holder});
          let version=lease.version,appended=false,eventsRead=false;const initial:StoredEvent[]=lease.events,confirmed:StoredEvent[]=structuredClone(initial);
          try{
            const value=fn({get events(){if(appended&&!eventsRead)throw new Error('journal mutation events must be read before the first append');eventsRead=true;return initial;},
              append(event:V3Event){
                const result=call('/append','POST',{holder,fence:lease.fence,version,operationId:randomUUID(),events:[event]});
                if(result.version!==version+1||result.events?.length!==1)throw new Error('invalid_journal_acknowledgement');
                version=result.version;appended=true;confirmed.push(result.events[0]);
                // The server ACK, not the optional local mirror, registers discovery.
                indexConfirmedTerminalEvents(journalPath,[result.events[0]]);
                try{mirror(version,confirmed);}catch{cached={until:now()+(deps.readCacheMs??250),events:structuredClone(confirmed)};}
                return result.events[0];
              }});
            if(value&&typeof (value as any).then==='function')throw new Error('async_journal_mutation_unsupported');
            return value;
          }finally{
            try{call('/release','POST',{holder,fence:lease.fence});}catch{/* No writes fall back to disk; the bounded server lease will expire. */}
          }
        },
      };
      backends.set(journalPath,backend);
    }
    return backend;
  };
}
