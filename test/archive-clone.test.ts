import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {cloneArchivedWorkflow} from '../src/workflows/v3/operations.js';
import {assertWorkflowPrincipal} from '../src/workflows/v3/host.js';
import {readArchiveManifest} from '../src/platform/workflow/archive-clone.js';
import {PersistenceRequestError} from '../src/platform/workflow/sync-request.js';
afterEach(()=>vi.unstubAllEnvs());
it('归档克隆生成新ID和未审批草稿，保留deliveryMode，未知原caller不绕过',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'archive-clone-')));vi.stubEnv('SESSION_DATA_DIR','');vi.stubEnv('BOTMUX_SESSION_ID','');vi.stubEnv('BOTMUX_LARK_APP_ID','');vi.stubEnv('BOTMUX_CHAT_ID','');
 try{
  const manifest={schema:'acp-workflow-archive-v1',runId:'old-run',chatBinding:null,dag:{runId:'old-run',nodes:[]},spec:{schemaVersion:1,runId:'old-run',title:'Archive clone',requirement:'Only archive',deliveryMode:'archive-only',nodes:[{sketchId:'write',goal:'write',input_needs:[],expected_outputs:['report.md'],acceptance:'exists',risk_gate:false,unknowns:[]}]} } as any;
  const cloned=await cloneArchivedWorkflow(manifest,{baseDir:root});expect(cloned.runId).not.toBe('old-run');expect(cloned.state.status).not.toBe('dag_approved');
  expect(await readFile(join(cloned.runDir,'spec.md'),'utf8')).toContain('archive-only');expect(cloned.lineage.parentRunId).toBe('old-run');
  await expect(cloneArchivedWorkflow({...manifest,chatBinding:undefined},{baseDir:root})).rejects.toThrow('binding_unknown');
  await expect(cloneArchivedWorkflow({...manifest,chatBinding:{larkAppId:'bot',chatId:'chat',ownerOpenId:'ou_user'}},{baseDir:root})).rejects.toThrow('认证');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('live 兼容判断只认结构化未归档错误码，不认异常文案或吞掉其它失败',()=>{
 const identity={baseUrl:'http://fixture',token:'test',expiresAt:1e12};
 expect(readArchiveManifest('live',identity,()=>{throw new PersistenceRequestError(409,'archive_not_verified');})).toBeNull();
 expect(()=>readArchiveManifest('live',identity,()=>{throw new PersistenceRequestError(503,'archive_gateway_unavailable');})).toThrow('archive_gateway_unavailable');
 expect(()=>readArchiveManifest('live',identity,()=>{throw new PersistenceRequestError(409,'archive_hash_mismatch');})).toThrow('archive_hash_mismatch');
});
it('live 与归档共用精确app/chat/caller边界，不信静态owner替代本轮用户',()=>{
 const binding={larkAppId:'bot',chatId:'chat',ownerOpenId:'ou_user'};
 expect(()=>assertWorkflowPrincipal('old',binding,binding)).not.toThrow();
 for(const current of [undefined,{...binding,ownerOpenId:'other'},{...binding,chatId:'other'},{...binding,larkAppId:'other'}])expect(()=>assertWorkflowPrincipal('old',binding,current)).toThrow();
});
