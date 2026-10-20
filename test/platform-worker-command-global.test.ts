import {describe,it,expect} from 'vitest';
import {claudeHeadlessArgs,hydrateWorkerConfiguration} from '../src/platform/workflow/worker-command.js';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeContainerAgentConfiguration} from '../src/platform/management/container-agent-files.mjs';
const base:any={generation:'g',revision:1,agentType:'claude-code',binding:null,
 model:{provider:'anthropic',baseUrl:'https://api.anthropic.com',protocol:'anthropic-messages',authMethod:'oauth',modelId:'',modelIds:[],apiKey:''}};
describe('container-global Workflow Agent arguments',()=>{
 it('omits --model for native OAuth defaults',()=>{
  expect(claudeHeadlessArgs(base)).toEqual(['--print','--dangerously-skip-permissions']);
 });
 it('pins an explicit global model exactly once',()=>{
  expect(claudeHeadlessArgs({...base,model:{...base.model,modelId:'chosen'}})).toEqual(['--print','--model','chosen','--dangerously-skip-permissions']);
 });
 it('hydrates redacted API and Bot secrets only in memory for Workflow execution',()=>{
  const home=mkdtempSync(join(tmpdir(),'worker-hydrate-'));
  try{
   mkdirSync(join(home,'.botmux'),{recursive:true});writeFileSync(join(home,'.botmux','bots.json'),JSON.stringify([{larkAppId:'app',larkAppSecret:'bot-secret'}]));
   writeContainerAgentConfiguration(home,'claude-code',{env:{ANTHROPIC_API_KEY:'model-secret'},model:null});
   const config=hydrateWorkerConfiguration(home,{...base,binding:{appId:'app',generation:'b',appSecret:'',displayName:'bot',brand:'feishu',owner:{allowedUsers:['owner']}}});
   expect(config.model.apiKey).toBe('model-secret');expect(config.binding?.appSecret).toBe('bot-secret');
  }finally{rmSync(home,{recursive:true,force:true});}
 });
});
