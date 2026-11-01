import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,statSync,writeFileSync,chmodSync,unlinkSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {jobWorkspace} from '../src/platform/workflow/conventions.js';
import {prepareJobMetadata} from '../src/platform/workflow/job-metadata.js';
import {workerJobId,type WorkerCommand} from '../src/platform/workflow/worker-protocol.js';
const command=(attemptId:string):WorkerCommand=>({schema:'botmux-worker-command-v1',jobId:workerJobId('run-a',attemptId),runId:'run-a',attemptId,
 node:{id:'loop.i001.analyze',type:'goal',goal:'private goal text',depends:[],inputs:[],humanGate:null},goal:'private goal text',inputs:[],timeoutMs:1000,conventionsVersion:1});
const config:any={agentType:'codex',generation:'generation-a',model:{modelId:'model-a',apiKey:'private-api-key'},binding:{appSecret:'private-app-secret'}};
it('maps loop instances and retries to immutable readable job identities without credentials',()=>{
 const root=mkdtempSync(join(tmpdir(),'job-metadata-'));try{
  for(const attempt of ['loop.i001.analyze#001/attempts/001','loop.i001.analyze#001/attempts/002','loop.i002.analyze#001/attempts/001']){
   const cmd=command(attempt),context={...jobWorkspace(root,cmd.runId,cmd.jobId),home:join(root,'state')};
   const path=prepareJobMetadata(context,cmd,config),raw=readFileSync(path,'utf8'),metadata=JSON.parse(raw);
   expect(metadata).toMatchObject({runId:'run-a',jobId:cmd.jobId,nodeId:cmd.node.id,attemptId:attempt,instanceId:attempt.split('/attempts/')[0],attemptNumber:Number(attempt.split('/attempts/')[1]),
    state:{attemptDir:join(root,'state','agent/jobs',cmd.jobId,'attempt'),ptyLogPath:join(root,'state','agent/jobs',cmd.jobId,'attempt/pty.log')}});
   expect(statSync(path).mode&0o222).toBe(0);for(const secret of ['private-api-key','private-app-secret','private goal text'])expect(raw).not.toContain(secret);
   expect(prepareJobMetadata(context,cmd,config)).toBe(path);expect(readFileSync(path,'utf8')).toBe(raw);expect(readdirSync(context.work).some(n=>n.startsWith('.job-'))).toBe(false);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('rejects conflicting metadata and links without overwriting their target',()=>{
 const root=mkdtempSync(join(tmpdir(),'job-metadata-conflict-'));try{
  const cmd=command('analyze#001/attempts/001'),context={...jobWorkspace(root,cmd.runId,cmd.jobId),home:join(root,'state')},path=prepareJobMetadata(context,cmd,config);
  expect(()=>prepareJobMetadata(context,{...cmd,node:{...cmd.node,id:'another'}},config)).toThrow('job_metadata_conflict');
  chmodSync(path,0o600);writeFileSync(path,'{"wrong":"identity"}');expect(()=>prepareJobMetadata(context,cmd,config)).toThrow('job_metadata_conflict');
  unlinkSync(path);const target=join(root,'target');writeFileSync(target,'preserved');symlinkSync(target,path);expect(()=>prepareJobMetadata(context,cmd,config)).toThrow();expect(readFileSync(target,'utf8')).toBe('preserved');
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('keeps opaque legacy attempt identifiers as data rather than guessing an attempt number',()=>{
 const root=mkdtempSync(join(tmpdir(),'job-metadata-opaque-'));try{
  const cmd=command('opaque-attempt'),context={...jobWorkspace(root,cmd.runId,cmd.jobId),home:join(root,'state')};
  expect(JSON.parse(readFileSync(prepareJobMetadata(context,cmd,config),'utf8'))).toMatchObject({attemptId:'opaque-attempt',instanceId:null,attemptNumber:null});
 }finally{rmSync(root,{recursive:true,force:true});}
});
