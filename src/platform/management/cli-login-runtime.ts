import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,lstatSync,unlinkSync,chmodSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parse as parseYaml} from 'yaml';
import {withFileLock} from '../../utils/file-lock.js';

type Runner=(command:string,args:string[],input:string,env:NodeJS.ProcessEnv)=>Promise<{code:number|null;stdout:string;stderr:string}>;
export type CliLoginInput={cli:'github'|'docker';revision:number;generation:string;account?:string;gitName?:string;gitEmail?:string;token?:string;privateKey?:string;registry?:string;username?:string;password?:string};
const githubHostKey='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n';
const registryKey=(registry:string)=>registry==='docker.io'?'https://index.docker.io/v1/':registry;
const begin='# BEGIN AGENT CONTROL PLANE GITHUB',end='# END AGENT CONTROL PLANE GITHUB';
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const managedPaths=['.gitconfig','.config/gh/hosts.yml','.config/gh/config.yml','.ssh/config','.ssh/acp_github_key','.ssh/acp_github_hosts','.docker/config.json','.botmux/platform/cli-login-managed.json'];
const runner:Runner=(command,args,input,env)=>new Promise((resolve,reject)=>{
 const child=spawn(command,args,{env,stdio:['pipe','pipe','pipe']}),timer=setTimeout(()=>child.kill('SIGKILL'),60000);let stdout='',stderr='';
 child.stdout.on('data',s=>{stdout=(stdout+s).slice(-16384);});child.stderr.on('data',s=>{stderr=(stderr+s).slice(-16384);});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});child.stdin.on('error',()=>{});child.stdin.end(input);
});
function readFile(path:string){try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe_path');return readFileSync(path);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}}
function write(path:string,data:Buffer|string){mkdirSync(dirname(path),{recursive:true,mode:0o700});const tmp=path+'.tmp-'+randomUUID();try{writeFileSync(tmp,data,{mode:0o600,flag:'wx'});renameSync(tmp,path);chmodSync(path,0o600);}finally{try{unlinkSync(tmp);}catch{}}}
function restore(path:string,data:Buffer|null){if(data)write(path,data);else try{unlinkSync(path);}catch(e:any){if(e.code!=='ENOENT')throw e;}}
function protectedDirs(home:string){for(const dir of ['.ssh','.config','.config/gh','.docker','.botmux','.botmux/platform']){const p=join(home,dir);try{const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error('unsafe_directory');}catch(e:any){if(e.code!=='ENOENT')throw e;}}}
function recover(home:string){
 const journal=join(home,'.botmux/platform/cli-login-pending.json'),data=readFile(journal);
 if(data){const entries=JSON.parse(data.toString('utf8'));if(!Array.isArray(entries)||entries.length>managedPaths.length||entries.some(e=>!Array.isArray(e)||!managedPaths.includes(e[0])||e[1]!==null&&(typeof e[1]!=='string'||e[1].length>2*1024*1024))||new Set(entries.map(e=>e[0])).size!==entries.length)throw Error('登录恢复记录无效');
  for(const [path,encoded] of entries)restore(join(home,path),encoded===null?null:Buffer.from(encoded,'base64'));unlinkSync(journal);
 }
 for(const name of readdirSync(join(home,'.botmux/platform')))if(/^\.cli-login-[A-Za-z0-9]{6}$/.test(name))rmSync(join(home,'.botmux/platform',name),{recursive:true,force:true});
}
function textField(v:unknown){return typeof v==='string'&&v.length>0&&v.length<=16384&&!/[\0\r\n]/.test(v);}
export function cliLoginReceipts(home:string){
 try{protectedDirs(home);if(readFile(join(home,'.botmux/platform/cli-login-pending.json')))return {};const marker=JSON.parse(readFile(join(home,'.botmux','platform','cli-login-managed.json'))?.toString('utf8')||'{}'),out:Record<string,{revision:number;generation:string}>={};
  const valid=(v:any)=>Number.isSafeInteger(v?.revision)&&v.revision>0&&typeof v.generation==='string'&&/^[A-Za-z0-9._-]{1,100}$/.test(v.generation);
  const paths=['.gitconfig','.config/gh/hosts.yml','.config/gh/config.yml','.ssh/config','.ssh/acp_github_key','.ssh/acp_github_hosts'];
  if(valid(marker.github?.receipt)&&marker.github.files&&Object.keys(marker.github.files).length===paths.length&&paths.every(path=>{const data=readFile(join(home,path));return (data?digest(data):null)===marker.github.files[path];}))out.github={revision:marker.github.receipt.revision,generation:marker.github.receipt.generation};
  if(valid(marker.docker?.receipt)){const config=JSON.parse(readFile(join(home,'.docker/config.json'))?.toString('utf8')||'{}'),helper=config.credHelpers?.[marker.docker.registry]||(marker.docker.registry==='https://index.docker.io/v1/'&&config.credHelpers?.['docker.io']);if(!config.credsStore&&!helper&&digest(JSON.stringify(config.auths?.[marker.docker.registry]??null))===marker.docker.authDigest)out.docker={revision:marker.docker.receipt.revision,generation:marker.docker.receipt.generation};}
  return out;
 }catch{return {};}
}
export async function applyCliLogin(home:string,input:CliLoginInput,run:Runner=runner){
 if(!input||!['github','docker'].includes(input.cli)||!Number.isSafeInteger(input.revision)||input.revision<1||!textField(input.generation))throw Error('登录请求无效');
 if(input.cli==='github'&&(!textField(input.account)||!textField(input.gitName)||!textField(input.gitEmail)||!textField(input.token)||typeof input.privateKey!=='string'||!input.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')))throw Error('GitHub 配置无效');
 if(input.cli==='docker'&&(!textField(input.registry)||!/^([a-z0-9-]+\.)*[a-z0-9-]+(?::[0-9]{1,5})?$/i.test(input.registry!)||!textField(input.username)||!textField(input.password)))throw Error('Docker 配置无效');
 const conflicts=input.cli==='github'?['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GH_CONFIG_DIR','GIT_CONFIG_GLOBAL','GIT_CONFIG_COUNT','GIT_SSH','GIT_SSH_COMMAND']:['DOCKER_CONFIG'];
 if(conflicts.some(k=>process.env[k])||input.cli==='github'&&process.env.GH_HOST&&process.env.GH_HOST!=='github.com')throw Error('已有环境变量覆盖 CLI 配置，请先处理冲突');
 protectedDirs(home);mkdirSync(join(home,'.botmux','platform'),{recursive:true,mode:0o700});
 return withFileLock(join(home,'.botmux','platform','cli-login-operation'),async()=>{
  protectedDirs(home);
  recover(home);
  const folder=mkdtempSync(join(home,'.botmux','platform','.cli-login-')),stage=join(folder,'home');mkdirSync(stage,{mode:0o700});
  const marker=join(home,'.botmux','platform','cli-login-managed.json');let managed:any={};try{managed=JSON.parse(readFile(marker)?.toString('utf8')||'{}');}catch{throw Error('登录管理记录无效');}
  const paths=input.cli==='github'?['.gitconfig','.config/gh/hosts.yml','.config/gh/config.yml','.ssh/config','.ssh/acp_github_key','.ssh/acp_github_hosts']:['.docker/config.json'];
  const backups=new Map<string,Buffer|null>();for(const p of paths)backups.set(p,readFile(join(home,p)));
  const env={...process.env,HOME:stage,XDG_CONFIG_HOME:join(stage,'.config'),GH_CONFIG_DIR:join(stage,'.config','gh'),DOCKER_CONFIG:join(stage,'.docker'),GIT_CONFIG_GLOBAL:join(stage,'.gitconfig')};
  for(const k of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GIT_CONFIG_COUNT','GIT_SSH_COMMAND'])delete env[k as keyof typeof env];
  try{
   if(input.cli==='github'){
    const gh=backups.get('.config/gh/hosts.yml');let hosts:any={};try{hosts=gh?parseYaml(gh.toString('utf8'))||{}:{};}catch{throw Error('现有 gh 配置无效');}
    if(hosts['github.com']&&!managed.github)throw Error('已有 GitHub 登录，请先在终端处理冲突');
    if(managed.github&&digest(JSON.stringify(hosts['github.com']??null))!==managed.github.hostDigest)throw Error('GitHub 登录已被手动修改，请先处理冲突');
    if(gh)write(join(stage,'.config/gh/hosts.yml'),gh);
    const ghConfig=backups.get('.config/gh/config.yml');if(ghConfig)write(join(stage,'.config/gh/config.yml'),ghConfig);
    const git=backups.get('.gitconfig');if(git)write(join(stage,'.gitconfig'),git);
    const previous=backups.get('.ssh/config')?.toString('utf8')||'';
    if((previous.includes(begin)!==previous.includes(end))||!managed.github&&/^\s*Host\s+.*(?:github\.com|\*)/im.test(previous))throw Error('已有 GitHub SSH 配置，请先在终端处理冲突');
    const clean=previous.includes(begin)?previous.replace(new RegExp(begin+'[\\s\\S]*?'+end+'\\n?'),''):previous;
    const previousBlock=previous.match(new RegExp(begin+'[\\s\\S]*?'+end+'\\n?'))?.[0]??'';
    if(managed.github&&(digest(previousBlock)!==managed.github.blockDigest||digest(backups.get('.ssh/acp_github_key')??'')!==managed.github.keyDigest))throw Error('GitHub SSH 配置已被手动修改，请先处理冲突');
    const key=join(stage,'.ssh/acp_github_key'),known=join(stage,'.ssh/acp_github_hosts');write(key,input.privateKey!);write(known,githubHostKey);
    let result=await run('/usr/bin/gh',['auth','login','--hostname','github.com','--with-token'],input.token!+'\n',env);if(result.code!==0)throw Error('GitHub Token 登录失败');
    result=await run('/usr/bin/gh',['config','set','git_protocol','ssh','--host','github.com'],'',env);if(result.code!==0)throw Error('GitHub SSH 协议配置失败');
    result=await run('/usr/bin/gh',['api','user','--jq','.login'],'',env);if(result.code!==0||result.stdout.trim().toLowerCase()!==input.account!.toLowerCase())throw Error('GitHub 账号验证失败');
    result=await run('/usr/bin/ssh',['-F','/dev/null','-T','-i',key,'-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${known}`,'-o','GlobalKnownHostsFile=/dev/null','-o','BatchMode=yes','-o','ConnectTimeout=15','git@github.com'],'',env);
    if(!(result.stdout+result.stderr).includes(`Hi ${input.account}!`))throw Error('GitHub SSH 登录验证失败');
    for(const [keyName,value] of [['user.name',input.gitName!],['user.email',input.gitEmail!]]){
     const old=await run('/usr/bin/git',['config','--global','--get',keyName],'',env);
     const expected=keyName==='user.name'?managed.github?.gitName:managed.github?.gitEmail;
     if(managed.github&&old.code!==0||old.code===0&&old.stdout.trim()!==(managed.github?expected:value))throw Error('已有 Git 作者配置，请先在终端处理冲突');
     const set=await run('/usr/bin/git',['config','--global','--',keyName,value],'',env);if(set.code!==0)throw Error('Git 作者配置失败');
    }
    write(join(stage,'.ssh/config'),`${begin}\nHost github.com\n  IdentityFile ${join(home,'.ssh/acp_github_key')}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${join(home,'.ssh/acp_github_hosts')}\n  StrictHostKeyChecking yes\n${end}\n${clean}`);
    // The key was verified in staging and will have the same bytes after promotion.
   }else{
    const old=backups.get('.docker/config.json');let config:any={};try{config=old?JSON.parse(old.toString('utf8')):{};}catch{throw Error('现有 Docker 配置无效');}
    const selected=registryKey(input.registry!);
    if(config.credsStore||config.credHelpers?.[input.registry!]||config.credHelpers?.[selected])throw Error('Docker 使用外部凭据助手，请先处理冲突');
    if(managed.docker&&digest(JSON.stringify(config.auths?.[managed.docker.registry]??null))!==managed.docker.authDigest)throw Error('Docker 登录已被手动修改，请先处理冲突');
    if(config.auths?.[selected]&&managed.docker?.registry!==selected)throw Error('该仓库已有用户登录，请先在终端处理冲突');
    if(managed.docker&&managed.docker.registry!==selected&&config.auths)delete config.auths[managed.docker.registry];
    write(join(stage,'.docker/config.json'),JSON.stringify(config));
    const result=await run('/usr/local/bin/docker',['--config',join(stage,'.docker'),'login',input.registry!,'--username',input.username!,'--password-stdin'],input.password!+'\n',env);if(result.code!==0)throw Error('Docker 仓库登录失败');
   }
   // Promote only after every remote verification succeeds; rollback on a write failure.
   const markerBackup=readFile(marker),journal=join(home,'.botmux/platform/cli-login-pending.json');
   const journalEntries:Array<[string,Buffer|null]>=[...backups,['.botmux/platform/cli-login-managed.json',markerBackup]];
   write(journal,JSON.stringify(journalEntries.map(([path,data])=>[path,data?data.toString('base64'):null])));
   try{
    for(const p of paths){const data=readFile(join(stage,p));if(data)write(join(home,p),data);}
    if(input.cli==='github'){
     const hosts=parseYaml(readFile(join(stage,'.config/gh/hosts.yml'))!.toString('utf8'))||{};
     const config=readFile(join(stage,'.ssh/config'))!.toString('utf8'),block=config.match(new RegExp(begin+'[\\s\\S]*?'+end+'\\n?'))?.[0]??'';
     managed.github={hostDigest:digest(JSON.stringify(hosts['github.com']??null)),blockDigest:digest(block),keyDigest:digest(input.privateKey!),gitName:input.gitName,gitEmail:input.gitEmail,receipt:{revision:input.revision,generation:input.generation},files:Object.fromEntries(paths.map(p=>{const data=readFile(join(home,p));return [p,data?digest(data):null];}))};
    }else{const config=JSON.parse(readFile(join(stage,'.docker/config.json'))!.toString('utf8')),key=registryKey(input.registry!);if(!config.auths?.[key])throw Error('Docker 登录结果未落盘');managed.docker={registry:key,authDigest:digest(JSON.stringify(config.auths[key])),receipt:{revision:input.revision,generation:input.generation}};}
    write(marker,JSON.stringify(managed));
    unlinkSync(journal);
   }catch{for(const [p,data] of backups)restore(join(home,p),data);restore(marker,markerBackup);try{unlinkSync(journal);}catch{}throw Error('配置写入失败，已尝试恢复');}
   return {applied:true,verified:true,revision:input.revision,generation:input.generation};
  }finally{rmSync(folder,{recursive:true,force:true});}
 });
}
