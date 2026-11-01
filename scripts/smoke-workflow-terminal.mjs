/** Real browser + two HTTP/WebSocket proxy hops, with no model or live run. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {WebSocketServer} from 'ws';
import {launchSmokeBrowser} from './smoke-browser.mjs';

const requireFromBotmux=createRequire(import.meta.url);
async function source(path){
 const result=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false,external:['bun:sqlite','better-sqlite3']});
 return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const [{createWorkflowTerminalProxy},{buildNodeTerminalRender},{proxyHttp,proxyUpgrade}]=await Promise.all([
 source('src/dashboard/workflow-terminal-proxy.ts'),source('src/dashboard/web/v3-terminal.ts'),source('src/platform/transport/http-proxy.ts')]);
const {backfillLocalTerminalSessionIndex}=await source('src/workflows/v3/terminal-session-index.ts');
const {handleV3RunsApi}=await source('src/dashboard/v3-runs-api.ts');
const folder=await mkdtemp(join(tmpdir(),'workflow-terminal-browser-')),runId='terminal-browser',servers=[],sessionIds={analyze:'11111111-1111-4111-8111-111111111111',write:'22222222-2222-4222-8222-222222222222'};
let browser,ws;
async function listen(server){servers.push(server);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return 'http://127.0.0.1:'+server.address().port;}
try{
 await mkdir(join(folder,runId));
 await writeFile(join(folder,runId,'dag.json'),JSON.stringify({runId,nodes:['analyze','write'].map(id=>({id,type:'goal',goal:'长描述用于检验终端不会被挤压。'.repeat(220),depends:[],inputs:[]}))}));
 await build({entryPoints:['test/fixtures/workflow-replay-acceptance.tsx'],outfile:join(folder,'page.js'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',external:['/assets/*'],
   plugins:[{name:'dashboard-css-alias',setup(api){api.onResolve({filter:/^\.\/platform-management\.css$/},()=>({path:resolve('src/dashboard/web/platform/management.css')}));}}]});
 const events=[{type:'runStarted',runId}];
 for(const nodeId of ['analyze','write'])events.push(
  {type:'nodeDispatched',nodeId,instanceId:nodeId+'#001',attemptId:nodeId+'/001'},
  {type:'nodeSessionReady',nodeId,instanceId:nodeId+'#001',attemptId:nodeId+'/001',sessionInfo:{sessionId:sessionIds[nodeId],webPort:43210,viewToken:nodeId+'-fixture-read'}});
 await writeFile(join(folder,runId,'journal.ndjson'),events.map((e,i)=>JSON.stringify({...e,seq:i+1,ts:new Date().toISOString()})).join('\n')+'\n');
 await backfillLocalTerminalSessionIndex(folder);
 const seen=[];
 const terminal=createServer((req,res)=>{
  assert(new URL(req.url,'http://worker').searchParams.has('viewToken'));
  res.setHeader('content-type','text/html');
  res.end('<!doctype html><meta charset="utf-8"><pre id="output">connecting</pre><script>const base=location.pathname.replace(/\\/+$/, "");const ws=new WebSocket((location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+base+"/"+location.search);ws.onmessage=e=>document.getElementById("output").textContent=e.data;</script>');
 });
 ws=new WebSocketServer({server:terminal});
 ws.on('connection',(client,req)=>{
  const token=new URL(req.url,'http://worker').searchParams.get('viewToken');
  assert(['analyze-fixture-read','write-fixture-read'].includes(token));
  assert.equal(req.headers['x-botmux-terminal-control'],undefined);
  seen.push(token);client.send(token.startsWith('analyze')?'ANALYZE TASK OUTPUT':'WRITE TASK OUTPUT');
 });
 const terminalOrigin=await listen(terminal);
 // Simulate the Control Plane resource hop: authenticate the manager, then
 // forward only to the already-attested task endpoint.
 const bridge=createServer((req,res)=>{
  if(req.headers['x-api-key']!=='fixture-manager'){res.writeHead(403);res.end();return;}
  req.url='/?viewToken='+encodeURIComponent(req.url.includes('/write/')?'write-fixture-read':'analyze-fixture-read');
  proxyHttp(req,res,{url:terminalOrigin});
 });
 bridge.on('upgrade',(req,socket,head)=>{
  if(req.headers['x-api-key']!=='fixture-manager'){socket.destroy();return;}
  req.url='/?viewToken='+encodeURIComponent(req.url.includes('/write/')?'write-fixture-read':'analyze-fixture-read');
  proxyUpgrade(req,socket,head,{url:terminalOrigin});
 });
 const bridgeOrigin=await listen(bridge);
 const proxy=createWorkflowTerminalProxy({runsDir:()=>folder,authenticated:req=>req.headers.cookie==='fixture-auth=1',
  resolve:async(_run,session)=>({url:bridgeOrigin+'/internal/'+Object.keys(sessionIds).find(id=>sessionIds[id]===session.sessionId),headers:{'x-api-key':'fixture-manager'}})});
 const html=['analyze','write'].map(id=>buildNodeTerminalRender(runId,{id,status:'running',depends:[],hasPtyLog:false,hasManifest:false,webTerminal:{sessionId:id+'-session',webPort:43210,status:'live'}}).html).join('');
 assert(!html.includes(':43210'));assert(!html.includes('fixture-read'));
 const front=createServer((req,res)=>{
  if(req.url==='/api/v3/runs/'+runId+'/operations'){
    res.setHeader('content-type','application/json');res.end(JSON.stringify({runId,runStatus:'succeeded',nextAction:'workflow artifacts',reportDelivery:{status:'permission_pending'},jobs:[{jobId:'fixture-job',attemptId:'analyze#001/attempts/001',state:'closed',runtime:{displayName:'Pool analyst',agentType:'zcode',modelId:'fixture-model',slot:0,queueMs:120}}],authoringApprovals:[{type:'dagApproved',byKind:'user',actor:'fixture-user',messageId:'fixture-card'}],lineage:null}));return;
  }
  if(req.url==='/api/v3/runs/'+runId+'/artifacts'){
    res.setHeader('content-type','application/json');res.end(JSON.stringify({files:[{key:'fixture-artifact',nodeId:'write',path:'report.md',bytes:10,url:'/fixture/report.md'}]}));return;
  }
  if(req.url==='/detail'){res.setHeader('set-cookie','fixture-auth=1; Path=/; HttpOnly; SameSite=Lax');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/page.css"><style>html,body{margin:0;height:100%}main{margin:0!important;height:100vh!important;max-width:none!important;width:100%!important}</style><main id="root"></main><script type="module" src="/page.js"></script>');return;}
  if(['/page.js','/page.css'].includes(req.url)){void readFile(join(folder,req.url.slice(1))).then(body=>{res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(body);});return;}
  if(req.url==='/'){res.setHeader('set-cookie','fixture-auth=1; Path=/; HttpOnly; SameSite=Lax');res.end('<!doctype html><meta charset="utf-8">'+html+`<a id="card" target="_blank" href="/s/${sessionIds.analyze}/?viewToken=analyze-fixture-read">卡片终端</a>`);return;}
  // Same files scripts/build-dashboard.mjs copies into /assets for the replay iframe.
  const asset={'/assets/xterm.css':'@xterm/xterm/css/xterm.css','/assets/xterm.umd.js':'@xterm/xterm/lib/xterm.js','/assets/xterm-addon-fit.umd.js':'@xterm/addon-fit/lib/addon-fit.js'}[req.url];
  if(asset){void readFile(requireFromBotmux.resolve(asset)).then(body=>{res.setHeader('content-type',asset.endsWith('.css')?'text/css':'text/javascript');res.end(body);});return;}
  void proxy.legacyHttp(req,res).then(handled=>handled||proxy.http(req,res)).then(handled=>handled||handleV3RunsApi(req,res,new URL(req.url,'http://fixture'),{runsDir:folder,proxyToDaemon:async()=>{throw Error('Replay may not execute or mutate Workflow');}},req.headers.cookie==='fixture-auth=1')).then(handled=>{if(!handled){res.writeHead(404);res.end();}});
 });
 front.on('upgrade',(req,socket,head)=>{void proxy.legacyUpgrade(req,socket,head).then(handled=>handled||proxy.upgrade(req,socket,head));});
 const origin=await listen(front);
 browser=await launchSmokeBrowser();
 const page=await browser.newPage();await page.goto(origin);
 await page.frameLocator('iframe').nth(0).getByText('ANALYZE TASK OUTPUT',{exact:true}).waitFor();
 await page.frameLocator('iframe').nth(1).getByText('WRITE TASK OUTPUT',{exact:true}).waitFor();
 const popupEvent=page.waitForEvent('popup');await page.getByRole('link',{name:'新窗口打开'}).first().click();
 const popup=await popupEvent;await popup.getByText('ANALYZE TASK OUTPUT',{exact:true}).waitFor();
 assert.equal(new URL(popup.url()).origin,origin);assert(!popup.url().includes('viewToken'));
 const cardPopupEvent=page.waitForEvent('popup');await page.locator('#card').click();const cardPopup=await cardPopupEvent;await cardPopup.getByText('ANALYZE TASK OUTPUT',{exact:true}).waitFor();
 await mkdir(join(folder,runId,'analyze/001'),{recursive:true});await writeFile(join(folder,runId,'analyze/001/pty.log'),'ARCHIVED ANALYZE TASK OUTPUT\r\n\u001b[31mCOLORED OUTPUT\u001b[0m\r\nobsolete\u001b[2K\rREPLACED OUTPUT');
 events.push({type:'nodeSucceeded',nodeId:'analyze',instanceId:'analyze#001',attemptId:'analyze/001',manifestPath:join(folder,runId,'analyze/001/manifest.json')});
 await writeFile(join(folder,runId,'journal.ndjson'),events.map((e,i)=>JSON.stringify({...e,seq:i+1,ts:new Date().toISOString()})).join('\n')+'\n');
 await backfillLocalTerminalSessionIndex(folder);
 const reader=await browser.newContext();await reader.route('https://cdn.jsdelivr.net/**',route=>route.abort());const replay=await reader.newPage();
 await replay.goto(origin+'/s/'+sessionIds.analyze+'/?viewToken=analyze-fixture-read');
 // With the CDN blocked the replay must still render through xterm (same-origin assets), not the plain-text fallback.
 await replay.locator('.xterm-rows').getByText('ARCHIVED ANALYZE TASK OUTPUT').waitFor();
 assert.equal(await replay.evaluate(()=>typeof window.Terminal),'function');
 assert.equal((await reader.request.get(origin+'/s/'+sessionIds.analyze+'/pty-log?viewToken=wrong')).status(),403);
 // Full production Workflow component and stylesheet, completed state and a
 // deliberately oversized goal. No copied layout or terminal component.
 await mkdir(join(folder,runId,'write/001'),{recursive:true});await writeFile(join(folder,runId,'write/001/pty.log'),'WRITER ARCHIVE');
 events.push({type:'nodeSucceeded',nodeId:'write',instanceId:'write#001',attemptId:'write/001',manifestPath:join(folder,runId,'write/001/manifest.json')},{type:'runSucceeded'});
 for(const event of events)if(event.type==='nodeSessionReady')event.ptyLogPath=join(folder,runId,event.attemptId,'pty.log');
 await writeFile(join(folder,runId,'journal.ndjson'),events.map((e,i)=>JSON.stringify({...e,seq:i+1,ts:new Date().toISOString()})).join('\n')+'\n');
 const detail=await browser.newPage();await detail.goto(origin+'/detail#/workflows/'+runId);
 await detail.getByText('执行与交付记录',{exact:true}).waitFor();await detail.getByText('计算：succeeded · 文档交付：permission_pending',{exact:true}).waitFor();await detail.getByText('Pool analyst · zcode · fixture-model',{exact:true}).waitFor();await detail.getByRole('link',{name:'write · report.md',exact:true}).waitFor();
 await detail.locator('.v3r-node[data-node="analyze"]').click();
 await detail.frameLocator('iframe[title="v3 terminal replay"]').locator('.xterm-rows').getByText('ARCHIVED ANALYZE TASK OUTPUT').waitFor();
 for(const viewport of [{width:1440,height:900},{width:1440,height:720},{width:390,height:844}]){
  await detail.setViewportSize(viewport);await detail.locator('.v3r-terminal-actions').scrollIntoViewIfNeeded();
  const action=detail.locator('.v3r-terminal-actions').getByRole('link',{name:'打开终端回放'});
  await action.waitFor({state:'visible'});const frame=await detail.locator('iframe[title="v3 terminal replay"]').boundingBox();assert(frame.height>=180,'long goal squeezed replay height');
  const panel=await detail.locator('#v3-node-panel').boundingBox();assert(frame.y+frame.height<=panel.y+panel.height+1,'terminal frame extends outside its clipped panel');
 }
 const standaloneEvent=detail.waitForEvent('popup');await detail.locator('.v3r-terminal-actions').getByRole('link',{name:'打开终端回放'}).click();const standalone=await standaloneEvent;
 await standalone.locator('.xterm-rows').getByText('REPLACED OUTPUT').waitFor();
 const rows=await standalone.locator('.xterm-rows').innerText();assert(!rows.includes('obsolete'));assert(!rows.includes('[31m'));
 const colored=standalone.locator('.xterm-rows').getByText('COLORED OUTPUT');assert.notEqual(await colored.evaluate(el=>getComputedStyle(el).color),'rgb(201, 209, 217)');
 assert(standalone.url().endsWith('/nodes/analyze/terminal-replay'));assert(!standalone.url().includes('viewToken'));
 const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(standalone.url())).status(),401);
 // Actual full-screen protocol: no newlines and an unclosed alternate screen,
 // exactly the condition where native xterm scrollback cannot exist.
 let fullscreen='\u001b[?1049h';
 for(let i=1;i<=80;i++)fullscreen+='\u001b[?2026h\u001b[H\u001b[2K\u001b[32mHISTORY SCREEN '+String(i).padStart(3,'0')+'\u001b[0m\u001b[2;1H\u001b[2Kscreen body '+i+'\u001b[?2026l';
 await writeFile(join(folder,runId,'analyze/001/pty.log'),fullscreen);
 await standalone.reload();await standalone.getByRole('slider',{name:'历史屏幕位置'}).waitFor();
 await standalone.locator('.xterm-rows').getByText('HISTORY SCREEN 080').waitFor();
 await standalone.locator('#term').hover();await standalone.mouse.wheel(0,-120);
 await standalone.locator('.xterm-rows').getByText('HISTORY SCREEN 077').waitFor();
 await standalone.mouse.wheel(0,80);await standalone.locator('.xterm-rows').getByText('HISTORY SCREEN 079').waitFor();
 await standalone.getByRole('button',{name:'最早',exact:true}).click();await standalone.locator('.xterm-rows').getByText('HISTORY SCREEN 001').waitFor();
 await standalone.getByRole('button',{name:'下一屏',exact:true}).click();await standalone.locator('.xterm-rows').getByText('HISTORY SCREEN 002').waitFor();
 await standalone.getByRole('button',{name:'最新',exact:true}).click();await standalone.locator('.xterm-rows').getByText('HISTORY SCREEN 080').waitFor();
 await standalone.locator('#term').focus();await standalone.keyboard.press('ArrowUp');await standalone.locator('.xterm-rows').getByText('HISTORY SCREEN 079').waitFor();
 await standalone.locator('#term').evaluate(el=>{
   const start=new Event('touchstart',{bubbles:true});Object.defineProperty(start,'touches',{value:[{clientY:100}]});el.dispatchEvent(start);
   const move=new Event('touchmove',{bubbles:true,cancelable:true});Object.defineProperty(move,'touches',{value:[{clientY:140}]});el.dispatchEvent(move);
 });
 await standalone.locator('.xterm-rows').getByText('HISTORY SCREEN 077').waitFor();
 // Ordinary terminal transcripts keep native vertical scrollback, including
 // wheel gestures, instead of getting forced into full-screen navigation.
 await writeFile(join(folder,runId,'write/001/pty.log'),Array.from({length:300},(_,i)=>'ORDINARY LINE '+i+'\r\n').join(''));
 await standalone.addInitScript(()=>{
   let Wrapper;
   Object.defineProperty(window,'Terminal',{configurable:true,get:()=>Wrapper,set:Original=>{Wrapper=class extends Original{constructor(...args){super(...args);window.replaySmokeTerminal=this;}};}});
 });
 await standalone.goto(origin+`/api/v3/runs/${runId}/nodes/write/terminal-replay`);await standalone.locator('.xterm-rows').getByText('ORDINARY LINE 299').waitFor();
 assert.equal(await standalone.locator('#history').isVisible(),false);
 const position=await standalone.evaluate(()=>window.replaySmokeTerminal.buffer.active.viewportY);assert(position>0);
 await standalone.locator('#term').hover();await standalone.mouse.wheel(0,-600);await standalone.waitForFunction(old=>window.replaySmokeTerminal.buffer.active.viewportY<old,position);
 const artifacts=process.env.BOTMUX_SMOKE_ARTIFACT_DIR||fileURLToPath(new URL('../../.local/all-fixes/workflow-terminal/',import.meta.url));
 await mkdir(artifacts,{recursive:true});
 await page.screenshot({path:join(artifacts,'live-terminals.png')});
 assert(seen.includes('analyze-fixture-read')&&seen.includes('write-fixture-read'));
 console.log('Workflow terminal browser smoke passed: operations member/queue/delivery panel and artifact links;  live HTTP/WS, completed replay, ANSI rendering, wheel/touch/keyboard full-screen history, native transcript scrolling and desktop/mobile layout.');
}finally{
 await browser?.close();for(const client of ws?.clients??[])client.terminate();ws?.close();
 for(const server of servers.reverse())await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
 await rm(folder,{recursive:true,force:true});
}
