import {join,dirname} from 'node:path';
import {lstat,realpath,readFile,mkdir,rm} from 'node:fs/promises';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import {withFileLock} from '../../utils/file-lock.js';
import type {RetentionArchiveRow} from './archive-contract.js';
/** 只处理已被权威后端清理的单个运行缓存；不触碰共享工作区、凭据或其它run。 */
export async function cleanupArchivedRunCache(runsDir:string,row:RetentionArchiveRow){
 if(row.state!=='compacted'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.runId))throw Error('archive_cache_cleanup_unconfirmed');
 const parent=dirname(runsDir),platform=join(parent,'platform');
 const p=await lstat(parent);if(!p.isDirectory()||p.isSymbolicLink()||await realpath(parent)!==parent)throw Error('unsafe_archive_cache_parent');
 await mkdir(platform,{recursive:true,mode:0o700});const platformStat=await lstat(platform);if(!platformStat.isDirectory()||platformStat.isSymbolicLink())throw Error('unsafe_archive_cache_index');
 return withFileLock(join(platform,'workflow-archive-index-operation'),async()=>{
  const index=join(platform,'workflow-archive-index.json');let rows:any[]=[];
  try{const info=await lstat(index);if(!info.isFile()||info.isSymbolicLink())throw Error('unsafe_archive_cache_index');const value=JSON.parse(await readFile(index,'utf8'));if(value.schema!=='botmux-workflow-archive-index-v1'||!Array.isArray(value.rows))throw Error('invalid_archive_cache_index');rows=value.rows;}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const compacted={runId:row.runId,revision:row.revision,state:row.state,archiveHash:row.archiveHash,summary:row.summary,files:row.files};
  atomicWriteFileSync(index,JSON.stringify({schema:'botmux-workflow-archive-index-v1',rows:[...rows.filter(r=>r.runId!==row.runId),compacted]}),{mode:0o600,durable:true,followTargetSymlink:false});
  const target=join(runsDir,row.runId);let present=false;
  try{const root=await lstat(runsDir);if(!root.isDirectory()||root.isSymbolicLink()||await realpath(runsDir)!==runsDir)throw Error('unsafe_run_cache_root');const st=await lstat(target);if(!st.isDirectory()||st.isSymbolicLink())throw Error('unsafe_run_cache_target');present=true;}catch(e:any){if(e.code!=='ENOENT')throw e;}
  if(present)await rm(target,{recursive:true});
  return {localCacheCleanup:true,alreadyAbsent:!present};
 });
}
