import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {cleanupArchivedRunCache} from '../src/platform/workflow/local-archive-cache.js';
it('仅清理后端已确认的指定run缓存，先持久标记，不跟随工作区软链',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'archive-cache-'))),runs=join(root,'.botmux/v3-runs');
 try{
  await mkdir(join(runs,'old'),{recursive:true});await mkdir(join(runs,'other'));await writeFile(join(runs,'other/keep'),'other');await mkdir(join(root,'workspace'));await writeFile(join(root,'workspace/keep'),'workspace');await symlink(join(root,'workspace'),join(runs,'old/workspace-link'));
  const row={runId:'old',state:'compacted',revision:2,files:[],summary:null,archiveHash:'a'.repeat(64)} as any;
  expect(await cleanupArchivedRunCache(runs,row)).toMatchObject({localCacheCleanup:true});
  await expect(stat(join(runs,'old'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(join(root,'workspace/keep'),'utf8')).toBe('workspace');expect(await readFile(join(runs,'other/keep'),'utf8')).toBe('other');
  expect(JSON.parse(await readFile(join(root,'.botmux/platform/workflow-archive-index.json'),'utf8')).rows[0]).toMatchObject({runId:'old',state:'compacted'});
  expect(await cleanupArchivedRunCache(runs,row)).toMatchObject({alreadyAbsent:true});
  await expect(cleanupArchivedRunCache(runs,{...row,state:'live'})).rejects.toThrow('unconfirmed');
 }finally{await rm(root,{recursive:true,force:true});}
});
