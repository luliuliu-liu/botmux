import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalControlAgent} from '../src/platform/management/local-control-agent.js';
import {readContainerAgentEnvironment,readContainerAgentModel,writeContainerAgentEnvironment} from '../src/platform/management/container-agent-files.mjs';
import {writeNativeAgentModel} from '../src/platform/management/native-worker-config.js';
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(createOAuth?:(options:any)=>any){
 const home=mkdtempSync(join(tmpdir(),'local-control-'));roots.push(home);mkdirSync(join(home,'.botmux'));
 const path=join(home,'.botmux','bots.json');writeFileSync(path,JSON.stringify([{larkAppId:'pi-bot',cliId:'pi',larkAppSecret:'private-bot',allowedUsers:['owner'],env:{PROJECT_MODE:'keep',PI_MODEL_API_KEY:'old'}},{larkAppId:'codex-bot',cliId:'codex',larkAppSecret:'other'}]));
 const state={busy:false,failStop:false,failAck:false,failStart:false,networkFailure:false,throwStop:false,rebuildState:{revision:0,status:null} as any,upgradeNoop:false,loseUpgradeResponse:false,calls:[] as string[],prepared:0,rows:[] as any[],model:null as any};
 const agent=createLocalControlAgent({botsJsonPath:path,createOAuth,busy:async()=>state.busy,isStopped:async()=>true,
  stop:async id=>{state.calls.push('stop:'+id);if(state.throwStop&&id==='codex-bot')throw Error('stop unavailable');return {ok:!(state.failStop&&id==='codex-bot')};},start:async id=>{state.calls.push('start:'+id);return {ok:!state.failStart};},
  changeCli:async id=>{state.calls.push('cli:'+id);return {status:200,data:{ok:true}};},
  request:async(p,m,body:any)=>{
   if(p==='/control-workspace'&&!m)return {status:200,data:state.rebuildState};
   if(p==='/control-workspace'&&m==='POST'&&state.networkFailure)throw Error('network lost');
   if(p==='/control-upgrade'&&!m)return {status:200,data:state.rebuildState};
   if(p==='/control-upgrade'&&m==='POST'&&state.loseUpgradeResponse){state.loseUpgradeResponse=false;throw Error('network lost');}
   if(p==='/control-upgrade'&&m==='POST')return state.upgradeNoop?{status:200,data:{queued:false,noop:true}}:{status:202,data:{queued:true}};
   if(m==='POST'&&p.endsWith('/ack')){state.calls.push('ack');return state.failAck?{status:503,data:{}}:{status:200,data:{applied:true}};}
   if(m==='POST'){state.prepared++;return {status:200,data:{revision:1,requestId:body.requestId,modelProfileId:'team',model:state.model??{provider:'team',baseUrl:'https://model.example/v1',modelId:'chosen',modelIds:['chosen'],protocol:'openai-completions',authMethod:'api-key',apiKey:'private-model'}}};}
   return {status:200,data:{agents:state.rows}};
  }});
 return {home,path,state,agent,input:{revision:0,requestId:'00000000-0000-4000-8000-000000000001',modelProfileId:'team',modelId:'chosen',authMethod:'api-key',confirmRestart:true}};
}
describe('local Control Agent management',()=>{
 it('reports managed API keys from each CLI environment without exposing secrets',async()=>{
  const f=fixture();
  const examples={pi:{PI_MODEL_API_KEY:'pi-private'},codex:{PLATFORM_MODEL_API_KEY:'codex-private'},'claude-code':{ANTHROPIC_AUTH_TOKEN:'claude-private'},zcode:{ZCODE_CODING_PLAN_API_KEY:'zcode-private'}};
  for(const [type,env] of Object.entries(examples))writeContainerAgentEnvironment(f.home,type,env);
  f.state.rows=Object.keys(examples).map(agent_type=>({agent_type,revision:1,applied_revision:1,auth_method:'api-key'}));
  const result=await f.agent.status();
  for(const agent of result.agents)expect(agent).toMatchObject({credentialKind:'api-key',credentialPresent:true,requiresLogin:false});
  expect(JSON.stringify(result)).not.toMatch(/pi-private|codex-private|claude-private|zcode-private/);
 });
 it('distinguishes Claude API keys from preserved OAuth and Vercel subscription credentials',async()=>{
  const f=fixture(),row={agent_type:'claude-code',revision:1,applied_revision:1,auth_method:'api-key',model_protocol:'anthropic-messages'};
  f.state.rows=[row];mkdirSync(join(f.home,'.claude'));writeFileSync(join(f.home,'.claude','.credentials.json'),'oauth-fixture');
  const status=async()=> (await f.agent.status()).agents.find(a=>a.agentType==='claude-code');
  expect(await status()).toMatchObject({credentialKind:'api-key',credentialPresent:false});
  writeContainerAgentEnvironment(f.home,'claude-code',{ANTHROPIC_AUTH_TOKEN:'api-fixture'});
  expect(await status()).toMatchObject({credentialKind:'api-key',credentialPresent:true});
  writeContainerAgentEnvironment(f.home,'claude-code',{ANTHROPIC_API_KEY:'legacy-fixture'});
  expect(await status()).toMatchObject({credentialKind:'api-key',credentialPresent:true});
  row.auth_method='oauth';expect(await status()).toMatchObject({credentialKind:'oauth',credentialPresent:true,requiresLogin:true});
  rmSync(join(f.home,'.claude','.credentials.json'));
  expect(await status()).toMatchObject({credentialKind:'oauth',credentialPresent:false});
  row.auth_method='api-key';row.model_protocol='vercel-claude';
  writeContainerAgentEnvironment(f.home,'claude-code',{ANTHROPIC_CUSTOM_HEADERS:'x-ai-gateway-api-key: Bearer vercel-fixture'});
  expect(await status()).toMatchObject({credentialKind:'oauth',credentialPresent:false,requiresLogin:true});
  writeFileSync(join(f.home,'.claude','.credentials.json'),'oauth-fixture');
  expect(await status()).toMatchObject({credentialKind:'oauth',credentialPresent:true,requiresLogin:true});
  expect(JSON.stringify(await f.agent.status())).not.toMatch(/api-fixture|legacy-fixture|oauth-fixture|vercel-fixture/);
 });
 it('does not lock model selection when confirmed DB state needs restoring into a fresh container',async()=>{
  const f=fixture();f.state.rows=[{agent_type:'claude-code',revision:3,applied_revision:3,auth_method:'oauth'}];
  expect((await f.agent.status()).agents.find(a=>a.agentType==='claude-code')?.status).toBe('restore');
  f.state.rows[0].applied_revision=2;
  expect((await f.agent.status()).agents.find(a=>a.agentType==='claude-code')?.status).toBe('pending');
 });
 it('keeps the pending OAuth selection instead of falling back to the previously applied API-key model',async()=>{
  const f=fixture();mkdirSync(join(f.home,'.botmux','platform'),{recursive:true});
  writeFileSync(join(f.home,'.botmux','platform','local-agent-codex.json'),JSON.stringify({revision:19,authMethod:'api-key',modelProfileId:'old-profile',modelId:'old-model'}));
  f.state.rows=[{agent_type:'codex',revision:20,applied_revision:19,request_id:'00000000-0000-4000-8000-000000000001',auth_method:'oauth',model_profile_id:null,selected_model_id:null}];
  expect((await f.agent.status()).agents.find(a=>a.agentType==='codex')).toMatchObject({status:'pending',authMethod:'oauth',modelProfileId:null,modelId:''});
 });
 it('writes global native model, preserves IM identities, restarts only affected CLI and acknowledges last',async()=>{
  const f=fixture();expect(await f.agent.apply('pi',f.input)).toMatchObject({applied:true,revision:1,restartedBots:1});
  expect(f.state.calls).toEqual(['stop:pi-bot','start:pi-bot','ack']);
  expect(readContainerAgentModel(f.home,'pi')).toBe('team/chosen');expect(readContainerAgentEnvironment(f.home,'pi')?.PI_MODEL_API_KEY).toBe('private-model');
  const bots=JSON.parse(readFileSync(f.path,'utf8'));expect(bots[0]).toMatchObject({larkAppSecret:'private-bot',allowedUsers:['owner'],env:{PROJECT_MODE:'keep'}});expect(bots[1].larkAppSecret).toBe('other');
  expect(readFileSync(join(f.home,'.botmux','platform','local-agent-pi.json'),'utf8')).not.toContain('private-model');
  expect(JSON.stringify(await f.agent.status())).not.toContain('private-model');
 });
 it('fails before preparing or stopping when busy or not explicitly confirmed',async()=>{
  const f=fixture();await expect(f.agent.apply('pi',{...f.input,confirmRestart:false})).rejects.toThrow('确认');
  f.state.busy=true;await expect(f.agent.apply('pi',f.input)).rejects.toThrow('任务');expect(f.state.prepared).toBe(0);expect(f.state.calls).toEqual([]);
 });
 it('does not release database references before native restart and ack confirmation',async()=>{
  const f=fixture();f.state.failStart=true;await expect(f.agent.apply('pi',f.input)).rejects.toThrow('恢复');expect(f.state.calls).not.toContain('ack');
  f.state.failStart=false;f.state.failAck=true;await expect(f.agent.apply('pi',f.input)).rejects.toThrow('管理端确认');
  f.state.failAck=false;await expect(f.agent.apply('pi',f.input)).resolves.toMatchObject({applied:true});
 });
 it('retries Codex OAuth after its native client added a table inside the managed provider block',async()=>{
  const f=fixture();const api={provider:'team',baseUrl:'https://model.example/v1',modelId:'chosen',modelIds:['chosen'],protocol:'openai-responses',authMethod:'api-key',apiKey:'fixture'};
  await writeNativeAgentModel(f.home,{generation:'local-control',revision:1,agentType:'codex',model:api,binding:null});
  const file=join(f.home,'.codex','config.toml');writeFileSync(file,readFileSync(file,'utf8').replace('# botmux-platform-provider:end','\n[tui]\nscreen_reader_detection_done = true\n# botmux-platform-provider:end'));
  f.state.model={provider:'openai',baseUrl:'https://api.openai.com/v1',modelId:'',modelIds:[],protocol:'openai-responses',authMethod:'oauth',apiKey:''};
  expect(await f.agent.apply('codex',{...f.input,authMethod:'oauth',modelProfileId:null,modelId:null})).toMatchObject({applied:true});
  expect(readFileSync(file,'utf8')).toContain('[tui]');expect(readContainerAgentModel(f.home,'codex')).toBeNull();
 });
 it('switches Claude subscription to a normal Anthropic API key without deleting OAuth credentials',async()=>{
  const f=fixture();mkdirSync(join(f.home,'.claude'));writeFileSync(join(f.home,'.claude','.credentials.json'),'fixture-oauth');
  f.state.model={provider:'team',baseUrl:'https://model.example/v1',modelId:'chosen',modelIds:['chosen'],protocol:'anthropic-messages',authMethod:'api-key',apiKey:'fixture-key'};
  expect(await f.agent.apply('claude-code',f.input)).toMatchObject({applied:true});
  expect(readContainerAgentEnvironment(f.home,'claude-code')).toMatchObject({ANTHROPIC_AUTH_TOKEN:'fixture-key',ANTHROPIC_MODEL:'chosen'});
  expect(readFileSync(join(f.home,'.claude','.credentials.json'),'utf8')).toBe('fixture-oauth');
 });
 it.each(['claude-code','zcode'])('starts and forwards local-browser OAuth for %s without a workbench',async type=>{
  const actions:any[]=[];
  const f=fixture(()=>({restore:async()=>{},busy:()=>false,request:async(action:string,input:any)=>{actions.push({action,input});return {oauth:{state:'waiting',authorizationUrl:'https://example.invalid/authorize',callbackPort:3456}};}}));
  mkdirSync(join(f.home,'.botmux','platform'),{recursive:true});
  writeFileSync(join(f.home,'.botmux','platform',`local-agent-${type}.json`),JSON.stringify({revision:2,authMethod:'oauth'}));
  if(type==='claude-code')writeContainerAgentEnvironment(f.home,type,{ANTHROPIC_CUSTOM_HEADERS:'x-ai-gateway-api-key: Bearer fixture'});
  expect((await f.agent.login(type,{action:'start',browserMode:'local'})).oauth.authorizationUrl).toBeTruthy();
  await f.agent.login(type,{action:'callback',callback:'http://localhost:3456/callback?code=fixture'});
  expect(actions.map(x=>x.action)).toEqual(['start','callback']);expect(actions[1].input.callback).toContain('localhost:3456');
  expect(f.state.prepared).toBe(0);
 });
 it('restricts local CLI selection and rejects switching a working Bot',async()=>{
  const f=fixture();await expect(f.agent.changeCli('pi-bot',{cliId:'dsh',confirmRestart:true})).rejects.toThrow('本地镜像');
  f.state.busy=true;await expect(f.agent.changeCli('pi-bot',{cliId:'codex',confirmRestart:true})).rejects.toThrow('任务');
  f.state.busy=false;expect(await f.agent.changeCli('pi-bot',{cliId:'codex',confirmRestart:true})).toEqual({changed:true});
 });
});
describe('Control workspace admission',()=>{
 it('refuses changes while a local Bot is busy and resumes stopped Bots if the platform rejects',async()=>{
  const f=fixture();f.state.busy=true;
  await expect(f.agent.workspace({confirmRestart:true})).rejects.toThrow('正忙');expect(f.state.calls).toEqual([]);
  f.state.busy=false;await expect(f.agent.workspace({confirmRestart:true})).rejects.toThrow('挂载请求未确认');
  expect(f.state.calls).toEqual(['stop:pi-bot','stop:codex-bot','start:pi-bot','start:codex-bot']);
 });
});

it('MCP configuration rejects active work, compensates a partial stop and restarts all idle Bots after apply failure',async()=>{
 const f=fixture();f.state.busy=true;let writes=0;
 await expect(f.agent.configureMcp(async()=>{writes++;})).rejects.toThrow('任务');expect(f.state.calls).toEqual([]);
 f.state.busy=false;f.state.failStop=true;await expect(f.agent.configureMcp(async()=>{writes++;})).rejects.toThrow('停止');expect(writes).toBe(0);expect(f.state.calls).toEqual(['stop:pi-bot','stop:codex-bot','start:pi-bot']);
 f.state.failStop=false;f.state.calls=[];await expect(f.agent.configureMcp(async()=>{throw Error('native conflict');})).rejects.toThrow('native conflict');expect(f.state.calls).toEqual(['stop:pi-bot','stop:codex-bot','start:pi-bot','start:codex-bot']);
});

it.each([false,true])('restores only confirmed stopped Bots on partial stop failure (throw=%s)',async throwing=>{
 const f=fixture();f.state.failStop=true;f.state.throwStop=throwing;
 await expect(f.agent.workspace({...f.input})).rejects.toThrow();
 expect(f.state.calls).toEqual(['stop:pi-bot','stop:codex-bot','start:pi-bot']);expect(f.state.prepared).toBe(0);
});
it('recovers a lost rebuild response from durable state and compensates a confirmed rejection',async()=>{
 const f=fixture();f.state.networkFailure=true;
 await expect(f.agent.workspace(f.input)).rejects.toThrow('未受理');expect(f.state.calls.slice(-2)).toEqual(['start:pi-bot','start:codex-bot']);
 f.state.calls=[];f.state.rebuildState={revision:1,status:'queued'};
 expect(await f.agent.workspace(f.input)).toMatchObject({queued:true,recovered:true});expect(f.state.calls).toEqual(['stop:pi-bot','stop:codex-bot']);
});
it('surfaces failed compensation instead of silently leaving Bots stopped',async()=>{
 const f=fixture();f.state.failStop=true;f.state.failStart=true;
 await expect(f.agent.workspace(f.input)).rejects.toThrow('恢复未确认');expect(f.state.calls).toContain('start:pi-bot');
});
it('does not confuse historical applied state with a new rebuild after losing a noop response',async()=>{
 const f=fixture();f.state.loseUpgradeResponse=true;f.state.upgradeNoop=true;
 f.state.rebuildState={status:'applied',currentImage:'sha256:same'};
 expect(await f.agent.upgrade({image:'sha256:same',confirmRestart:true})).toMatchObject({noop:true,recovered:true});
 expect(f.state.calls).toEqual(['stop:pi-bot','stop:codex-bot','start:pi-bot','start:codex-bot']);
});
it('resumes Bots when Control already runs the requested image, and keeps them stopped for a real rebuild',async()=>{
 const f=fixture();f.state.upgradeNoop=true;
 expect(await f.agent.upgrade({image:'sha256:same',confirmRestart:true})).toMatchObject({noop:true});
 expect(f.state.calls).toEqual(['stop:pi-bot','stop:codex-bot','start:pi-bot','start:codex-bot']);
 f.state.calls=[];f.state.upgradeNoop=false;
 expect(await f.agent.upgrade({image:'sha256:new',confirmRestart:true})).toMatchObject({queued:true});
 expect(f.state.calls).toEqual(['stop:pi-bot','stop:codex-bot']);
});
