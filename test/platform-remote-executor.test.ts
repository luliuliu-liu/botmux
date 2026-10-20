import {afterEach,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRemoteExecutionBackend} from '../src/platform/workflow/remote-executor.js';
import {PersistenceRequestError,type PersistenceRequest} from '../src/platform/workflow/sync-request.js';
import type {RunNodeRequest} from '../src/workflows/v3/contract.js';

const homes:string[]=[];
afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
function fixture(opts:{loseSubmit?:boolean;malicious?:boolean}={}){
  const home=mkdtempSync(join(tmpdir(),'remote-executor-'));homes.push(home);
  const runId='remote-run',runDir=join(home,'.botmux','v3-runs',runId),attemptId='goal#001/attempts/001';
  const attemptDir=join(runDir,attemptId),outputDir=join(attemptDir,'work'),inputPath=join(runDir,'source.txt');
  mkdirSync(join(home,'.botmux','platform'),{recursive:true});mkdirSync(outputDir,{recursive:true});
  writeFileSync(join(runDir,'journal.api.json'),JSON.stringify({baseUrl:'http://control:8787',token:'run-token',expiresAt:1e12}));
  writeFileSync(join(home,'.botmux','platform','workflow-storage.json'),JSON.stringify({baseUrl:'http://control:8787',token:'registry-token',expiresAt:1e12}));
  writeFileSync(inputPath,'upstream');
  writeFileSync(join(attemptDir,'inputs.json'),JSON.stringify({inputs:[{from:'upstream',name:'source',path:inputPath,kind:'text'}]}));
  writeFileSync(join(attemptDir,'goal.txt'),'write the product');
  const data=Buffer.from('remote product'),sha256=createHash('sha256').update(data).digest('hex');
  const manifest={schemaVersion:1,status:'ok',summary:'done',files:[{name:'result',path:opts.malicious?'../escape':'result.txt',kind:'text',bytes:data.length,sha256,mime:'text/plain'}]};
  const calls:PersistenceRequest[]=[];let lost=opts.loseSubmit===true,cancelled=false;
  const request=(input:PersistenceRequest)=>{
    calls.push(structuredClone(input));
    if(input.path.endsWith('/session'))return{token:'fresh',expiresAt:1e12};
    if(input.path.endsWith('/cancel')){cancelled=true;return{closed:true,result:{closed:true,status:'cancelled'}};}
    if(input.method==='POST'&&!input.path.endsWith('/submit'))return{state:'reserved'};
    if(input.path.endsWith('/submit')){
      const result={closed:true,result:{closed:true,status:'ok',manifest,files:[{path:manifest.files[0]!.path,data:data.toString('base64'),sha256}],stdout:'ok',stderr:''}};
      if(lost){lost=false;throw new PersistenceRequestError(0,'storage_unreachable');}
      return result;
    }
    return cancelled?{closed:true,result:{closed:true,status:'cancelled'}}:{closed:false,state:'running'};
  };
  const backend=createRemoteExecutionBackend({home,runDir,request,pollMs:1});
  const binding={runId,attemptId,attemptDir};
  const lease=backend.attemptLeaseProvider.acquire(binding);
  const controller=new AbortController();
  const req:RunNodeRequest={runId,attemptId,attemptLease:{attemptId,signal:controller.signal,hostToken:lease.hostToken},
    node:{id:'goal',type:'goal',goal:'write',depends:[],inputs:[],humanGate:null},
    botSnapshot:{larkAppId:'cli-test',cliId:'pi',workingDir:'/workspace',model:'provider/model'},
    runDir,attemptDir,inputsPath:join(attemptDir,'inputs.json'),outputDir,
    env:{BOTMUX_GOAL_PATH:join(attemptDir,'goal.txt')},timeoutMs:5000};
  return{home,runDir,attemptDir,outputDir,calls,backend,req,controller};
}

it('retries the exact durable submission after a lost ACK and materializes validated products idempotently',async()=>{
  const f=fixture({loseSubmit:true});
  const result=await f.backend.runNode(f.req);
  expect(result.status).toBe('ok');
  expect(readFileSync(join(f.outputDir,'result.txt'),'utf8')).toBe('remote product');
  expect(JSON.parse(readFileSync(join(f.attemptDir,'manifest.json'),'utf8')).status).toBe('ok');
  const submits=f.calls.filter(call=>call.path.endsWith('/submit'));
  expect(submits).toHaveLength(2);expect(submits[0]!.body).toEqual(submits[1]!.body);
  // Replay the exact accepted request: existing product bytes are verified,
  // not overwritten with a different result.
  expect((await f.backend.runNode(f.req)).status).toBe('ok');
});

it('turns an already-aborted attempt into a remote cancel and returns only after close proof',async()=>{
  const f=fixture();f.controller.abort('operator');
  const result=await f.backend.runNode(f.req);
  expect(result.status).toBe('cancelled');
  expect(f.calls.some(call=>call.path.endsWith('/cancel'))).toBe(true);
});

it('rejects a remote artifact path that escapes the declared output directory',async()=>{
  const f=fixture({malicious:true});
  await expect(f.backend.runNode(f.req)).rejects.toThrow('invalid_remote_artifact');
});
