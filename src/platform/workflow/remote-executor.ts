import {createHash} from 'node:crypto';
import {readFileSync,existsSync,mkdirSync,lstatSync,realpathSync,writeFileSync} from 'node:fs';
import {join,resolve,relative,dirname,isAbsolute,basename,sep} from 'node:path';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import type {ExecutionBackend} from '../../workflows/v3/execution-backend.js';
import type {AttemptLeaseBinding} from '../../workflows/v3/runtime-host-contract.js';
import type {RunNodeRequest} from '../../workflows/v3/contract.js';
import {PersistenceRequestError,requestPersistenceSync,type PersistenceRequester} from './sync-request.js';
import {sha256,WORKER_COMMAND_SCHEMA,type WorkerCommand} from './worker-protocol.js';

function jobId(run:string,attempt:string){const value=createHash('sha256').update(JSON.stringify(['botmux-worker-v1',run,attempt])).digest('hex').slice(0,32);return`${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;}
const read=(path:string)=>{if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw Error('unsafe_execution_identity');return JSON.parse(readFileSync(path,'utf8'));};
export function createRemoteExecutionBackend({home,runDir,request=requestPersistenceSync,pollMs=1000}:{home:string;runDir:string;request?:PersistenceRequester;pollMs?:number}):ExecutionBackend{
  const run=basename(runDir),root=resolve(home,'.botmux/v3-runs');
  if(resolve(runDir)!==join(root,run))throw Error('managed_execution_path_not_allowed');
  function call(job:string,suffix='',method='GET',body?:unknown){
    const path=join(runDir,'journal.api.json');let identity=read(path);
    const input=()=>({...identity,path:`/runs/${run}/attempts/${job}${suffix}`,method,...(body===undefined?{}:{body})});
    try{return request(input());}catch(error){
      if(error instanceof PersistenceRequestError&&error.status===401){
        const registry=read(join(home,'.botmux/platform/workflow-storage.json'));
        if(registry.baseUrl!==identity.baseUrl)throw Error('workflow_storage_endpoint_changed');
        const issued=request({...registry,path:`/runs/${run}/session`,method:'POST',body:{}});
        identity={...identity,token:issued.token,expiresAt:issued.expiresAt};atomicWriteFileSync(path,JSON.stringify(identity),{mode:0o600});return request(input());
      }
      if(error instanceof PersistenceRequestError&&error.status===0)return request(input());
      throw error;
    }
  }
  const idFor=(binding:AttemptLeaseBinding)=>{if(binding.runId!==run)throw Error('execution_run_identity_mismatch');return jobId(run,binding.attemptId);};
  function cancel(binding:AttemptLeaseBinding){const id=idFor(binding);call(id,'','POST',{attemptId:binding.attemptId});return call(id,'/cancel','POST',{});}
  return{
    attemptLeaseProvider:{
      acquire(binding){const id=idFor(binding);call(id,'','POST',{attemptId:binding.attemptId});return{auditKind:'attemptLease',hostToken:{schema:'remote-worker-lease-v1',jobId:id}};},
      closeBeforeExecution(binding){cancel(binding);},
      drainExternallyOwned(binding){try{const state=cancel(binding);return state.closed?{status:'closed',finalizeAfterProof(){}}:{status:'pending'};}catch{return{status:'unknown'};}},
      cleanupSettled(){/* Durable resource receipts are retained for recovery/audit. */},
    },
    async runNode(req:RunNodeRequest){
      const id=jobId(run,req.attemptId),token=req.attemptLease?.hostToken as any;
      if(req.runId!==run||token?.schema!=='remote-worker-lease-v1'||token.jobId!==id)throw Error('remote_worker_lease_required');
      // Only declared, validated upstream products cross the instance boundary;
      // no tar of state, auth, project config, or the Control home.
      let inputBytes=0;
      const inputs=read(req.inputsPath),command:WorkerCommand={schema:WORKER_COMMAND_SCHEMA,jobId:id,runId:run,attemptId:req.attemptId,node:req.node,
        goal:readFileSync(req.env.BOTMUX_GOAL_PATH!,'utf8'),inputs:inputs.inputs.map((item:any)=>{
          const path=realpathSync(item.path),rel=relative(realpathSync(runDir),path);
          const stat=lstatSync(path);inputBytes+=stat.size;
          if(!rel||isAbsolute(rel)||rel.startsWith('..')||!stat.isFile()||inputBytes>4*1024*1024)throw Error('remote_input_outside_run');
          const buffer=readFileSync(path);return{from:item.from,name:item.name,kind:item.kind,...(item.preview?{preview:item.preview}:{}),...(item.output?{output:item.output}:{}),data:buffer.toString('base64'),sha256:sha256(buffer)};
        }),omitted:inputs.omitted||[],timeoutMs:req.timeoutMs};
      const payload={command,agentType:req.botSnapshot.cliId,model:req.botSnapshot.model};
      const intent=join(req.attemptDir,'execution.request.json');
      if(existsSync(intent)){if(JSON.stringify(read(intent))!==JSON.stringify(payload))throw Error('execution_intent_conflict');}
      else atomicWriteFileSync(intent,JSON.stringify(payload),{mode:0o600});
      const signal=req.attemptLease?.signal??req.cancelSignal,deadline=Date.now()+req.timeoutMs;let cancelling=false;
      // Submission/partition uncertainty cannot be reported as a node failure:
      // the exact remote attempt may already be executing. Retry the identical
      // durable intent until acknowledged or cancel is durably requested.
      let state:any={closed:false},submitted=false;
      for(;;){
        if(signal?.aborted||Date.now()>=deadline)cancelling=true;
        try{
          if(cancelling)state=call(id,'/cancel','POST',{});
          else if(!submitted){state=call(id,'/submit','POST',payload);submitted=true;}
          else state=call(id);
        }catch{await new Promise(resolve=>setTimeout(resolve,pollMs));continue;}
        if(state.closed){
          const result=state.result;if(!result||result.closed!==true||!['ok','fail','cancelled'].includes(result.status))throw Error('unconfirmed_remote_worker_result');
          if(result.manifest&&Array.isArray(result.files)){
            let total=0;
            for(const file of result.files){
              if(typeof file.path!=='string'||typeof file.data!=='string')throw Error('invalid_remote_artifact');
              const path=resolve(req.outputDir,file.path),rel=relative(resolve(req.outputDir),path),buffer=Buffer.from(file.data,'base64');
              total+=buffer.length;if(!rel||isAbsolute(rel)||rel.startsWith('..')||isAbsolute(file.path)||file.path.split(/[\\/]/).includes('..')||buffer.toString('base64')!==file.data||sha256(buffer)!==file.sha256||total>4*1024*1024)throw Error('invalid_remote_artifact');
              let parent=resolve(req.outputDir);
              if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw Error('unsafe_remote_artifact_directory');
              for(const part of rel.split(sep).slice(0,-1)){parent=join(parent,part);if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw Error('unsafe_remote_artifact_directory');}
              mkdirSync(dirname(path),{recursive:true,mode:0o700});
              if(existsSync(path)){if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||sha256(readFileSync(path))!==file.sha256)throw Error('remote_artifact_conflict');}
              else writeFileSync(path,buffer,{flag:'wx',mode:0o600});
            }
            atomicWriteFileSync(join(req.attemptDir,'manifest.json'),JSON.stringify(result.manifest),{mode:0o600});
          }
          if(result.ask!==undefined)atomicWriteFileSync(join(req.attemptDir,'ask.json'),JSON.stringify(result.ask),{mode:0o600});
          for(const name of ['stdout','stderr'])if(typeof result[name]==='string')atomicWriteFileSync(join(req.attemptDir,name+'.log'),result[name],{mode:0o600});
          return{status:cancelling?'cancelled':result.status,manifestPath:join(req.attemptDir,'manifest.json')};
        }
        // Partitions retain ownership. Do not settle/redispatch a node while a
        // remote task might still execute. The run can be cancelled/recovered.
        await new Promise(resolve=>setTimeout(resolve,pollMs));
      }
    },
  };
}
