import {it,expect,vi} from 'vitest';
import * as os from 'node:os';
import * as role from '../src/platform/management/container-role.js';
import {mkdtempSync,rmSync,cpSync,mkdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {jobWorkspace,conventionPrompt,conventionRootForDigest,conventionDigest} from '../src/platform/workflow/conventions.js';
import {validateWorkerCommand} from '../src/platform/workflow/worker-protocol.js';
import * as conventions from '../src/platform/workflow/conventions.js';
import {buildNewTopicPrompt} from '../src/core/session-manager.js';
import {buildBotmuxSystemPromptText} from '../src/adapters/cli/shared-hints.js';

it('injects interactive conventions through one channel per CLI',()=>{
 const marker='unique managed environment convention',spy=vi.spyOn(conventions,'interactiveConventionPrompt').mockReturnValue(marker);
 try{
  for(const cli of ['claude-code','pi','genius','grok'] as const){
   const opening=buildNewTopicPrompt('hello','convention-session',cli,undefined,undefined,undefined,undefined,undefined,undefined,'en');
   expect(opening).not.toContain(marker);expect(buildBotmuxSystemPromptText({locale:'en'}).split(marker)).toHaveLength(2);
  }
  for(const cli of ['codex','zcode'] as const)expect(buildNewTopicPrompt('hello','convention-session',cli,undefined,undefined,undefined,undefined,undefined,undefined,'en').split(marker)).toHaveLength(2);
 }finally{spy.mockRestore();}
});
it('loads common plus exact role skills and verifies the versioned bundle',()=>{
 const home=mkdtempSync(join(tmpdir(),'conventions-'));try{cpSync(resolve('../agent-control-plane/images/agents/skills/workflow-conventions'),home,{recursive:true});
  expect(conventionPrompt('interactive',home)).not.toContain('# Workflow node');
  expect(conventionPrompt('workflow-architect',home)).toContain('# Workflow architect');expect(conventionPrompt('workflow-architect',home)).not.toContain('# Workflow node');
  expect(conventionPrompt('workflow-node',home)).toContain('BOTMUX_JOB_WORK_DIR');expect(conventionPrompt('workflow-node',home)).not.toContain('# Workflow architect');
  writeFileSync(join(home,'skills/workflow-node/SKILL.md'),'tampered');expect(()=>conventionPrompt('workflow-node',home)).toThrow('digest_mismatch');
 }finally{rmSync(home,{recursive:true,force:true});}
});
it('separates runs and attempts, keeps run-shared data and scopes tool installation',()=>{
 const root=mkdtempSync(join(tmpdir(),'job-workspace-'));try{
  const first=jobWorkspace(root,'run-a','11111111-1111-4111-8111-111111111111',{PATH:'/public/bin'}),second=jobWorkspace(root,'run-a','22222222-2222-4222-8222-222222222222'),third=jobWorkspace(root,'run-b','33333333-3333-4333-8333-333333333333');
  expect(first.work).not.toBe(second.work);expect(first.shared).toBe(second.shared);expect(first.shared).not.toBe(third.shared);expect(first.env.NPM_CONFIG_PREFIX).toBe(first.tools);expect(first.env.PATH).toContain('/public/bin');expect(first.tools).not.toBe(second.tools);
  expect(()=>jobWorkspace(root,'../escape','11111111-1111-4111-8111-111111111111')).toThrow();
  mkdirSync(join(root,'linked'));symlinkSync(first.work,join(root,'linked/jobs'));expect(()=>jobWorkspace(root,'linked','11111111-1111-4111-8111-111111111111')).toThrow('unsafe_job_workspace');
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('keeps legacy worker commands valid and rejects unknown convention versions',()=>{
 const command={schema:'botmux-worker-command-v1' as const,jobId:'11111111-1111-4111-8111-111111111111',runId:'legacy',attemptId:'a/001',node:{id:'node',type:'goal' as const,goal:'work',depends:[],inputs:[],humanGate:null},goal:'work',inputs:[],timeoutMs:1000};
 expect(validateWorkerCommand(command)).toBe(command);expect(()=>validateWorkerCommand({...command,conventionsVersion:99} as any)).toThrow('unsupported_workflow_conventions');
});

it('serves the frozen prior Skill bundle while new roles receive explicit document-first delivery',()=>{
 const root=resolve('../agent-control-plane/images/agents/skills/workflow-conventions'),old='ab0c613fbf78dc32ca1c178c6fb02647216b7eecbc8039c0e536dd34fb3873b3';
 const historical=conventionRootForDigest(old,root);expect(conventionDigest(historical)).toBe(old);expect(conventionPrompt('workflow-node',historical)).toContain('when requested as the final report');
 expect(conventionPrompt('interactive',root)).toContain('Feishu documents by default');expect(conventionPrompt('workflow-architect',root)).toContain('one top-level final goal');expect(conventionPrompt('workflow-node',root)).toContain('Control to publish as a Feishu document');
 expect(()=>conventionRootForDigest('f'.repeat(64),root)).toThrow('digest_changed');
});

it('includes fixed publishing metadata only in Control interactive context and never exposes extra secret fields',()=>{
 const home=mkdtempSync(join(tmpdir(),'control-publishing-context-')),homeSpy=vi.spyOn(os,'homedir').mockReturnValue(home),roleSpy=vi.spyOn(role,'containerRole').mockReturnValue('control');
 const runtimeRole=process.env.BOTMUX_RUNTIME_ROLE,workflow=process.env.BOTMUX_WORKFLOW;
 try{delete process.env.BOTMUX_RUNTIME_ROLE;delete process.env.BOTMUX_WORKFLOW;mkdirSync(join(home,'.botmux/platform'),{recursive:true});writeFileSync(join(home,'.botmux/platform/report-publishing-context.json'),JSON.stringify({appId:'cli_fixed',userOpenId:'ou_fixed',folderToken:'folder-fixed',larkCliDataDir:'/private/publisher',revision:3,appSecret:'must-not-enter-prompt'}));
  const prompt=conventions.interactiveConventionPrompt();expect(prompt).toContain('folder-fixed');expect(prompt).toContain('/private/publisher');expect(prompt).not.toContain('must-not-enter-prompt');
  roleSpy.mockReturnValue('worker');expect(conventions.interactiveConventionPrompt()).not.toContain('folder-fixed');roleSpy.mockReturnValue('control');process.env.BOTMUX_RUNTIME_ROLE='workflow-node';expect(conventions.interactiveConventionPrompt()).toBe('');
 }finally{homeSpy.mockRestore();roleSpy.mockRestore();if(runtimeRole===undefined)delete process.env.BOTMUX_RUNTIME_ROLE;else process.env.BOTMUX_RUNTIME_ROLE=runtimeRole;if(workflow===undefined)delete process.env.BOTMUX_WORKFLOW;else process.env.BOTMUX_WORKFLOW=workflow;rmSync(home,{recursive:true,force:true});}
});
