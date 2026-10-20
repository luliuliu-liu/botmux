import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalControlAgent} from '../src/platform/management/local-control-agent.js';
import {readContainerAgentEnvironment,readContainerAgentModel} from '../src/platform/management/container-agent-files.mjs';
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'local-control-'));roots.push(home);mkdirSync(join(home,'.botmux'));
 const path=join(home,'.botmux','bots.json');writeFileSync(path,JSON.stringify([{larkAppId:'pi-bot',cliId:'pi',larkAppSecret:'private-bot',allowedUsers:['owner'],env:{PROJECT_MODE:'keep',PI_MODEL_API_KEY:'old'}},{larkAppId:'codex-bot',cliId:'codex',larkAppSecret:'other'}]));
 const state={busy:false,failAck:false,failStart:false,calls:[] as string[],prepared:0};
 const agent=createLocalControlAgent({botsJsonPath:path,busy:async()=>state.busy,isStopped:async()=>true,
  stop:async id=>{state.calls.push('stop:'+id);return {ok:true};},start:async id=>{state.calls.push('start:'+id);return {ok:!state.failStart};},
  changeCli:async id=>{state.calls.push('cli:'+id);return {status:200,data:{ok:true}};},
  request:async(p,m,body:any)=>{
   if(m==='POST'&&p.endsWith('/ack')){state.calls.push('ack');return state.failAck?{status:503,data:{}}:{status:200,data:{applied:true}};}
   if(m==='POST'){state.prepared++;return {status:200,data:{revision:1,requestId:body.requestId,modelProfileId:'team',model:{provider:'team',baseUrl:'https://model.example/v1',modelId:'chosen',modelIds:['chosen'],protocol:'openai-completions',authMethod:'api-key',apiKey:'private-model'}}};}
   return {status:200,data:{agents:[]}};
  }});
 return {home,path,state,agent,input:{revision:0,requestId:'00000000-0000-4000-8000-000000000001',modelProfileId:'team',modelId:'chosen',authMethod:'api-key',confirmRestart:true}};
}
describe('local Control Agent management',()=>{
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
  const f=fixture();f.state.failStart=true;await expect(f.agent.apply('pi',f.input)).rejects.toThrow('重启');expect(f.state.calls).not.toContain('ack');
  f.state.failStart=false;f.state.failAck=true;await expect(f.agent.apply('pi',f.input)).rejects.toThrow('管理端确认');
  f.state.failAck=false;await expect(f.agent.apply('pi',f.input)).resolves.toMatchObject({applied:true});
 });
 it('restricts local CLI selection and rejects switching a working Bot',async()=>{
  const f=fixture();await expect(f.agent.changeCli('pi-bot',{cliId:'dsh',confirmRestart:true})).rejects.toThrow('本地镜像');
  f.state.busy=true;await expect(f.agent.changeCli('pi-bot',{cliId:'codex',confirmRestart:true})).rejects.toThrow('任务');
  f.state.busy=false;expect(await f.agent.changeCli('pi-bot',{cliId:'codex',confirmRestart:true})).toEqual({changed:true});
 });
});
