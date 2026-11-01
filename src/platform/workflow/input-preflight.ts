import {accessSync,constants,lstatSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import type {RequiredInputPath} from './input-path-schema.js';
export {validateRequiredPaths,type RequiredInputPath} from './input-path-schema.js';
export function checkInputPaths(paths:RequiredInputPath[],mounts:Array<{name:string;path:string}>,workspace='/workspace'){
 return paths.map(input=>{const root=input.mountName==='workspace'?workspace:mounts.find(m=>m.name===input.mountName)?.path;
  if(!root)return {...input,ok:false,error:'mount_missing'};
  try{const canonical=realpathSync(root),path=realpathSync(resolve(root,input.path)),rel=relative(canonical,path);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))return {...input,ok:false,error:'path_outside_mount'};
   const stat=lstatSync(path);if(input.kind==='directory'?!stat.isDirectory():!stat.isFile())return {...input,ok:false,error:'input_kind_mismatch'};accessSync(path,constants.R_OK|(input.kind==='directory'?constants.X_OK:0));return {...input,ok:true};
  }catch(e){return {...input,ok:false,error:(e as NodeJS.ErrnoException).code==='EACCES'?'input_unreadable':'input_missing'};}
 });
}
