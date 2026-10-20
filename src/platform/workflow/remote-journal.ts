import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,lstatSync,mkdirSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {withFileLockSync} from '../../utils/file-lock.js';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import type {JournalBackend,JournalBackendResolver} from '../../workflows/v3/journal-backend.js';
import type {JournalMutation,StoredEvent,V3Event} from '../../workflows/v3/event-contract.js';
import {requestPersistenceSync,PersistenceRequestError,type PersistenceRequester} from './sync-request.js';

type Identity={baseUrl:string;token:string;expiresAt:number;controlId?:string};
type Descriptor=Identity&{schema:'botmux-journal-api-v1';runId:string;registrationHash:string};
const read=(path:string)=>{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('unsafe_workflow_storage_file');return JSON.parse(readFileSync(path,'utf8'));};
const save=(path:string,value:unknown)=>atomicWriteFileSync(path,JSON.stringify(value),{mode:0o600});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const artifacts=['dag.json','bots.snapshot.json','run.json','spec.json','goal.request.json','params.resolved.json','definition.snapshot.json','grill.state.json'];

export function createPlatformJournalResolver(deps:{home:string;active:boolean;request?:PersistenceRequester;now?:()=>number;readCacheMs?:number}):JournalBackendResolver{
  const root=join(deps.home,'.botmux','v3-runs'),identityPath=join(deps.home,'.botmux','platform','workflow-storage.json'),legacyPath=join(deps.home,'.botmux','platform','workflow-local-runs.json');
  const request=deps.request||requestPersistenceSync,now=deps.now||Date.now,backends=new Map<string,JournalBackend>();
  return (path,operation)=>{
    if(!deps.active)return undefined;
    const journalPath=resolve(path),directory=dirname(journalPath),id=basename(directory);
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)||journalPath!==join(root,id,'journal.ndjson'))throw new Error('managed_workflow_path_not_allowed');
    if(existsSync(directory)&&lstatSync(directory).isSymbolicLink())throw new Error('unsafe_workflow_directory');
    const descriptorPath=join(directory,'journal.api.json'),pendingPath=join(directory,'journal.api.pending.json');
    // Only the one-time migration manifest can designate a legacy file run.
    // A missing remote descriptor must NEVER turn an API-backed mirror into
    // a writable local journal. Unknown existing journals fail closed.
    if(!existsSync(legacyPath))throw new Error('workflow_storage_bootstrap_not_ready');
    const legacy=read(legacyPath);
    if(legacy.schema!=='botmux-local-journal-manifest-v1'||!legacy.runs||typeof legacy.runs!=='object')throw new Error('invalid_legacy_workflow_manifest');
    if(legacy.runs[id]){
      if(existsSync(descriptorPath)||existsSync(pendingPath)||!existsSync(journalPath))throw new Error('legacy_journal_identity_changed');
      const first=readFileSync(journalPath,'utf8').split('\n').find(line=>line.trim());
      if(!first||createHash('sha256').update(first).digest('hex')!==legacy.runs[id].firstEventSha256)throw new Error('legacy_journal_identity_changed');
      return undefined;
    }
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
            workspaceBinding:{claim:process.env.BOTMUX_WORKSPACE_CLAIM||'agent-poc-workspace'},authorizationSnapshot:{artifacts:files}};
          const frozenHash=hash(Object.fromEntries(Object.entries(files).filter(([name])=>name!=='grill.state.json'))),pending=existsSync(pendingPath)?read(pendingPath):null;
          if(pending&&pending.frozenHash!==frozenHash)throw new Error('pending_workflow_registration_conflict');
          const registration=pending?.registration||fresh,registrationHash=hash(registration);
          const registry=identity();save(pendingPath,{registrationHash,frozenHash,registration});
          const result=request({...registry,path:'/runs',method:'POST',body:registration});
          descriptor={schema:'botmux-journal-api-v1',runId:id,baseUrl:registry.baseUrl,token:result.token,expiresAt:result.expiresAt,registrationHash};
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
        read(){
          if(!existsSync(descriptorPath)&&!existsSync(pendingPath)&&!existsSync(join(directory,'dag.json')))return [];
          if(cached&&cached.until>now())return structuredClone(cached.events);
          const result=call('');cached={until:now()+(deps.readCacheMs??250),events:result.events};return structuredClone(result.events);
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
