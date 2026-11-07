import {closeSync,constants,fstatSync,openSync,readSync,statSync} from 'node:fs';
import {projectRelativePath} from './project-workspace.js';
import {posix} from 'node:path';

/** Linux bind挂载的项目文件按目录fd逐段打开，不在realpath检查后用可被替换的路径open。 */
export function readProjectFile(root:string,relativePath:string,maxBytes=4*1024*1024):Buffer {
 if(process.platform!=='linux')throw Error('anchored_project_io_requires_linux');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>4*1024*1024)throw Error('invalid_project_input_limit');
 const parts=projectRelativePath(relativePath).split('/');const handles:number[]=[];
 try{
  if(!posix.isAbsolute(root)||posix.normalize(root)!==root||root.includes('\0')||root.includes('\\'))throw Error('invalid_project_root');
  let directory=openSync('/',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(directory);
  for(const segment of root.split('/').filter(Boolean)){
   directory=openSync('/proc/self/fd/'+directory+'/'+segment,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(directory);
  }
  const base=directory;
  for(const segment of parts.slice(0,-1)){
   const fd=openSync('/proc/self/fd/'+directory+'/'+segment,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(fd);directory=fd;
  }
  const fd=openSync('/proc/self/fd/'+directory+'/'+parts.at(-1),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);handles.push(fd);
  const file=fstatSync(fd);if(!file.isFile()||file.size>maxBytes||file.nlink!==1)throw Error('project_input_not_regular_or_too_large');
  const openedRoot=fstatSync(base),currentRoot=statSync(root);if(openedRoot.dev!==currentRoot.dev||openedRoot.ino!==currentRoot.ino)throw Error('project_root_changed');
  const bytes=Buffer.alloc(maxBytes+1);let count=0;
  while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
  if(count>maxBytes)throw Error('project_input_too_large');return bytes.subarray(0,count);
 }finally{for(const fd of handles.reverse())closeSync(fd);}
}
