import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import type {StoredEvent} from './event-contract.js';
function inside(root:string,path:string){const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}
/** Validate only referenced file products immediately before resource admission.
 * Directory products require an archive for the remote transport contract. */
export function upstreamPreflight(runDir:string,inputs:Array<{path:string}>,events:StoredEvent[]){
 const root=realpathSync(runDir);
 const selected=inputs.map(input=>{
  const path=resolve(input.path),real=realpathSync(path),stat=lstatSync(path);
  if(!inside(root,real)||stat.isSymbolicLink())throw Error('upstream_input_unsafe');
  if(!stat.isFile())throw Error('upstream_directory_input_requires_archive');
  return {path,real};
 });
 const manifests=new Set(events.filter(e=>e.type==='nodeSucceeded').map(e=>(e as Extract<StoredEvent,{type:'nodeSucceeded'}>).manifestPath));
 for(const manifest of manifests){
  const lexical=resolve(runDir,manifest),work=resolve(dirname(lexical),'work');
  const needed=selected.filter(i=>i.path.startsWith(work+sep));if(!needed.length)continue;
  if(lstatSync(lexical).isSymbolicLink())throw Error('upstream_manifest_unsafe');
  const path=realpathSync(lexical);if(!inside(root,path))throw Error('upstream_manifest_outside_run');
  const m=JSON.parse(readFileSync(path,'utf8'));
  for(const input of needed){
   const file=(m.files??[]).find((f:{path:string})=>resolve(work,f.path)===input.path);
   if(!file)throw Error('upstream_product_undeclared');
   if(file.kind==='directory')throw Error('upstream_directory_input_requires_archive');
   const data=readFileSync(input.real);
   if(data.length!==file.bytes||createHash('sha256').update(data).digest('hex')!==file.sha256)throw Error('upstream_product_changed');
  }
 }
}
