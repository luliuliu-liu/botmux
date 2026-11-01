/** Pure wire contract, shared with Control Plane; no host config/filesystem. */
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
export type AgentSkillBundle={schemaVersion:1;skills:Array<{name:string;version:string|null;files:Array<{path:string;content:string;executable:boolean}>}>;digest:string};
export class AgentSkillError extends Error {constructor(readonly status:number,message:string){super(message);}}
export const validSkillName=(name:unknown):name is string=>typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(name);
export const skillBundleDigest=(skills:AgentSkillBundle['skills'])=>createHash('sha256').update(JSON.stringify(skills)).digest('hex');
export function validateAgentSkillBundle(value:unknown):AgentSkillBundle{
 const fail=(message:string):never=>{throw new AgentSkillError(400,message);},b=value as AgentSkillBundle;
 if(!b||b.schemaVersion!==1||!Array.isArray(b.skills)||b.skills.length>100||typeof b.digest!=='string')fail('Skill 制品格式无效');
 let bytes=0,count=0;const names=new Set<string>();
 for(const skill of b.skills){
  if(!skill||!validSkillName(skill.name)||skill.name.startsWith('botmux-')||names.has(skill.name)||!(skill.version===null||typeof skill.version==='string'&&skill.version.length<=200)||!Array.isArray(skill.files))fail('Skill 名称或版本无效');
  names.add(skill.name);const paths=new Set<string>();
  for(const file of skill.files){
   if(!file||typeof file.path!=='string'||file.path.length>1024||file.path.includes('\\')||file.path.includes('\0')||file.path.split('/').length>16||file.path.split('/').some(p=>!p||p==='.'||p==='..')||paths.has(file.path)||typeof file.content!=='string'||typeof file.executable!=='boolean')fail('Skill 文件路径无效');
   paths.add(file.path);const data=Buffer.from(file.content,'base64');
   if(data.toString('base64')!==file.content)fail('Skill 文件编码无效');
   bytes+=data.length;if(++count>1000||bytes>4*1024*1024)fail('Skill 制品超过 4 MiB / 1000 文件限制');
  }
  if(!paths.has('SKILL.md'))fail('Skill 缺少 SKILL.md');
  for(const path of paths)for(let p=dirname(path);p!=='.';p=dirname(p))if(paths.has(p))fail('Skill 文件与目录冲突');
 }
 const skills=b.skills.map(s=>({name:s.name,version:s.version,files:s.files.map(f=>({path:f.path,content:f.content,executable:f.executable}))}));
 if(Buffer.byteLength(JSON.stringify(skills))>6*1024*1024-4096)fail('Skill 制品传输大小超过限制');
 if(skillBundleDigest(skills)!==b.digest)fail('Skill 制品摘要不一致');
 return {schemaVersion:1,skills,digest:b.digest};
}
