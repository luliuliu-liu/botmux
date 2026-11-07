import {closeSync,constants,fstatSync,openSync,readSync} from 'node:fs';
import {join,isAbsolute,posix} from 'node:path';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import {createHash} from 'node:crypto';
import {withFileLockSync} from '../../utils/file-lock.js';
import {canonicalJsonStringify} from '../../utils/canonical-json.js';

export const WORKFLOW_WORKSPACE_SELECTION_FILE='workspace.selection.json';
export interface ProjectWorkspaceBinding {
 schema:'workflow-project-workspace-v1';poolId:string;kind:'volume'|'hostpath';claim:string;executionMode:'pool';
 controlRelativeRoot:string;controlRoot:{kind:'volume'|'hostpath';claim:string};
 accessEvidence:{sameClaim:true}|{root:{realPath:string;device:string;inode:string};target:{realPath:string;device:string;inode:string}};
 bindingHash:string;
}
export function projectRelativePath(value:unknown):string {
 if(typeof value!=='string'||!value||value.includes('\0')||value.includes('\\')||isAbsolute(value)||value.split('/').some(part=>part==='..'||part===''))throw Error('invalid_project_relative_path');
 const normalized=posix.normalize(value);if(normalized==='.'||normalized.startsWith('../'))throw Error('invalid_project_relative_path');return normalized;
}
export function parseProjectWorkspaceBinding(value:unknown):ProjectWorkspaceBinding {
 const v=value as ProjectWorkspaceBinding;
 if(!v||v.schema!=='workflow-project-workspace-v1'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).test(v.poolId)||!['volume','hostpath'].includes(v.kind)||typeof v.claim!=='string'||!v.claim||v.executionMode!=='pool'||!v.controlRoot||!['volume','hostpath'].includes(v.controlRoot.kind)||typeof v.controlRoot.claim!=='string'||!v.controlRoot.claim||typeof v.controlRelativeRoot!=='string'||!(/^[a-f0-9]{64}$/).test(v.bindingHash))throw Error('invalid_project_workspace_binding');
 if(v.controlRelativeRoot)projectRelativePath(v.controlRelativeRoot);
 if(v.controlRoot.kind!==v.kind)throw Error('invalid_project_workspace_binding');
 if(v.kind==='volume'){
  if(v.controlRelativeRoot!==''||v.claim!==v.controlRoot.claim||!v.accessEvidence||!('sameClaim' in v.accessEvidence)||v.accessEvidence.sameClaim!==true||Object.keys(v.accessEvidence).length!==1)throw Error('invalid_project_workspace_binding');
 }else{
  if(!v.accessEvidence||!('root' in v.accessEvidence))throw Error('invalid_project_workspace_binding');
  for(const id of [v.accessEvidence.root,v.accessEvidence.target])if(!id||typeof id.realPath!=='string'||!posix.isAbsolute(id.realPath)||id.realPath.includes('\0')||typeof id.device!=='string'||!/^[0-9]+$/.test(id.device)||typeof id.inode!=='string'||!/^[0-9]+$/.test(id.inode))throw Error('invalid_project_workspace_binding');
  if(v.accessEvidence.root.realPath!==v.controlRoot.claim||v.accessEvidence.target.realPath!==v.claim||posix.relative(v.controlRoot.claim,v.claim)!==v.controlRelativeRoot)throw Error('invalid_project_workspace_binding');
 }
 const {bindingHash,...identity}=v;
 if(createHash('sha256').update(canonicalJsonStringify(identity)).digest('hex')!==bindingHash)throw Error('invalid_project_workspace_binding');
 return v;
}
export function readProjectWorkspaceSelection(runDir:string):ProjectWorkspaceBinding|undefined {
 const path=join(runDir,WORKFLOW_WORKSPACE_SELECTION_FILE);
 let fd:number;
 try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw Error('unsafe_workspace_selection',{cause:error});}
 try{
  const stat=fstatSync(fd);if(!stat.isFile()||stat.size>16384)throw Error('unsafe_workspace_selection');
  const buffer=Buffer.alloc(16385);let count=0;
  while(count<buffer.length){const n=readSync(fd,buffer,count,buffer.length-count,null);if(!n)break;count+=n;}
  if(count>16384)throw Error('unsafe_workspace_selection');
  return parseProjectWorkspaceBinding(JSON.parse(buffer.subarray(0,count).toString('utf8')));
 }finally{closeSync(fd);}
}
export function writeProjectWorkspaceSelection(runDir:string,binding:ProjectWorkspaceBinding){
 const selected=parseProjectWorkspaceBinding(binding),path=join(runDir,WORKFLOW_WORKSPACE_SELECTION_FILE);
 return withFileLockSync(path,()=>{
  const previous=readProjectWorkspaceSelection(runDir);
  if(previous){if(canonicalJsonStringify(previous)!==canonicalJsonStringify(selected))throw Error('workflow_workspace_already_selected');return;}
  atomicWriteFileSync(path,JSON.stringify(selected),{mode:0o600,durable:true,followTargetSymlink:false});
 });
}
/** 结构化文件引用只携带项目相对路径；绝不直接复用Control的绝对路径。 */
export function controlProjectPath(binding:ProjectWorkspaceBinding,relativePath:string){return posix.join('/workspace',binding.controlRelativeRoot,projectRelativePath(relativePath));}
export function workerProjectPath(relativePath:string,workerRoot='/workspace'){return posix.join(workerRoot,projectRelativePath(relativePath));}
export function relativeFromControlProject(binding:ProjectWorkspaceBinding,value:string){
 if(!posix.isAbsolute(value)||value.includes('\0')||value.includes('\\'))throw Error('invalid_control_project_path');
 const root=posix.join('/workspace',binding.controlRelativeRoot),relative=posix.relative(root,value);return projectRelativePath(relative);
}
