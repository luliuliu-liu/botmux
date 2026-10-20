import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {containerGlobalAgentMode,containerAgentGlobalConfiguration,splitContainerAgentEnvironment} from '../src/platform/management/container-agent-policy.js';
import {writeContainerAgentConfiguration,writeContainerAgentEnvironment} from '../src/platform/management/container-agent-files.mjs';
it('selects global authentication only for immutable Control/Worker images, never host installations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'container-policy-')),role=join(dir,'role');
 try{
  expect(containerGlobalAgentMode(role)).toBe(false);
  for(const value of ['control','worker']){writeFileSync(role,value);expect(containerGlobalAgentMode(role)).toBe(true);}
  writeFileSync(role,'other');expect(containerGlobalAgentMode(role)).toBe(false);
  const bot={cliId:'codex',codexAuthSync:'isolated',codexInstancePool:{enabled:true},cliInstanceBinding:{codexHome:'/bot-home'},sandbox:true,ownerOpenId:'owner',larkAppId:'app'};
  expect(containerAgentGlobalConfiguration(bot,false)).toBe(bot);
  const effective=containerAgentGlobalConfiguration(bot,true);
  expect(effective.codexAuthSync).toBe('shared');expect(effective.codexInstancePool).toBeUndefined();expect(effective.cliInstanceBinding).toBeUndefined();
  expect(effective.sandbox).toBe(true);expect(effective.ownerOpenId).toBe('owner');expect(effective.larkAppId).toBe('app');
  expect(bot.codexAuthSync).toBe('isolated');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('merges the container-global model environment into every runtime snapshot without mutating the Bot record',()=>{
 const home=mkdtempSync(join(tmpdir(),'container-global-env-'));
 try{
  writeContainerAgentEnvironment(home,'codex',{PLATFORM_MODEL_API_KEY:'global-secret'});
  writeContainerAgentConfiguration(home,'codex',{env:{PLATFORM_MODEL_API_KEY:'global-secret'},model:'global-model'});
  const bot={cliId:'codex',env:{PROJECT_MODE:'keep',PLATFORM_MODEL_API_KEY:'stale'},larkAppId:'app'};
  const effective=containerAgentGlobalConfiguration(bot,true,home);
  expect(effective.env).toEqual({PROJECT_MODE:'keep',PLATFORM_MODEL_API_KEY:'global-secret'});
  expect(effective.model).toBe('global-model');
  expect(bot.env.PLATFORM_MODEL_API_KEY).toBe('stale');
  writeContainerAgentEnvironment(home,'codex',{});
  expect(containerAgentGlobalConfiguration(bot,true,home).env).toEqual({PROJECT_MODE:'keep'});
 }finally{rmSync(home,{recursive:true,force:true});}
});
it('splits only Agent model keys into the container-global source',()=>{
 expect(splitContainerAgentEnvironment('codex',{PLATFORM_MODEL_API_KEY:'secret',PROJECT_MODE:'keep'})).toEqual({
  global:{PLATFORM_MODEL_API_KEY:'secret'},local:{PROJECT_MODE:'keep'}});
 expect(splitContainerAgentEnvironment('pi',null)).toEqual({global:{},local:null});
 expect(splitContainerAgentEnvironment('unknown',{A:'1'})).toEqual({global:{},local:{A:'1'}});
});
