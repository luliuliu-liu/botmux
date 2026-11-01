import {it,expect,afterEach,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {birthRun,transition} from '../src/workflows/v3/grill-state.js';
import {hostSpecFinalize,hostApproveSpec,authorizeAdHocRun} from '../src/workflows/v3/host.js';
import {requestDagApproval,verifyDagApproval,handleAuthoringApproval,approvalCard} from '../src/workflows/v3/authoring-approval.js';
const dirs:string[]=[];afterEach(()=>{vi.unstubAllEnvs();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){vi.stubEnv('BOTMUX_PLATFORM_MANAGED','true');const baseDir=mkdtempSync(join(tmpdir(),'approval-ops-'));dirs.push(baseDir);const f=birthRun({baseDir,runId:'approval-run',goal:'Analysis',chatBinding:{larkAppId:'cli_fixture',chatId:'chat',ownerOpenId:'ou_user',rootMessageId:'message'}});hostSpecFinalize(f.runDir);hostApproveSpec(f.runDir);transition(f.runDir,'architect_running');const path=join(f.runDir,'dag.json');writeFileSync(path,JSON.stringify({schemaVersion:2,runId:f.runId,nodes:[{id:'analyze',type:'goal',goal:'Analyze',depends:[],inputs:[]}]}));transition(f.runDir,'dag_ready',{dagPath:path});return {...f,baseDir};}
it('requires authenticated initiating-user evidence and rejects stale hashes or wrong card',async()=>{
 const f=fixture(),r=requestDagApproval(f.runId,f.baseDir);expect(requestDagApproval(f.runId,f.baseDir).nonce).toBe(r.nonce);expect(approvalCard(r)).toContain(r.dagSha256);
 expect(()=>verifyDagApproval(f.runDir)).toThrow('dag_human_approval_required');expect(()=>authorizeAdHocRun(f.runDir,[])).toThrow('dag_human_approval_required');
 writeFileSync(join(f.runDir,'dag.approval.json'),JSON.stringify({...r,cardMessageId:'card'}));const deps={baseDir:f.baseDir,loadBots:()=>[],canResolve:()=>true};
 expect(await handleAuthoringApproval({runId:f.runId,nonce:r.nonce,action:'v3_authoring_approve'},'ou_other','card','cli_fixture',deps)).toMatchObject({toast:{type:'error'}});
 expect(await handleAuthoringApproval({runId:f.runId,nonce:r.nonce,action:'v3_authoring_approve'},'ou_user','wrong','cli_fixture',deps)).toMatchObject({toast:{type:'error'}});
 writeFileSync(join(f.runDir,'dag.json'),'changed');expect(await handleAuthoringApproval({runId:f.runId,nonce:r.nonce,action:'v3_authoring_approve'},'ou_user','card','cli_fixture',deps)).toMatchObject({toast:{type:'error',content:'approval_stale'}});
});
it('records rejection actor, message and hashes without creating an execution authorization',async()=>{
 const f=fixture(),r=requestDagApproval(f.runId,f.baseDir);writeFileSync(join(f.runDir,'dag.approval.json'),JSON.stringify({...r,cardMessageId:'card'}));
 const result=await handleAuthoringApproval({runId:f.runId,nonce:r.nonce,action:'v3_authoring_reject'},'ou_user','card','cli_fixture',{baseDir:f.baseDir,loadBots:()=>[],canResolve:()=>true});expect(result).toMatchObject({toast:{type:'success'}});
 const records=readFileSync(join(f.runDir,'authoring.audit.ndjson'),'utf8').trim().split('\n').map(v=>JSON.parse(v));expect(records.at(-1)).toMatchObject({type:'dagRejected',byKind:'user',actor:'ou_user',messageId:'card',dagSha256:r.dagSha256});
});

it('approves the exact DAG once from its trusted card and seals authorization',async()=>{
 const f=fixture(),r=requestDagApproval(f.runId,f.baseDir);writeFileSync(join(f.runDir,'dag.approval.json'),JSON.stringify({...r,cardMessageId:'card'}));
 const deps={baseDir:f.baseDir,loadBots:()=>[{larkAppId:'cli_fixture',name:'Fixture',cliId:'codex',workingDir:'/workspace',larkAppSecret:'fixture'}] as any,canResolve:()=>true};
 const value={runId:f.runId,nonce:r.nonce,action:'v3_authoring_approve'};
 expect(await handleAuthoringApproval(value,'ou_user','card','cli_fixture',deps)).toMatchObject({toast:{type:'success'}});expect(()=>verifyDagApproval(f.runDir)).not.toThrow();
 expect(await handleAuthoringApproval(value,'ou_user','card','cli_fixture',deps)).toMatchObject({toast:{type:'info'}});
 const audit=readFileSync(join(f.runDir,'authoring.audit.ndjson'),'utf8').trim().split('\n').map(v=>JSON.parse(v));expect(audit.filter(v=>v.type==='dagApproved')).toHaveLength(1);
});

it('accepts only the narrow signed approval-request body and no actor claims',async()=>{
 const {parseWorkflowDaemonMutationBody}=await import('../src/workflows/v3/daemon-ipc-body.js');
 expect(parseWorkflowDaemonMutationBody('start','{"authoringApproval":true}')).toMatchObject({ok:true,body:{value:{authoringApproval:true}}});
 expect(parseWorkflowDaemonMutationBody('start','{"authoringApproval":true,"by":"user"}').ok).toBe(false);expect(parseWorkflowDaemonMutationBody('start','{"authoringApproval":false}').ok).toBe(false);
});

it('shows added goals, nested loop goals and full input/output/gate details in human review',async()=>{
 const {workflowDiff}=await import('../src/workflows/v3/operations.js');const f=fixture();
 writeFileSync(join(f.runDir,'dag.json'),JSON.stringify({nodes:[{id:'added',type:'goal',goal:'ADDED_GOAL',inputs:[{from:'source',output:'report'}],humanGate:'confirm',outputs:{report:'report.md'}},{id:'loop',type:'loop',body:{nodes:[{id:'inner',type:'goal',goal:'INNER_GOAL',depends:['added']}]}}]}));
 const diff=workflowDiff(f.runId,f.baseDir);expect(diff.dagNodes.map((n:any)=>n.id)).toContain('loop/inner');
 const card=approvalCard({runId:f.runId,diff});for(const value of ['ADDED_GOAL','INNER_GOAL','report.md','humanGate','source'])expect(card).toContain(value);
 expect(()=>approvalCard({runId:f.runId,diff:{...diff,specRequirement:'x'.repeat(17000)}})).toThrow('approval_diff_too_large');
});
