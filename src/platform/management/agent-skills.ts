/** Platform-only, container-global Skill distribution. Native registry and
 * per-session delivery remain upstream-owned. No scripts are executed here. */
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {constants,openSync,closeSync,fstatSync,readFileSync,readdirSync,lstatSync,mkdirSync,writeFileSync,renameSync,symlinkSync,readlinkSync,unlinkSync,rmSync} from 'node:fs';
import {readSkillRegistry} from '../../services/skill-registry-store.js';
import {readSkillPackRegistry} from '../../services/skill-pack-store.js';
import {snapshotSessionSkills,sessionSkillRuntimeDir,type SkillSnapshotTrust} from '../../core/skills/snapshot.js';
import type {SkillPackage,SkillPack,SkillSelector} from '../../core/skills/types.js';
import {withFileLock} from '../../utils/file-lock.js';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import {AgentSkillError,validateAgentSkillBundle,skillBundleDigest,validSkillName,type AgentSkillBundle} from './agent-skill-format.js';
export {AgentSkillError,validateAgentSkillBundle,type AgentSkillBundle} from './agent-skill-format.js';

const maxBytes=4*1024*1024,maxFiles=1000;
export const agentSkillRoots:Record<string,string>={pi:'.pi/agent/skills',codex:'.codex/skills','claude-code':'.claude/skills',traex:'.trae/skills',zcode:'.zcode/skills'};
function fail(message:string):never{throw new AgentSkillError(409,message);}
export function buildAgentSkillBundle(selectors:unknown,opts:{registry?:Record<string,SkillPackage>;packs?:Record<string,SkillPack>;trust?:SkillSnapshotTrust;dataDir?:string}={}):AgentSkillBundle{
 if(!Array.isArray(selectors)||selectors.length>100||selectors.some(s=>typeof s!=='string'||!/^(skill|pack):[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(s)))fail('请选择已安装 Skill 或专项包');
 const registry=opts.registry??readSkillRegistry().skills,packs=opts.packs??readSkillPackRegistry().packs,names=new Set<string>();
 for(const selector of selectors as SkillSelector[]){
  if(selector.startsWith('pack:')){const id=selector.slice(5),pack=Object.hasOwn(packs,id)?packs[id]:null;if(!pack)fail('专项包已被删除，请刷新');for(const s of pack.include)names.add(s.slice(6));}
  else names.add(selector.slice(6));
 }
 if(names.size>100)fail('单个 Agent 最多分配 100 个 Skill');
 const selected=[...names].sort().map(name=>{const skill=Object.hasOwn(registry,name)?registry[name]:null;if(!skill)fail('存在未安装的 Skill，请先安装');return {...skill,priorityReason:'platform-agent'};});
 const sid=randomUUID(),dataDir=opts.dataDir??join(homedir(),'.botmux','platform','skill-export');
 try{
  const snap=snapshotSessionSkills({sessionId:sid,cliId:'pi',workingDir:'/workspace',policyMode:'priority',prioritySkills:selected,diagnostics:[],generatedAt:new Date().toISOString()},{dataDir,trust:opts.trust});
  if(snap.diagnostics.length||snap.manifest.prioritySkills.some(s=>!s.snapshotOf))fail('仅支持完整的受管 Skill 副本；链接/外部资源请先复制安装到原生 Skill 库');
  let bytes=0,count=0;
  const skills=snap.manifest.prioritySkills.map(skill=>{
   const files:AgentSkillBundle['skills'][number]['files']=[];
   const visit=(relative:string)=>{for(const entry of readdirSync(join(skill.rootDir,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=relative?relative+'/'+entry.name:entry.name,absolute=join(skill.rootDir,path);
    if(entry.isDirectory()){visit(path);continue;}
    if(!entry.isFile())fail('Skill 含不支持的文件');
    const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);try{
     const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)fail('Skill 文件不可分发');
     bytes+=stat.size;if(++count>maxFiles||bytes>maxBytes)fail('Skill 制品超过 4 MiB / 1000 文件限制');
     files.push({path,content:readFileSync(fd).toString('base64'),executable:!!(stat.mode&0o111)});
    }finally{closeSync(fd);}
   }};visit('');return {name:skill.name,version:skill.version??null,files};
  });
  return validateAgentSkillBundle({schemaVersion:1,skills,digest:skillBundleDigest(skills)});
 }finally{rmSync(sessionSkillRuntimeDir(sid,dataDir),{recursive:true,force:true});}
}
function stat(path:string){try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
/** Refuse symlinked parents, including missing descendants of an alias. */
function directory(path:string){const parent=dirname(path);if(parent!==path)directory(parent);const s=stat(path);if(s){if(!s.isDirectory()||s.isSymbolicLink())fail('Skill 目标目录不能是符号链接');}else mkdirSync(path,{mode:0o700});}
/** Add-only installation. Existing names (including platform-managed names) are
 * never replaced, removed or treated as an error. Uses a distinct API so older
 * images cannot accidentally interpret an additive install as replacement. */
export async function installMissingAgentSkills(home:string,input:unknown,agents:string[],requested?:unknown){
 const bundle=validateAgentSkillBundle(input);
 const names=requested??bundle.skills.map(skill=>skill.name);
 if(!Array.isArray(names)||names.length>100||names.some(name=>!validSkillName(name)||name.startsWith('botmux-'))||new Set(names).size!==names.length||bundle.skills.some(skill=>!names.includes(skill.name)))fail('Skill 同步名称无效');
 if(!agents.length||agents.some(a=>!agentSkillRoots[a]))fail('Agent 不支持全局 Skill 目录');
 const base=join(home,'.agents','.platform-skills');directory(base);
 return withFileLock(join(base,'operation'),async()=>{
  const roots=[...new Set(['.agents/skills',...agents.map(a=>agentSkillRoots[a]!)])].map(root=>join(home,root));
  for(const root of roots)directory(root);
  for(const name of names)if(!bundle.skills.some(skill=>skill.name===name)&&!roots.some(root=>stat(join(root,name))))fail(`Skill 来源为链接，目标中不存在，请先复制安装到 Skill 库：${name}`);
  const installed:string[]=[],skipped:string[]=[];
  for(const name of names){
   if(roots.some(root=>stat(join(root,name)))){skipped.push(name);continue;}
   const skill=bundle.skills.find(skill=>skill.name===name);
   if(!skill)fail(`Skill 来源为链接，请先复制安装到 Skill 库：${name}`);
   const release=join(base,'install-'+randomUUID()),skillDir=join(release,skill.name),linked:string[]=[];directory(skillDir);
   try{
    for(const file of skill.files){const out=join(skillDir,file.path);directory(dirname(out));writeFileSync(out,Buffer.from(file.content,'base64'),{mode:file.executable?0o700:0o600,flag:'wx'});}
    for(const root of roots){const dest=join(root,skill.name);symlinkSync(skillDir,dest);linked.push(dest);}
    installed.push(skill.name);
   }catch(error){
    // A user process may create a same-name entry after the initial check.
    // Roll back only links made by this attempt, never external content.
    for(const path of linked)if(stat(path)?.isSymbolicLink()&&readlinkSync(path)===skillDir)unlinkSync(path);
    rmSync(release,{recursive:true,force:true});
    if((error as NodeJS.ErrnoException).code==='EEXIST'){skipped.push(skill.name);continue;}
    throw error;
   }
  }
  return {applied:true,digest:bundle.digest,installed,skipped};
 });
}
export async function applyAgentSkillBundle(home:string,input:{revision:number;bundle:AgentSkillBundle},agents:string[]){
 const bundle=validateAgentSkillBundle(input.bundle);
 if(!Number.isSafeInteger(input.revision)||input.revision<1||!agents.length||agents.some(a=>!agentSkillRoots[a]))fail('Agent 不支持全局 Skill 目录');
 const base=join(home,'.agents','.platform-skills');directory(base);
 return withFileLock(join(base,'operation'),async()=>{
  const current=join(base,'current'),receipt=join(base,'applied.json');
  const receiptStat=stat(receipt);if(receiptStat&&(!receiptStat.isFile()||receiptStat.isSymbolicLink()))fail('Skill 同步记录不可读取');
  const previous=stat(receipt)?JSON.parse(readFileSync(receipt,'utf8')):null;
  if(previous&&(!Array.isArray(previous.names)||previous.names.some((n:unknown)=>!validSkillName(n))))fail('Skill 同步记录无效');
  if(previous&&(previous.revision>input.revision||previous.revision===input.revision&&previous.digest!==bundle.digest))fail('Skill 同步版本已变化，请刷新');
  const roots=[...new Set(['.agents/skills',...agents.map(a=>agentSkillRoots[a]!)])].map(root=>join(home,root));
  const names=bundle.skills.map(s=>s.name),ownedNames=new Set<string>(previous?.names??[]);
  // Recover links created by an interrupted attempt before its receipt commit.
  for(const root of roots){directory(root);for(const e of readdirSync(root,{withFileTypes:true}))if(e.isSymbolicLink()&&validSkillName(e.name)&&readlinkSync(join(root,e.name))===join(current,e.name))ownedNames.add(e.name);}
  const oldNames=[...ownedNames],all=[...new Set([...oldNames,...names])];
  for(const root of roots){directory(root);for(const name of all){
   const p=join(root,name),s=stat(p);if(s&&(!s.isSymbolicLink()||readlinkSync(p)!==join(current,name)))fail(`同名 Skill 已存在，未覆盖：${name}`);
  }}
  const previousPointer=stat(current);if(previousPointer&&(!previousPointer.isSymbolicLink()||!/^release-[a-f0-9]{64}$/.test(readlinkSync(current))))fail('受管 Skill 指针冲突');
  // A new private release per attempt also repairs tampered contents. Existing
  // releases are not trusted merely because their directory has a digest name.
  const release='release-'+bundle.digest,staging=join(base,'.staging-'+randomUUID());directory(staging);
  try{
   for(const skill of bundle.skills)for(const file of skill.files){const out=join(staging,skill.name,file.path);directory(dirname(out));writeFileSync(out,Buffer.from(file.content,'base64'),{mode:file.executable?0o700:0o600,flag:'wx'});}
   const final=join(base,release);
   if(stat(final)){
    // Never rewrite a live release. Verify the complete tree, including extra
    // files, links and executable bits before trusting a digest-named path.
    directory(final);const expected=new Map(bundle.skills.flatMap(s=>s.files.map(f=>[s.name+'/'+f.path,f] as const)));let seen=0;
    let entries=0;const verify=(relative:string)=>{if(relative.split('/').length>18)fail('受管 Skill 目录过深');for(const e of readdirSync(join(final,relative),{withFileTypes:true})){
     if(++entries>maxFiles*18)fail('受管 Skill 文件过多');
     const p=relative?relative+'/'+e.name:e.name,absolute=join(final,p);
     if(e.isDirectory()){verify(p);continue;}
     const f=expected.get(p),s=stat(absolute);
     if(!f||!s?.isFile()||s.nlink!==1||s.isSymbolicLink()||!!(s.mode&0o111)!==f.executable||readFileSync(absolute).toString('base64')!==f.content)fail('受管 Skill 内容被修改，请检查实例');seen++;
    }};verify('');if(seen!==expected.size)fail('受管 Skill 内容不完整');
    rmSync(staging,{recursive:true,force:true});
   }else renameSync(staging,final);
   for(const root of roots)for(const name of names)if(!stat(join(root,name)))symlinkSync(join(current,name),join(root,name));
   const next=join(base,'.pointer-'+randomUUID());symlinkSync(release,next);renameSync(next,current);
   for(const root of roots)for(const name of oldNames.filter(n=>!names.includes(n)))if(stat(join(root,name)))unlinkSync(join(root,name));
   const applied={revision:input.revision,digest:bundle.digest,names,agents:[...new Set(agents)],appliedAt:new Date().toISOString()};
   atomicWriteFileSync(receipt,JSON.stringify(applied),{mode:0o600});return {applied:true,...applied};
  }finally{rmSync(staging,{recursive:true,force:true});}
 });
}
