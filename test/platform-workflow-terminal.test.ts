import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { configureJournalBackend } from '../src/workflows/v3/journal-backend.js';
import { randomUUID } from 'node:crypto';
import { symlinkSync, realpathSync } from 'node:fs';
import { createWorkflowTerminalProxy, liveWorkflowTerminal } from '../src/dashboard/workflow-terminal-proxy.js';
import {writeFileSync} from 'node:fs';
import { createPlatformJournalResolver } from '../src/platform/workflow/remote-journal.js';
import { indexConfirmedTerminalEvents } from '../src/workflows/v3/terminal-session-index.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { configureJournalBackend(undefined); for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'workflow-terminal-')), runId = 'terminal-test';
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, runId));
  const journal = join(base, runId, 'journal.ndjson');
  appendEvent(journal, { type: 'runStarted', runId });
  for (const id of ['analyze', 'write']) {
    appendEvent(journal, { type: 'nodeDispatched', nodeId: id, instanceId: id+'#001', attemptId: id+'/001' });
    appendEvent(journal, { type: 'nodeSessionReady', nodeId: id, instanceId: id+'#001', attemptId: id+'/001', sessionInfo: { sessionId: id+'-session', webPort: 43210, viewToken: id+'-read-token' } });
  }
  return { base, runId, journal };
}
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(0, '127.0.0.1', resolve); });
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
it('routes only the current running attempt, including materialized instance IDs', async () => {
  const f = fixture();
  expect(await liveWorkflowTerminal(f.base, f.runId, 'analyze#001')).toMatchObject({ sessionId: 'analyze-session' });
  expect(await liveWorkflowTerminal(f.base, f.runId, 'analyze')).toMatchObject({ sessionId: 'analyze-session' });
  appendEvent(f.journal, { type: 'nodeFailed', nodeId: 'analyze', instanceId: 'analyze#001', attemptId: 'analyze/001', errorClass: 'infra' });
  expect(await liveWorkflowTerminal(f.base, f.runId, 'analyze#001')).toBeUndefined();
  expect(await liveWorkflowTerminal(f.base, f.runId, 'write#001')).toMatchObject({ sessionId: 'write-session' });
  expect(await liveWorkflowTerminal(f.base, '../escape', 'write#001')).toBeUndefined();
});
it('proxies authenticated same-origin HTTP and WebSocket using only the task read capability', async () => {
  const f = fixture(), seen: Array<{ path: string; write?: unknown }> = [];
  const upstream = createServer((req, res) => { expect(req.headers.authorization).toBeUndefined(); expect(req.headers.cookie).toBeUndefined(); expect(req.headers['x-api-key']).toBeUndefined(); seen.push({ path: req.url!, write: req.headers['x-botmux-terminal-control'] }); res.end('LIVE TERMINAL'); });
  const ws = new WebSocketServer({ server: upstream });
  ws.on('connection', (client, req) => { expect(req.headers.authorization).toBeUndefined(); expect(req.headers.cookie).toBeUndefined(); seen.push({ path: req.url!, write: req.headers['x-botmux-terminal-control'] }); client.send('TASK OUTPUT'); });
  const worker = await listen(upstream);
  const resolve = vi.fn(async () => ({ url: worker, headers: { authorization: 'private-bridge-token', cookie: 'private-bridge-cookie', 'x-botmux-terminal-control': 'bridge-write-grant' } }));
  const proxy = createWorkflowTerminalProxy({ runsDir: () => f.base, authenticated: req => req.headers.cookie === 'test-auth=1', resolve });
  const front = createServer((req, res) => { void proxy.http(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  front.on('upgrade', (req, socket, head) => { void proxy.upgrade(req, socket, head); });
  const origin = await listen(front), path = `/api/v3/runs/${f.runId}/nodes/analyze/terminal/`;
  expect((await fetch(origin+path)).status).toBe(403); expect(resolve).not.toHaveBeenCalled();
  expect((await fetch(origin+path, { headers: { cookie: 'test-auth=1', origin: 'http://untrusted.example' } })).status).toBe(403);
  const result = await fetch(origin+path+'?token=forged', { headers: { cookie: 'test-auth=1', authorization: 'forged-authorization', 'x-api-key': 'forged-api-key', 'x-botmux-terminal-control': 'forged-write-grant' } });
  expect(await result.text()).toBe('LIVE TERMINAL');
  const client = new WebSocket(origin.replace('http:', 'ws:')+path, { headers: { cookie: 'test-auth=1', origin } });
  cleanup.push(() => { client.terminate(); for (const c of ws.clients) c.terminate(); ws.close(); });
  expect(await new Promise<string>((resolve, reject) => { client.once('message', message => resolve(message.toString())); client.once('error', reject); })).toBe('TASK OUTPUT');
  expect(seen).toEqual([{ path: '/?viewToken=analyze-read-token', write: undefined }, { path: '/?viewToken=analyze-read-token', write: undefined }]);
});

it('routes progress-card /s capabilities to the task and replays only its own log after close',async()=>{
 const f=fixture(),sid='33333333-3333-4333-8333-333333333333',token='card-read-capability-for-fixture';
 appendEvent(f.journal,{type:'nodeSessionReady',nodeId:'analyze',instanceId:'analyze#001',attemptId:'analyze/001',sessionInfo:{sessionId:sid,webPort:43210,viewToken:token}});
 const upstream=createServer((req,res)=>{expect(req.url).toBe('/?viewToken='+token);res.end('CARD LIVE');});
 const worker=await listen(upstream),resolve=vi.fn(async()=>({url:worker}));
 const proxy=createWorkflowTerminalProxy({runsDir:()=>f.base,authenticated:()=>false,resolve});
 const front=createServer((req,res)=>{void proxy.legacyHttp(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
 const origin=await listen(front),url=origin+'/s/'+sid+'/?viewToken='+token;
 expect(await (await fetch(url)).text()).toBe('CARD LIVE');
 expect((await fetch(url.replace(token,'wrong'))).status).toBe(403);
 expect((await fetch(url+'&token=forged-write')).status).toBe(403);
 const dir=join(f.base,f.runId,'analyze/001');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'pty.log'),'ANALYZE REPLAY ONLY');
 appendEvent(f.journal,{type:'nodeSucceeded',nodeId:'analyze',instanceId:'analyze#001',attemptId:'analyze/001',manifestPath:join(dir,'manifest.json')});
 resolve.mockClear();expect((await fetch(url)).status).toBe(200);expect(await (await fetch(url)).text()).toContain('终端回放');expect(resolve).not.toHaveBeenCalled();
 expect(await (await fetch(origin+'/s/'+sid+'/pty-log?viewToken='+token)).text()).toBe('ANALYZE REPLAY ONLY');
 expect((await fetch(origin+'/s/'+sid+'/pty-log?viewToken=another-session')).status).toBe(403);
});

// Permanent regression for isolated-n1-n2-20261031/n2.ts. Rejected requests
// must perform ZERO journal/remote reads; the diagnostic's old counts were bugs.
it.each([1,8,32])('rejects legacy capability requests without reading any of %i run journals',async(size)=>{
  const base=mkdtempSync(join(tmpdir(),'n2-index-'));cleanup.push(()=>rmSync(base,{recursive:true,force:true}));
  const sessions:string[]=[];
  for(let i=0;i<size;i++){
    const runId='run-'+i,path=join(base,runId,'journal.ndjson');sessions.push(randomUUID());
    appendEvent(path,{type:'runStarted',runId});
    appendEvent(path,{type:'nodeDispatched',nodeId:'task',instanceId:'task#001',attemptId:'task/001'});
    appendEvent(path,{type:'nodeSessionReady',nodeId:'task',instanceId:'task#001',attemptId:'task/001',sessionInfo:{sessionId:sessions[i]!,webPort:43210,viewToken:'isolated-read-capability'}});
  }
  const reads:string[]=[];
  configureJournalBackend((path,operation)=>{if(operation==='read')reads.push(path);return undefined;});
  const resolve=vi.fn(async()=>{throw Error('must not dial');}),authenticated=vi.fn(()=>false);
  const proxy=createWorkflowTerminalProxy({runsDir:()=>base,authenticated,resolve});
  const sid=sessions[size-1]!;
  const cases=[
    {url:`/s/${sid}/`},
    {url:`/s/${sid}/?viewToken=wrong`},
    {url:`/s/${sid}/?viewToken=isolated-read-capability&viewToken=isolated-read-capability`},
    {url:`/s/${sid}/?viewToken=isolated-read-capability&token=forged`},
    {url:`/s/${sid}/?viewToken=isolated-read-capability&port=43210`},
    {url:`/s/${sid}/?viewToken=isolated-read-capability`,method:'POST'},
    {url:`/s/${sid}/?viewToken=isolated-read-capability`,origin:'http://untrusted.invalid'},
    {url:`/s/${sid}/?viewToken=isolated-read-capability`,origin:'ftp://isolated.local'},
  ];
  for(const upgrade of [false,true]){
    for(const value of cases){
      let status=0;const request={method:value.method??'GET',url:value.url,headers:{host:'isolated.local',...(value.origin?{origin:value.origin}:{})}} as any;
      const response={writeHead(code:number){status=code;},end(){}} as any;
      const socket={end(value:string){status=Number(value.match(/HTTP\/1\.1 (\d+)/)?.[1]);},destroy(){}} as any;
      expect(upgrade?await proxy.legacyUpgrade(request,socket,Buffer.alloc(0)):await proxy.legacyHttp(request,response)).toBe(true);
      expect(status).toBe(403);expect(reads).toEqual([]);
    }
    for(const unknown of [randomUUID(),'00000000-0000-4000-8000-000000000000','not-a-uuid']){
      const request={method:'GET',url:`/s/${unknown}/?viewToken=unknown`,headers:{host:'isolated.local'}} as any;
      const response={writeHead(){throw Error('ordinary session must pass through');},end(){throw Error('must pass through');}} as any;
      expect(upgrade?await proxy.legacyUpgrade(request,response,Buffer.alloc(0)):await proxy.legacyHttp(request,response)).toBe(false);
      expect(reads).toEqual([]);
    }
    const req={method:'GET',url:'/api/v3/runs/run-0/nodes/task/terminal/',headers:{host:'isolated.local'}} as any;
    const response={writeHead(){},end(){},destroy(){}} as any;
    expect(upgrade?await proxy.upgrade(req,response,Buffer.alloc(0)):await proxy.http(req,response)).toBe(true);
    expect(reads).toEqual([]);
  }
  expect(authenticated).toHaveBeenCalledTimes(2);expect(resolve).not.toHaveBeenCalled();
});

it('checks modern method, parameters and Origin before authority even for an authenticated viewer',async()=>{
  const f=fixture(),reads=vi.fn();configureJournalBackend((_path,operation)=>{if(operation==='read')reads();return undefined;});
  const resolve=vi.fn(async()=>{throw Error('must not dial');});
  const proxy=createWorkflowTerminalProxy({runsDir:()=>f.base,authenticated:()=>true,resolve});
  for(const upgrade of [false,true])for(const value of [{method:'POST'},{suffix:'?port=43210'},{origin:'https://foreign.invalid'}]){
    const request={method:value.method??'GET',url:`/api/v3/runs/${f.runId}/nodes/analyze/terminal/`+(value.suffix??''),headers:{host:'fixture',...(value.origin?{origin:value.origin}:{})}} as any;
    let status=0;const response={writeHead(code:number){status=code;},end(value?:string){if(value?.startsWith('HTTP/'))status=Number(value.match(/HTTP\/1\.1 (\d+)/)?.[1]);}} as any;
    expect(upgrade?await proxy.upgrade(request,response,Buffer.alloc(0)):await proxy.http(request,response)).toBe(true);expect(status).toBe(403);
  }
  expect(reads).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();
});

it('reads only the indexed run after a valid cap, never caches live through retry or loop, and caps its own replay',async()=>{
  const f=fixture(),sid=randomUUID(),token='historic-read';
  appendEvent(f.journal,{type:'nodeSessionReady',nodeId:'analyze',instanceId:'analyze#001',attemptId:'analyze/001',sessionInfo:{sessionId:sid,webPort:43210,viewToken:token}});
  const own=join(f.base,f.runId,'analyze/001');mkdirSync(own,{recursive:true});
  writeFileSync(join(own,'pty.log'),Buffer.concat([Buffer.from('DO NOT REPLAY THE PREFIX'),Buffer.alloc(4*1024*1024,65)]));
  const upstream=createServer((_req,res)=>res.end('LIVE'));const worker=await listen(upstream),resolve=vi.fn(async()=>({url:worker}));
  const proxy=createWorkflowTerminalProxy({runsDir:()=>f.base,authenticated:()=>true,resolve});
  const front=createServer((req,res)=>{void proxy.legacyHttp(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
  front.on('upgrade',(req,socket,head)=>{void proxy.legacyUpgrade(req,socket,head);});
  const origin=await listen(front),url=origin+`/s/${sid}/?viewToken=${token}`;
  const reads:string[]=[];configureJournalBackend((path,operation)=>{if(operation==='read')reads.push(path);return undefined;});
  expect(await(await fetch(url)).text()).toBe('LIVE');expect(reads).toEqual([realpathSync(f.journal)]);
  configureJournalBackend(undefined);
  appendEvent(f.journal,{type:'nodeFailed',nodeId:'analyze',instanceId:'analyze#001',attemptId:'analyze/001',errorClass:'infra'});
  appendEvent(f.journal,{type:'nodeRetryRequested',nodeId:'analyze',instanceId:'analyze#001',previousAttemptId:'analyze/001',nextAttemptId:'analyze/002',reason:'blockedRetry'});
  appendEvent(f.journal,{type:'nodeDispatched',nodeId:'analyze',instanceId:'analyze#001',attemptId:'analyze/002'});
  appendEvent(f.journal,{type:'nodeSessionReady',nodeId:'analyze',instanceId:'analyze#001',attemptId:'analyze/002',sessionInfo:{sessionId:randomUUID(),webPort:43211,viewToken:'retry-read'}});
  resolve.mockClear();expect(await(await fetch(url)).text()).toContain('终端回放');expect(resolve).not.toHaveBeenCalled();
  const replay=await fetch(origin+`/s/${sid}/pty-log?viewToken=${token}`);
  expect(replay.headers.get('x-botmux-truncated')).toBe('1');const bytes=new Uint8Array(await replay.arrayBuffer());expect(bytes.byteLength).toBe(4*1024*1024);expect(bytes[0]).toBe(65);expect(bytes.at(-1)).toBe(65);
  appendEvent(f.journal,{type:'nodeDispatched',nodeId:'analyze',instanceId:'analyze#002',attemptId:'analyze/003'});
  appendEvent(f.journal,{type:'nodeSessionReady',nodeId:'analyze',instanceId:'analyze#002',attemptId:'analyze/003',sessionInfo:{sessionId:randomUUID(),webPort:43212,viewToken:'loop-read'}});
  expect(await liveWorkflowTerminal(f.base,f.runId,'analyze#001')).toBeUndefined();
  expect(await liveWorkflowTerminal(f.base,f.runId,'analyze#002')).toMatchObject({viewToken:'loop-read'});
  const denied=new WebSocket(origin.replace('http:','ws:')+`/s/${sid}/?viewToken=${token}`);
  cleanup.push(()=>denied.terminate());
  expect(await new Promise<number>((done,reject)=>{denied.once('unexpected-response',(_req,res)=>{res.resume();done(res.statusCode!);});denied.once('error',reject);})).toBe(403);
  rmSync(join(own,'pty.log'));const outside=join(f.base,'outside.log');writeFileSync(outside,'PRIVATE OUTSIDE');symlinkSync(outside,join(own,'pty.log'));
  expect((await fetch(origin+`/s/${sid}/pty-log?viewToken=${token}`)).status).toBe(410);
});

it('serves other requests while a remote run authority read is still pending',async()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'terminal-async-')));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
  const root=join(home,'.botmux','v3-runs'),runId='remote-run',directory=join(root,runId),sid=randomUUID(),token='remote-read-capability';
  mkdirSync(directory,{recursive:true,mode:0o700});mkdirSync(join(home,'.botmux','platform'));
  writeFileSync(join(home,'.botmux','platform','workflow-storage.json'),JSON.stringify({baseUrl:'http://control.invalid',token:'registry',expiresAt:1e12}));
  writeFileSync(join(directory,'journal.api.json'),JSON.stringify({schema:'botmux-journal-api-v1',runId,registrationHash:'fixture',baseUrl:'http://control.invalid',token:'run-token',expiresAt:1e12}),{mode:0o600});
  const events=[{ts:1,type:'runStarted',runId},{ts:2,type:'nodeDispatched',nodeId:'task',instanceId:'task#001',attemptId:'task/001'},
    {ts:3,type:'nodeSessionReady',nodeId:'task',instanceId:'task#001',attemptId:'task/001',sessionInfo:{sessionId:sid,webPort:43210,viewToken:token}}];
  indexConfirmedTerminalEvents(join(directory,'journal.ndjson'),events as any);
  let release=()=>{};const gate=new Promise<void>(done=>{release=done;});
  const sync=vi.fn(()=>{throw Error('a Dashboard request must not use the blocking requester');});
  const requestAsync=vi.fn(async(input:any)=>{expect(input).toMatchObject({path:'/runs/'+runId,method:'GET',token:'run-token'});await gate;return {version:events.length,events};});
  configureJournalBackend(createPlatformJournalResolver({home,active:true,request:sync,requestAsync,now:()=>1000,readCacheMs:0}));
  const upstream=createServer((_req,res)=>res.end('REMOTE LIVE'));const worker=await listen(upstream);
  const proxy=createWorkflowTerminalProxy({runsDir:()=>root,authenticated:()=>false,resolve:async()=>({url:worker})});
  const front=createServer((req,res)=>{void proxy.legacyHttp(req,res).then(handled=>{if(!handled){res.writeHead(200);res.end('OTHER');}});});
  const origin=await listen(front);
  const terminal=fetch(origin+`/s/${sid}/?viewToken=${token}`).then(r=>r.text());
  await vi.waitFor(()=>expect(requestAsync).toHaveBeenCalledTimes(1));
  expect(await(await fetch(origin+'/other')).text()).toBe('OTHER');
  release();
  expect(await terminal).toBe('REMOTE LIVE');expect(sync).not.toHaveBeenCalled();
});
