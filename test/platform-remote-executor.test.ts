import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRemoteExecutionBackend} from '../src/platform/workflow/remote-executor.js';
import {PersistenceRequestError,type PersistenceRequest,type PersistenceRequester} from '../src/platform/workflow/sync-request.js';
import type {RunNodeRequest} from '../src/workflows/v3/contract.js';
import {validateDag} from '../src/workflows/v3/dag.js';
import {readJournal} from '../src/workflows/v3/journal.js';
import {runWorkflow} from '../src/workflows/v3/runtime.js';
import {openV3WorkerAttempts} from '../src/workflows/v3/attempt-ledger.js';
import {openV3HostEffects} from '../src/workflows/v3/host-effect-ledger.js';

const homes:string[]=[];
afterEach(()=>{vi.useRealTimers();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
function deferred<T=void>(){
  let resolve!:(value:T|PromiseLike<T>)=>void;
  const promise=new Promise<T>(res=>{resolve=res;});
  return {promise,resolve};
}
function fixture(opts:{loseSubmit?:boolean;malicious?:boolean;terminal?:boolean;request?:PersistenceRequester;skipAcquire?:boolean;runtime?:Record<string,unknown>}={}){
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
    if(opts.request)return opts.request(input);
    if(input.path.endsWith('/session'))return{token:'fresh',expiresAt:1e12};
    if(input.path.endsWith('/cancel')){cancelled=true;return{closed:true,result:{closed:true,status:'cancelled'}};}
    if(input.method==='POST'&&!input.path.endsWith('/submit'))return{state:'reserved'};
    if(input.path.endsWith('/submit')){
      const result={closed:true,...(opts.runtime?{runtime:opts.runtime}:{}),...(opts.terminal?{session:{sessionId:'remote-session',webPort:43210,viewToken:'read-only-boot-capability'}}:{}),result:{closed:true,status:'ok',manifest,files:[{path:manifest.files[0]!.path,data:data.toString('base64'),sha256}],stdout:'ok',stderr:'',...(opts.terminal?{ptyLog:'\u001b[32mTASK OUTPUT\u001b[0m\n'}:{})}};
      if(lost){lost=false;throw new PersistenceRequestError(0,'storage_unreachable');}
      return result;
    }
    return cancelled?{closed:true,result:{closed:true,status:'cancelled'}}:{closed:false,state:'running'};
  };
  const backend=createRemoteExecutionBackend({home,runDir,request,pollMs:1});
  const binding={runId,attemptId,attemptDir};
  const lease=opts.skipAcquire?{hostToken:undefined}:backend.attemptLeaseProvider.acquire(binding);
  const controller=new AbortController();
  const req:RunNodeRequest={runId,attemptId,attemptLease:{attemptId,signal:controller.signal,hostToken:lease.hostToken},
    node:{id:'goal',type:'goal',goal:'write',depends:[],inputs:[],humanGate:null},
    botSnapshot:{larkAppId:'cli-test',cliId:'pi',workingDir:'/workspace',model:'provider/model'},
    runDir,attemptDir,inputsPath:join(attemptDir,'inputs.json'),outputDir,
    env:{BOTMUX_GOAL_PATH:join(attemptDir,'goal.txt')},timeoutMs:5000};
  return{home,runDir,attemptDir,outputDir,calls,backend,req,controller};
}

it('keeps products and records a compatible receipt when an older journal rejects the new event',async()=>{
 const f=fixture({runtime:{status:'ok',sessionId:'session',endedAt:'2026-11-03T00:00:00Z'}});
 const descriptor=join(f.runDir,'journal.api.json');writeFileSync(descriptor,JSON.stringify({...JSON.parse(readFileSync(descriptor,'utf8')),executionMode:'pool'}));
 const journal=await import('../src/workflows/v3/journal.js'),append=journal.appendEvent;
 const spy=vi.spyOn(journal,'appendEvent').mockImplementation((path,event)=>{
  if(event.type==='nodeResourceSettled'){
   // 即使回执协议不兼容，已验证的远程产物已经落盘。
   expect(readFileSync(join(f.outputDir,'result.txt'),'utf8')).toBe('remote product');
   throw new PersistenceRequestError(400,'invalid_journal_event');
  }
  return append(path,event);
 });
 try{
  expect((await f.backend.runNode(f.req)).status).toBe('ok');
  expect(readJournal(join(f.runDir,'journal.ndjson')).find(e=>e.type==='nodeResourceAllocated')).toMatchObject({runtime:{status:'ok',sessionId:'session'}});
 }finally{spy.mockRestore();}
});

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

it.each(['abort','timeout'] as const)('%s switches an unacknowledged 409 submission to cancel and retains ownership until close',async(mode)=>{
  vi.useFakeTimers();
  const cancelPending=deferred(),closeProof=deferred();
  let cancels=0,allowClose=false,settled=false;
  const f=fixture({request:input=>{
    if(input.path.endsWith('/submit'))throw new PersistenceRequestError(409,'worker_not_ready');
    if(input.path.endsWith('/cancel')){
      cancels++;
      if(cancels===1)throw new PersistenceRequestError(409,'stop_pending');
      if(!allowClose){cancelPending.resolve();return {closed:false,state:'cancelling'};}
      closeProof.resolve();return {closed:true,result:{closed:true,status:'cancelled'}};
    }
    return {state:'reserved'};
  }});
  f.req.timeoutMs=5;
  const running=f.backend.runNode(f.req);
  void running.then(()=>{settled=true;},()=>{settled=true;});
  try{
    expect(f.calls.filter(call=>call.path.endsWith('/submit'))).toHaveLength(1);
    if(mode==='abort')f.controller.abort('operator');
    else await vi.advanceTimersByTimeAsync(f.req.timeoutMs);
    await vi.advanceTimersByTimeAsync(2);
    await cancelPending.promise;
    expect(settled).toBe(false);
    const cancelAt=f.calls.findIndex(call=>call.path.endsWith('/cancel'));
    expect(cancelAt).toBeGreaterThan(-1);
    expect(f.calls.slice(cancelAt).every(call=>call.path.endsWith('/cancel'))).toBe(true);
    // 超时前可以重试同一 durable intent；进入取消后不能重新 submit。
    const submissions=f.calls.filter(call=>call.path.endsWith('/submit'));
    if(mode==='abort')expect(submissions).toHaveLength(1);
    for(const submission of submissions)expect(submission.body).toEqual(submissions[0]!.body);
    allowClose=true;
    await vi.advanceTimersByTimeAsync(1);
    await closeProof.promise;
    await expect(running).resolves.toMatchObject({status:'cancelled'});
  }finally{
    allowClose=true;f.controller.abort('cleanup');
    await vi.advanceTimersByTimeAsync(2);
    await Promise.allSettled([running]);
  }
});

it.each(['beforeSubmit','afterSubmitAck'] as const)('peer blockage waits for %s and remote cancel close before publishing runBlocked',async(order)=>{
  const peerEntered=deferred(),releaseSubmit=deferred(),peerAborted=deferred(),cancelPending=deferred();
  let allowClose=false,cancels=0,settled=false;
  const ordering:{phase:string;attemptId:string;dispatched:boolean;blocked:boolean}[]=[];
  const f=fixture({skipAcquire:true,request:input=>{
    const events=readJournal(join(f.runDir,'journal.ndjson'));
    const body=input.body as {attemptId?:string;command?:{attemptId:string;node:{id:string}}}|undefined;
    const attemptId=body?.attemptId??body?.command?.attemptId??'goal#001/attempts/001';
    ordering.push({phase:input.path.endsWith('/prepare')?'prepare':input.path.endsWith('/submit')?'submit':input.path.endsWith('/cancel')?'cancel':'lease',attemptId,
      dispatched:events.some(event=>event.type==='nodeDispatched'&&event.attemptId===attemptId),
      blocked:events.some(event=>event.type==='runBlocked')});
    if(input.path.endsWith('/prepare'))return {state:'allocated'};
    if(input.path.endsWith('/submit')){
      if(body?.command?.node.id==='blocker')return {closed:true,result:{closed:true,status:'ok',manifest:{schemaVersion:1,status:'fail',summary:'controlled block',error:{code:'E_TEST',message:'blocked peer',retryable:true},files:[]},files:[]}};
      return {closed:false,state:'running',session:{sessionId:'peer-session',webPort:43210}};
    }
    if(input.path.endsWith('/cancel')){
      cancels++;
      if(cancels===1)throw new PersistenceRequestError(409,'stop_pending');
      if(!allowClose){cancelPending.resolve();return {closed:false,state:'cancelling'};}
      return {closed:true,result:{closed:true,status:'cancelled'}};
    }
    return {state:'reserved'};
  }});
  // 本场景只让 runtime 在 durable dispatch 后获取 lease，夹具不预先获取。
  writeFileSync(join(f.runDir,'journal.api.json'),JSON.stringify({baseUrl:'http://control:8787',token:'run-token',expiresAt:1e12,executionMode:'pool'}));
  const selection={poolId:'11111111-1111-1111-1111-111111111111',requirement:'test',candidateIds:[],reason:'fixture'};
  const dag=validateDag({runId:f.req.runId,nodes:[{id:'blocker',type:'goal',goal:'block',agentSelection:selection},{id:'goal',type:'goal',goal:'delay submit',agentSelection:selection}]});
  const journalPath=join(f.runDir,'journal.ndjson');
  const running=runWorkflow(dag,{
    ...f.backend,
    runNode:async req=>{
      if(req.node.id==='blocker'){await peerEntered.promise;return f.backend.runNode(req);}
      req.attemptLease!.signal.addEventListener('abort',()=>peerAborted.resolve(),{once:true});
      if(order==='beforeSubmit'){
        peerEntered.resolve();await releaseSubmit.promise;
        return f.backend.runNode(req);
      }
      return f.backend.runNode({...req,onSessionReady:async info=>{
        await req.onSessionReady?.(info);peerEntered.resolve();await releaseSubmit.promise;
      }});
    },
    resolveBotSnapshot:()=>f.req.botSnapshot,
    validateManifest:async path=>({ok:true,manifest:JSON.parse(readFileSync(path,'utf8'))}),
  },{baseDir:join(f.home,'.botmux','v3-runs'),globalConcurrency:4,perBotConcurrency:4,perCliConcurrency:4});
  void running.then(()=>{settled=true;},()=>{settled=true;});
  try{
    await peerEntered.promise;
    await vi.waitFor(()=>expect(readJournal(journalPath).some(event=>event.type==='nodeBlocked'&&event.nodeId==='blocker')).toBe(true));
    await peerAborted.promise;
    expect(openV3WorkerAttempts(readJournal(journalPath))).toEqual([expect.objectContaining({attemptId:'goal#001/attempts/001'})]);
    expect(readJournal(journalPath).some(event=>event.type==='runBlocked')).toBe(false);
    expect(settled).toBe(false);
    releaseSubmit.resolve();await cancelPending.promise;
    expect(settled).toBe(false);
    expect(openV3WorkerAttempts(readJournal(journalPath))).toHaveLength(1);
    expect(readJournal(journalPath).some(event=>event.type==='runBlocked')).toBe(false);
    allowClose=true;
    await expect(running).resolves.toMatchObject({reason:'terminal',runStatus:'blocked'});
    const events=readJournal(journalPath),terminalAt=events.findIndex(event=>event.type==='runBlocked');
    expect(events.filter(event=>event.type==='runBlocked')).toHaveLength(1);
    expect(events.slice(0,terminalAt)).toContainEqual(expect.objectContaining({type:'nodeAttemptDrained',nodeId:'goal',attemptId:'goal#001/attempts/001',reason:'terminalPeer'}));
    expect(openV3WorkerAttempts(events.slice(0,terminalAt))).toEqual([]);
    expect(openV3HostEffects(events.slice(0,terminalAt))).toEqual([]);
    for(const attemptId of ['blocker#001/attempts/001','goal#001/attempts/001']){
      const phases=ordering.filter(item=>item.attemptId===attemptId);
      expect(phases[0]).toMatchObject({phase:'prepare',dispatched:false});
      expect(phases[1]).toMatchObject({phase:'lease',dispatched:true});
      expect(phases.filter(item=>item.phase==='submit').every(item=>item.dispatched)).toBe(true);
    }
    const peerSubmits=f.calls.filter(call=>call.path.endsWith('/submit')&&(call.body as any).command.node.id==='goal');
    expect(peerSubmits).toHaveLength(order==='beforeSubmit'?0:1);
    expect(ordering.every(item=>!item.blocked)).toBe(true);
  }finally{
    allowClose=true;releaseSubmit.resolve();await Promise.allSettled([running]);
  }
});

it('rejects a remote artifact path that escapes the declared output directory',async()=>{
  const f=fixture({malicious:true});
  await expect(f.backend.runNode(f.req)).rejects.toThrow('invalid_remote_artifact');
});

it('stores remote task PTY output at the Control attempt path for authenticated replay',async()=>{
 const f=fixture({terminal:true});let captured:any;
 f.req.onSessionReady=info=>{captured=info;};
 expect((await f.backend.runNode(f.req)).status).toBe('ok');
 expect(captured.ptyLogPath).toBe(join(f.attemptDir,'pty.log'));
 expect(captured.token).toBeUndefined();
 expect(readFileSync(captured.ptyLogPath,'utf8')).toBe('\u001b[32mTASK OUTPUT\u001b[0m\n');
});

it('restored pooled descriptors retain resource admission and ignore the Control bot model',async()=>{
 const f=fixture();
 writeFileSync(join(f.runDir,'journal.api.json'),JSON.stringify({baseUrl:'http://control:8787',token:'run-token',expiresAt:1e12,executionMode:'pool'}));
 const selection={poolId:'11111111-1111-1111-1111-111111111111',requirement:'write',candidateIds:[],reason:'missing'};
 let ready=false;
 const backend=createRemoteExecutionBackend({home:f.home,runDir:f.runDir,pollMs:1,request:input=>{
  if(input.path.endsWith('/prepare'))return {state:ready?'allocated':'waiting',waitReason:'capability'};
  if(input.path.endsWith('/submit')){expect(Object.keys(input.body as any)).toEqual(['command']);return {closed:true,result:{status:'cancelled',closed:true}};}
  return {state:'reserved'};
 }});
 const admission={runId:f.req.runId,attemptId:f.req.attemptId,node:{...f.req.node,agentSelection:selection},botSnapshot:f.req.botSnapshot};
 expect(backend.prepareResource!(admission)).toMatchObject({ready:false,wait:{waitReason:'capability'}});
 ready=true;expect(backend.prepareResource!(admission)).toEqual({ready:true});
 expect(backend.resourceManaged!()).toBe(true);
 const lease=backend.attemptLeaseProvider.acquire({runId:f.req.runId,attemptId:f.req.attemptId,attemptDir:f.req.attemptDir});
 expect((await backend.runNode({...f.req,attemptLease:{...f.req.attemptLease!,hostToken:lease.hostToken}})).status).toBe('cancelled');
});

it('blocks missing input before dispatch and lets the existing terminal-drain path settle the run',async()=>{
 const f=fixture({skipAcquire:true,request:input=>input.path.endsWith('/prepare')?{preflightFailed:true,state:'closed',closed:true,lastError:'input missing'}:{state:'reserved'}});
 writeFileSync(join(f.runDir,'journal.api.json'),JSON.stringify({baseUrl:'http://control:8787',token:'run-token',expiresAt:1e12,executionMode:'pool'}));
 const selection={poolId:'11111111-1111-1111-1111-111111111111',requirement:'read',candidateIds:[],reason:'fixture'};
 const dag=validateDag({runId:f.req.runId,nodes:[{id:'goal',type:'goal',goal:'read input',agentSelection:selection}]});
 const runNode=vi.fn();const result=await runWorkflow(dag,{...f.backend,runNode,resolveBotSnapshot:()=>f.req.botSnapshot,validateManifest:async()=>({ok:false})},{baseDir:join(f.home,'.botmux','v3-runs')});
 expect(result).toMatchObject({runStatus:'blocked'});expect(runNode).not.toHaveBeenCalled();const events=readJournal(join(f.runDir,'journal.ndjson'));expect(events.some(e=>e.type==='nodeDispatched'||e.type==='nodeSessionReady')).toBe(false);expect(events.filter(e=>e.type==='runBlocked')).toHaveLength(1);
});
