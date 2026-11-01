import {describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {applyCliLogin,cliLoginReceipts} from '../src/platform/management/cli-login-runtime.js';
const fixture={cli:'github' as const,revision:1,generation:'generation-1',account:'fixture-user',gitName:'Fixture User',gitEmail:'fixture@example.invalid',token:'fixture-token-secret',privateKey:'-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n'};
function home(){return mkdtempSync(join(tmpdir(),'cli-login-test-'));}
function fakeRunner(fail=false){const calls:Array<{cmd:string;args:string[];input:string}>=[];
 const run=async(cmd:string,args:string[],input:string,env:NodeJS.ProcessEnv)=>{calls.push({cmd,args,input});
  if(cmd==='/usr/bin/gh'&&args[0]==='auth'){const path=join(env.GH_CONFIG_DIR!,'hosts.yml');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'github.com:\n  oauth_token: fixture-token-secret\n');return {code:0,stdout:'',stderr:''};}
  if(cmd==='/usr/bin/gh'&&args[0]==='config')return {code:0,stdout:'',stderr:''};
  if(cmd==='/usr/bin/gh')return {code:0,stdout:'fixture-user\n',stderr:''};
  if(cmd==='/usr/bin/ssh')return {code:1,stdout:'',stderr:fail?'Permission denied':'Hi fixture-user! You have successfully authenticated.'};
  if(cmd==='/usr/bin/git'){try{return {code:0,stdout:execFileSync('git',args,{encoding:'utf8',env}),stderr:''};}catch{return {code:1,stdout:'',stderr:''};}}
  if(cmd==='/usr/local/bin/docker'){const path=join(env.DOCKER_CONFIG!,'config.json'),v=JSON.parse(readFileSync(path,'utf8'));v.auths={...v.auths,[args[3]!]:{auth:Buffer.from('fixture:'+input.trim()).toString('base64')}};writeFileSync(path,JSON.stringify(v));return {code:0,stdout:'',stderr:''};}
  throw Error('unexpected');};return {run,calls};}
describe('Agent CLI login',()=>{
 it('applies verified gh, Git identity and isolated SSH key without exposing secrets in arguments',async()=>{const d=home();try{const fake=fakeRunner();const result=await applyCliLogin(d,fixture,fake.run);expect(result).toMatchObject({applied:true,verified:true});
  expect(readFileSync(join(d,'.gitconfig'),'utf8')).toContain('fixture@example.invalid');expect(readFileSync(join(d,'.ssh/config'),'utf8')).toContain('StrictHostKeyChecking yes');expect(statSync(join(d,'.ssh/acp_github_key')).mode&0o777).toBe(0o600);
  expect(fake.calls.find(c=>c.cmd==='/usr/bin/gh'&&c.args[0]==='auth')!.input).toContain('fixture-token-secret');expect(JSON.stringify(fake.calls.map(c=>c.args))).not.toContain('fixture-token-secret');expect(JSON.stringify(result)).not.toContain('fixture-token-secret');
  expect(cliLoginReceipts(d).github).toEqual({revision:1,generation:'generation-1'});writeFileSync(join(d,'.ssh/acp_github_key'),'changed');expect(cliLoginReceipts(d).github).toBeUndefined();
 }finally{rmSync(d,{recursive:true,force:true});}});
 it('keeps previous files unchanged when SSH validation fails',async()=>{const d=home();try{const original='[user]\n  name = Fixture User\n  email = fixture@example.invalid\n';writeFileSync(join(d,'.gitconfig'),original);await expect(applyCliLogin(d,fixture,fakeRunner(true).run)).rejects.toThrow('SSH');expect(readFileSync(join(d,'.gitconfig'),'utf8')).toBe(original);expect(()=>readFileSync(join(d,'.ssh/acp_github_key'))).toThrow();}finally{rmSync(d,{recursive:true,force:true});}});
 it('does not replace a pre-existing GitHub login owned by the user',async()=>{const d=home();try{const path=join(d,'.config/gh/hosts.yml');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'github.com:\n  user: user-owned\n');const fake=fakeRunner();await expect(applyCliLogin(d,fixture,fake.run)).rejects.toThrow('已有 GitHub 登录');expect(fake.calls).toHaveLength(0);expect(readFileSync(path,'utf8')).toContain('user-owned');}finally{rmSync(d,{recursive:true,force:true});}});
 it('recovers an interrupted multi-file update before retrying',async()=>{const d=home();try{
  await applyCliLogin(d,fixture,fakeRunner().run);const git=join(d,'.gitconfig'),marker=join(d,'.botmux/platform/cli-login-managed.json');const gitBefore=readFileSync(git),markerBefore=readFileSync(marker);
  writeFileSync(join(d,'.botmux/platform/cli-login-pending.json'),JSON.stringify([['.gitconfig',gitBefore.toString('base64')],['.botmux/platform/cli-login-managed.json',markerBefore.toString('base64')]]),{mode:0o600});writeFileSync(git,'partial');writeFileSync(marker,'{}');
  expect(cliLoginReceipts(d)).toEqual({});await expect(applyCliLogin(d,{...fixture,revision:2},fakeRunner(true).run)).rejects.toThrow('SSH');
  expect(readFileSync(git)).toEqual(gitBefore);expect(readFileSync(marker)).toEqual(markerBefore);expect(cliLoginReceipts(d).github?.revision).toBe(1);
 }finally{rmSync(d,{recursive:true,force:true});}});
 it('replaces only the previously managed registry and preserves a user registry',async()=>{const d=home();try{mkdirSync(join(d,'.docker'));writeFileSync(join(d,'.docker/config.json'),JSON.stringify({auths:{'manual.example':{auth:'manual'}}}));const fake=fakeRunner();
  await applyCliLogin(d,{cli:'docker',revision:1,generation:'g',registry:'first.example',username:'fixture',password:'docker-secret'},fake.run);
  await applyCliLogin(d,{cli:'docker',revision:2,generation:'g',registry:'second.example',username:'fixture',password:'docker-secret'},fake.run);
  const config=JSON.parse(readFileSync(join(d,'.docker/config.json'),'utf8'));expect(config.auths['manual.example'].auth).toBe('manual');expect(config.auths['first.example']).toBeUndefined();expect(config.auths['second.example']).toBeDefined();expect(JSON.stringify(fake.calls.map(c=>c.args))).not.toContain('docker-secret');
  expect(cliLoginReceipts(d).docker).toEqual({revision:2,generation:'g'});
  writeFileSync(join(d,'.docker/config.json'),JSON.stringify({...config,credsStore:'manual-helper'}));expect(cliLoginReceipts(d).docker).toBeUndefined();
  config.auths['second.example'].auth='manually-replaced';writeFileSync(join(d,'.docker/config.json'),JSON.stringify(config));
  expect(cliLoginReceipts(d).docker).toBeUndefined();
  await expect(applyCliLogin(d,{cli:'docker',revision:3,generation:'g',registry:'third.example',username:'fixture',password:'docker-secret'},fake.run)).rejects.toThrow('手动修改');
  expect(JSON.parse(readFileSync(join(d,'.docker/config.json'),'utf8')).auths['second.example'].auth).toBe('manually-replaced');
 }finally{rmSync(d,{recursive:true,force:true});}});
});
