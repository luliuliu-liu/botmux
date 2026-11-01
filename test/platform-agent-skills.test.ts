import {describe,it,expect} from 'vitest';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,readlinkSync,existsSync,rmSync,symlinkSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {applyAgentSkillBundle,installMissingAgentSkills,buildAgentSkillBundle,validateAgentSkillBundle,agentSkillRoots} from '../src/platform/management/agent-skills.js';
import {skillBundleDigest,type AgentSkillBundle} from '../src/platform/management/agent-skill-format.js';
import {loadSkillPackage} from '../src/core/skills/package.js';
const bundle=(text='original'):AgentSkillBundle=>{const skills=[{name:'fixture',version:'1',files:[{path:'SKILL.md',content:Buffer.from(text).toString('base64'),executable:false},{path:'scripts/run.sh',content:Buffer.from('#!/bin/sh\necho OK\n').toString('base64'),executable:true}]}];return {schemaVersion:1,skills,digest:skillBundleDigest(skills)};};
const empty=():AgentSkillBundle=>({schemaVersion:1,skills:[],digest:skillBundleDigest([])});
describe('platform container-global Skills',()=>{
 it('skips linked/image-provided names without copying their external source, and refuses missing linked names',async()=>{
  const home=mkdtempSync(join(realpathSync(tmpdir()),'skill-linked-skip-'));
  try{
   mkdirSync(join(home,'.pi','agent','skills','fixture'),{recursive:true});writeFileSync(join(home,'.pi','agent','skills','fixture','SKILL.md'),'image skill');
   expect(await installMissingAgentSkills(home,empty(),['pi'],['fixture'])).toMatchObject({installed:[],skipped:['fixture']});
   await expect(installMissingAgentSkills(home,empty(),['pi'],['missing'])).rejects.toThrow('复制安装');
   expect(readFileSync(join(home,'.pi','agent','skills','fixture','SKILL.md'),'utf8')).toBe('image skill');
  }finally{rmSync(home,{recursive:true,force:true});}
 });
 it('adds missing skills, skips existing names across all native roots, and never updates or removes existing skills',async()=>{
  const home=mkdtempSync(join(realpathSync(tmpdir()),'skill-add-only-'));
  try{
   mkdirSync(join(home,'.claude','skills','fixture'),{recursive:true});writeFileSync(join(home,'.claude','skills','fixture','SKILL.md'),'personal');
   const input=bundle(),another={...input.skills[0],name:'another'};input.skills.push(another);input.digest=skillBundleDigest(input.skills);
   expect(await installMissingAgentSkills(home,input,['codex','claude-code'])).toMatchObject({applied:true,installed:['another'],skipped:['fixture']});
   expect(existsSync(join(home,'.codex','skills','fixture'))).toBe(false);
   expect(readFileSync(join(home,'.claude','skills','fixture','SKILL.md'),'utf8')).toBe('personal');
   expect(readFileSync(join(home,'.codex','skills','another','SKILL.md'),'utf8')).toBe('original');
   expect(loadSkillPackage(join(home,'.codex','skills','another'),{source:{type:'local-copy',originalPath:'/fixture'}}).name).toBe('another');
   const changed=bundle('changed');changed.skills[0].name='another';changed.digest=skillBundleDigest(changed.skills);
   expect(await installMissingAgentSkills(home,changed,['codex','claude-code'])).toMatchObject({installed:[],skipped:['another']});
   expect(readFileSync(join(home,'.codex','skills','another','SKILL.md'),'utf8')).toBe('original');
   expect(existsSync(join(home,'.claude','skills','fixture'))).toBe(true);
  }finally{rmSync(home,{recursive:true,force:true});}
 });
 it('skips names installed by the assignment mechanism without touching its receipt or content',async()=>{
  const home=mkdtempSync(join(realpathSync(tmpdir()),'skill-existing-managed-'));
  try{
   await applyAgentSkillBundle(home,{revision:1,bundle:bundle()},['pi']);
   const receipt=readFileSync(join(home,'.agents','.platform-skills','applied.json'),'utf8');
   expect(await installMissingAgentSkills(home,bundle('changed'),['pi'])).toMatchObject({installed:[],skipped:['fixture']});
   expect(readFileSync(join(home,'.agents','.platform-skills','applied.json'),'utf8')).toBe(receipt);
   expect(readFileSync(join(home,'.pi','agent','skills','fixture','SKILL.md'),'utf8')).toBe('original');
  }finally{rmSync(home,{recursive:true,force:true});}
 });
 it('publishes all native roots without executing scripts, idempotently upgrades, fences revisions and removes only owned links',async()=>{
  const home=mkdtempSync(join(realpathSync(tmpdir()),'agent-skills-'));
  try{
   mkdirSync(join(home,'.codex','skills','user-owned'),{recursive:true});writeFileSync(join(home,'.codex','skills','user-owned','SKILL.md'),'personal');
   const agents=Object.keys(agentSkillRoots),one=bundle();
   expect(await applyAgentSkillBundle(home,{revision:1,bundle:one},agents)).toMatchObject({applied:true,revision:1,digest:one.digest});
   for(const root of Object.values(agentSkillRoots))expect(readFileSync(join(home,root,'fixture','SKILL.md'),'utf8')).toBe('original');
   expect(await applyAgentSkillBundle(home,{revision:1,bundle:one},agents)).toMatchObject({applied:true});
   await expect(applyAgentSkillBundle(home,{revision:1,bundle:bundle('changed')},agents)).rejects.toThrow('版本');
   await applyAgentSkillBundle(home,{revision:2,bundle:bundle('changed')},agents);
   expect(readFileSync(join(home,'.codex','skills','fixture','SKILL.md'),'utf8')).toBe('changed');
   await expect(applyAgentSkillBundle(home,{revision:1,bundle:one},agents)).rejects.toThrow('版本');
   await applyAgentSkillBundle(home,{revision:3,bundle:empty()},agents);
   expect(existsSync(join(home,'.codex','skills','fixture'))).toBe(false);
   expect(readFileSync(join(home,'.codex','skills','user-owned','SKILL.md'),'utf8')).toBe('personal');
  }finally{rmSync(home,{recursive:true,force:true});}
 });
 it('refuses collisions before changing current or any existing user files',async()=>{
  const home=mkdtempSync(join(realpathSync(tmpdir()),'skill-collision-'));
  try{
   mkdirSync(join(home,'.claude','skills','fixture'),{recursive:true});writeFileSync(join(home,'.claude','skills','fixture','SKILL.md'),'personal');
   await expect(applyAgentSkillBundle(home,{revision:1,bundle:bundle()},['codex','claude-code'])).rejects.toThrow('同名');
   expect(existsSync(join(home,'.codex','skills','fixture'))).toBe(false);
   expect(readFileSync(join(home,'.claude','skills','fixture','SKILL.md'),'utf8')).toBe('personal');
  }finally{rmSync(home,{recursive:true,force:true});}
 });
 it('refuses symlinked destinations and tampered releases (including extra files)',async()=>{
  const home=mkdtempSync(join(realpathSync(tmpdir()),'skill-links-'));
  try{
   mkdirSync(join(home,'outside'));mkdirSync(join(home,'.codex'));symlinkSync(join(home,'outside'),join(home,'.codex','skills'));
   await expect(applyAgentSkillBundle(home,{revision:1,bundle:bundle()},['codex'])).rejects.toThrow('符号链接');
   await applyAgentSkillBundle(home,{revision:1,bundle:bundle()},['pi']);
   const current=join(home,'.agents','.platform-skills','current'),release=join(home,'.agents','.platform-skills',readlinkSync(current));
   writeFileSync(join(release,'extra'),'unexpected');
   await expect(applyAgentSkillBundle(home,{revision:1,bundle:bundle()},['pi'])).rejects.toThrow('被修改');
  }finally{rmSync(home,{recursive:true,force:true});}
 });
 it('validates path traversal, digest, limits, file/dir conflicts, reserved skills and native support',async()=>{
  for(const path of ['../secret','/secret','a/../../secret','a\\b','a\0b','a//b']){const b=bundle();b.skills[0].files[1].path=path;b.digest=skillBundleDigest(b.skills);expect(()=>validateAgentSkillBundle(b)).toThrow('路径');}
  const bad=bundle();bad.digest='a'.repeat(64);expect(()=>validateAgentSkillBundle(bad)).toThrow('摘要');
  const huge=bundle();huge.skills[0].files[0].content=Buffer.alloc(4*1024*1024+1).toString('base64');expect(()=>validateAgentSkillBundle(huge)).toThrow('限制');
  const collision=bundle();collision.skills[0].files.push({path:'scripts',content:'',executable:false});expect(()=>validateAgentSkillBundle(collision)).toThrow('冲突');
  const reserved=bundle();reserved.skills[0].name='botmux-send';expect(()=>validateAgentSkillBundle(reserved)).toThrow('名称');
  await expect(applyAgentSkillBundle('/unused',{revision:1,bundle:bundle()},['dsh'])).rejects.toThrow('不支持');
 });
 it('reuses native safe snapshots, expands packs, preserves executable bits, refuses missing and linked sources',()=>{
  const home=mkdtempSync(join(realpathSync(tmpdir()),'skill-export-'));
  try{
   const store=join(home,'store'),root=join(store,'fixture');mkdirSync(join(root,'scripts'),{recursive:true});
   writeFileSync(join(root,'SKILL.md'),'---\nname: fixture\nversion: 2\n---\n# Fixture');writeFileSync(join(root,'scripts','ok.sh'),'#!/bin/sh\necho OK\n');chmodSync(join(root,'scripts','ok.sh'),0o700);
   const pkg=loadSkillPackage(root,{source:{type:'local-copy',originalPath:'/not-distributed'}}),registry={fixture:pkg};
   const trust={storeDir:store,pluginsDir:join(home,'plugins'),sessionDataDir:join(home,'sessions'),botsDirs:[],workingDir:join(home,'workspace'),botmuxRoots:[],protectedPaths:[]};
   const options={registry,trust,dataDir:join(home,'exports'),packs:{group:{id:'group',name:'Group',revision:1,include:['skill:fixture' as const],createdAt:'',updatedAt:''}}};
   const result=buildAgentSkillBundle(['pack:group','skill:fixture'],options);
   expect(result.skills).toHaveLength(1);expect(result.skills[0].files.find(f=>f.path==='scripts/ok.sh')?.executable).toBe(true);
   expect(JSON.stringify(result)).not.toContain('/not-distributed');
   expect(()=>buildAgentSkillBundle(['skill:missing'],options)).toThrow('未安装');
   expect(()=>buildAgentSkillBundle(['pack:missing'],options)).toThrow('删除');
   expect(()=>buildAgentSkillBundle(['skill:fixture'],{...options,registry:{fixture:{...pkg,source:{type:'local-link',path:root}}}})).toThrow('副本');
   symlinkSync('/etc/passwd',join(root,'unsafe'));
   expect(()=>buildAgentSkillBundle(['skill:fixture'],options)).toThrow('完整');
  }finally{rmSync(home,{recursive:true,force:true});}
 });
});
