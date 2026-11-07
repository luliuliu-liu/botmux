import {homedir} from 'node:os';
import {containerRole} from '../management/container-role.js';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,mkdirSync,realpathSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,sep,delimiter} from 'node:path';

export const CONVENTIONS_VERSION=1;
export const CONVENTIONS_ROOT='/opt/agent/skills/workflow-conventions';
export type ConventionRole='interactive'|'workflow-node'|'workflow-architect';
export function conventionDigest(root=CONVENTIONS_ROOT):string|undefined{
 if(!existsSync(join(root,'manifest.json')))return undefined;const m=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));return createHash('sha256').update(JSON.stringify(m.skills)).digest('hex');
}
export function conventionRootForDigest(digest:string|undefined,root=CONVENTIONS_ROOT){
 if(!digest||digest===conventionDigest(root))return root;
 if(!/^[a-f0-9]{64}$/.test(digest))throw Error('invalid_conventions_digest');
 const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
 if(!manifest.previousDigests?.includes(digest))throw Error('workflow_conventions_digest_changed');
 const historical=join(root,'history',digest);if(conventionDigest(historical)!==digest)throw Error('workflow_conventions_digest_changed');return historical;
}
const roles:Record<ConventionRole,string[]>={interactive:['agent-env'],'workflow-node':['agent-env','workflow-node'],'workflow-architect':['agent-env','workflow-architect']};
export function conventionPrompt(role:ConventionRole,root=CONVENTIONS_ROOT,required=false):string{
 if(!existsSync(root)){if(required)throw Error('workflow_conventions_unavailable');return '';}
 const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
 if(manifest.schema!=='workflow-conventions-v1'||manifest.version!==CONVENTIONS_VERSION)throw Error('workflow_conventions_version_mismatch');
 const texts=roles[role].map(name=>{const path=join(root,'skills',name,'SKILL.md'),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('unsafe_convention_skill');const text=readFileSync(path,'utf8');if(createHash('sha256').update(text).digest('hex')!==manifest.skills[name])throw Error('workflow_conventions_digest_mismatch');return text;});
 return ['Managed runtime role: '+role,'Workflow conventions bundle v'+CONVENTIONS_VERSION,...texts].join('\n\n');
}
export function interactiveConventionPrompt(){if(process.env.BOTMUX_RUNTIME_ROLE||process.env.BOTMUX_WORKFLOW==='1')return '';
 let publishing='';
 if(containerRole()==='control'){try{const path=join(homedir(),'.botmux/platform/report-publishing-context.json'),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error();const c=JSON.parse(readFileSync(path,'utf8'));publishing='Control report publishing context (data, no secrets): '+JSON.stringify({appId:c.appId,userOpenId:c.userOpenId,folderToken:c.folderToken,larkCliDataDir:c.larkCliDataDir,revision:c.revision});}catch{publishing='Control report publishing context is not ready. Keep report delivery pending and request configuration; do not guess an account or folder.';}}
 const control=containerRole()==='control';
 const workflow=control?'Control Workflow 执行边界：用户要求 Workflow Agent 池时，指 Botmux/ACP 的原生工作流，不是 CLI/SDK 同名 Workflow 工具或 agent(...)。按 botmux skill show botmux-workflow 操作；先确认真实 poolId，使用 botmux workflow new "<目标>" --pool <poolId>。不得以普通子 Agent 替代池 Worker，也不得自述替代真实 runId、节点任务/成员和终态记录。仅登记/待审批不能说已启动；没有对应账本不能说池任务完成。保留自然语言轻确认、需求确认与真人飞书 DAG 审批，不通过 Dashboard 草稿/编辑入口替代。Control workspace 是池工作区父级访问范围，Worker 只挂载所选池目录，禁止改挂载或沿用旧审批。普通编程任务仍可使用普通子 Agent，但不冒充托管池执行。':'';
 const delivery=control?'Workflow 建单时必须确认 Spec.deliveryMode。用户要求仅归档、不发布时设为 archive-only，并保留到 spec-finalize；不得只写在叙事或 nonGoals 中。仅归档时不请求发布身份、不创建飞书文档、不发送交付回帖。feishu-doc 才使用上面的报告发布上下文。':'';
 const context=process.env.BOTMUX_CONTROL_HOST_MOUNTS;return [conventionPrompt('interactive'),context?'Actual Control named read-only mounts (data): '+context:'',publishing,workflow,delivery].filter(Boolean).join('\n\n');}
function directory(path:string){
 const absolute=resolve(path);let current:string=sep;
 for(const part of absolute.split(sep).filter(Boolean)){current=join(current,part);if(existsSync(current)){const s=lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('unsafe_job_workspace');}else mkdirSync(current,{mode:0o700});}
 return realpathSync(absolute);
}
export function jobWorkspace(workspace:string,runId:string,jobId:string,env:NodeJS.ProcessEnv=process.env){
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)||!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(jobId))throw Error('invalid_job_workspace_identity');
 // The mount root may have a platform alias; refuse links below that trusted root.
 const root=realpathSync(workspace),run=join(root,runId),work=join(run,'jobs',jobId),shared=join(run,'shared');
 for(const path of [run,work,shared]){const rel=relative(root,path);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw Error('job_workspace_outside_root');directory(path);}
 const tools=directory(join(work,'.tools')),cache=directory(join(work,'.cache'));directory(join(tools,'bin'));
 return {work,shared,tools,env:{BOTMUX_JOB_WORK_DIR:work,BOTMUX_RUN_SHARED_DIR:shared,BOTMUX_JOB_TOOLS_DIR:tools,BOTMUX_RUNTIME_ROLE:'workflow-node',
  PATH:[join(tools,'bin'),join(tools,'pnpm'),env.PATH??''].join(delimiter),
  npm_config_prefix:tools,NPM_CONFIG_PREFIX:tools,PNPM_HOME:directory(join(tools,'pnpm')),BUN_INSTALL_BIN:join(tools,'bin'),BUN_INSTALL_GLOBAL_DIR:directory(join(tools,'bun')),
  UV_TOOL_BIN_DIR:join(tools,'bin'),UV_TOOL_DIR:directory(join(tools,'uv')),UV_CACHE_DIR:cache,UV_PYTHON_INSTALL_DIR:directory(join(tools,'python')),PIP_CACHE_DIR:cache,npm_config_cache:cache}};
}
