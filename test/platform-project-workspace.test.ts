import {afterEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,linkSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {readProjectFile} from '../src/platform/workflow/project-files.js';
import {launchStepRows} from '../src/dashboard/web/workflow-draft-model.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalJsonStringify} from '../src/utils/canonical-json.js';
import {controlProjectPath,parseProjectWorkspaceBinding,projectRelativePath,readProjectWorkspaceSelection,relativeFromControlProject,workerProjectPath,writeProjectWorkspaceSelection,type ProjectWorkspaceBinding} from '../src/platform/workflow/project-workspace.js';

const dirs:string[]=[];
const temp=()=>{const path=mkdtempSync(join(tmpdir(),'project-binding-'));dirs.push(path);return path;};
afterEach(()=>{for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true});});
function binding(project='project-a'):ProjectWorkspaceBinding{
 const value={schema:'workflow-project-workspace-v1' as const,poolId:'11111111-1111-4111-8111-111111111111',kind:'hostpath' as const,claim:'/data/agents/'+project,executionMode:'pool' as const,controlRelativeRoot:project,controlRoot:{kind:'hostpath' as const,claim:'/data/agents'},accessEvidence:{root:{realPath:'/data/agents',device:'1',inode:'2'},target:{realPath:'/data/agents/'+project,device:'1',inode:'3'}}};
 return {...value,bindingHash:createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')};
}
describe.runIf(process.platform==='linux')('Linux目录fd输入读取',()=>{
 it('读取普通文件，限制字节数并拒绝文件、目录和根祖先符号链接及硬链接',()=>{
  const base=temp(),root=join(base,'project');mkdirSync(root);mkdirSync(join(root,'src'));writeFileSync(join(root,'src/file'),'hello');
  expect(readProjectFile(root,'src/file').toString()).toBe('hello');
  expect(()=>readProjectFile(root,'src/file',4)).toThrow();
  symlinkSync('/etc/passwd',join(root,'file-link'));expect(()=>readProjectFile(root,'file-link')).toThrow();
  symlinkSync('/etc',join(root,'dir-link'));expect(()=>readProjectFile(root,'dir-link/passwd')).toThrow();
  symlinkSync(root,join(base,'alias'));expect(()=>readProjectFile(join(base,'alias','src'),'file')).toThrow();
  writeFileSync(join(base,'outside'),'secret');linkSync(join(base,'outside'),join(root,'hardlink'));expect(()=>readProjectFile(root,'hardlink')).toThrow();
 });
});

describe('审批步骤投影',()=>{
 it('展示托管审批等待与拒绝，非托管不增加审批步骤',()=>{
  const launch:any={nextStep:'approval',state:'paused',running:false,approval:{state:'pending'},chat:{},root:{}};
  expect(launchStepRows(launch).find(row=>row.key==='approval')?.status).toBe('waiting');
  expect(launchStepRows({...launch,approval:{state:'rejected'}}).find(row=>row.key==='approval')?.status).toBe('failed');
  expect(launchStepRows({...launch,nextStep:'migrate',approval:undefined}).some(row=>row.key==='approval')).toBe(false);
 });
});

describe('项目工作区冻结与映射',()=>{
 it('同一文件在Control和Worker下正确映射，兄弟目录不能混入',()=>{
  const selected=parseProjectWorkspaceBinding(binding());
  expect(controlProjectPath(selected,'src/file.txt')).toBe('/workspace/project-a/src/file.txt');
  expect(relativeFromControlProject(selected,'/workspace/project-a/src/file.txt')).toBe('src/file.txt');
  expect(workerProjectPath('src/file.txt')).toBe('/workspace/src/file.txt');
  for(const path of ['/workspace/project-ab/file.txt','/workspace/project-b/file.txt','/workspace/project-a/../secret'])expect(()=>relativeFromControlProject(selected,path)).toThrow();
 });
 it('拒绝绝对路径、上层目录、分隔符绕过与不匹配的证据摘要',()=>{
  for(const path of ['/etc/passwd','../secret','a/../secret','a//b','a\\b','a\0b'])expect(()=>projectRelativePath(path)).toThrow();
  expect(()=>parseProjectWorkspaceBinding({...binding(),poolId:'22222222-2222-4222-8222-222222222222'})).toThrow();
  expect(()=>parseProjectWorkspaceBinding({...binding(),controlRelativeRoot:'../project-a'})).toThrow();
 });
 it('持久选择可重试但不能切换项目，失败不覆盖原选择',()=>{
  const run=temp(),first=binding();writeProjectWorkspaceSelection(run,first);
  writeProjectWorkspaceSelection(run,first);
  expect(()=>writeProjectWorkspaceSelection(run,binding('project-b'))).toThrow('workflow_workspace_already_selected');
  expect(readProjectWorkspaceSelection(run)).toEqual(first);
 });
 it('选择文件不能是符号链接，也不能读取超限文件',()=>{
  const run=temp(),target=join(run,'target.json');writeFileSync(target,JSON.stringify(binding()));symlinkSync(target,join(run,'workspace.selection.json'));
  expect(()=>readProjectWorkspaceSelection(run)).toThrow('unsafe_workspace_selection');
  const large=temp();writeFileSync(join(large,'workspace.selection.json'),' '.repeat(16385));
  expect(()=>readProjectWorkspaceSelection(large)).toThrow('unsafe_workspace_selection');
 });
});
