import {describe,it,expect,afterEach,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {birthRun} from '../src/workflows/v3/grill-state.js';
import {hostSpecFinalize,hostApproveSpec} from '../src/workflows/v3/host.js';
import {workflowStatus,workflowArtifacts,exportWorkflowArtifacts,workflowLogs,cloneWorkflow,workflowDiff} from '../src/workflows/v3/operations.js';
import {appendEvent} from '../src/workflows/v3/journal.js';
import {validateRequiredPaths,checkInputPaths} from '../src/platform/workflow/input-preflight.js';
import {materialize,writeState} from '../src/workflows/v3/state.js';
const folders:string[]=[];afterEach(()=>{for(const f of folders.splice(0))rmSync(f,{recursive:true,force:true});vi.unstubAllEnvs();});
function fixture(){const baseDir=mkdtempSync(join(tmpdir(),'workflow-ops-'));folders.push(baseDir);const run=birthRun({baseDir,goal:'Analyze repository',runId:'run-ops'});return {baseDir,...run};}
it('creates a valid editable spec scaffold and surfaces authoring next actions',()=>{
 const f=fixture();expect(existsSync(join(f.runDir,'spec.md'))).toBe(true);expect(existsSync(join(f.runDir,'spec.json'))).toBe(false);
 expect(workflowStatus(f.runId,f.baseDir)).toMatchObject({runStatus:'grilling',nextAction:expect.stringContaining('spec-finalize')});expect(hostSpecFinalize(f.runDir).ok).toBe(true);hostApproveSpec(f.runDir);
 expect(workflowStatus(f.runId,f.baseDir).authoringApprovals[0]).toMatchObject({type:'specConfirmed',byKind:'agent'});
});
it('exports only verified manifest files, supports repeated export, keeps source lineage and logs',async()=>{
 const f=fixture(),attempt='analyze#001/attempts/001',dir=join(f.runDir,attempt),work=join(dir,'work');mkdirSync(work,{recursive:true});
 const data=Buffer.from('verified output'),sha256=createHash('sha256').update(data).digest('hex');writeFileSync(join(work,'report.md'),data);writeFileSync(join(dir,'stdout.log'),'first\nsecond\nthird');
 writeFileSync(join(dir,'manifest.json'),JSON.stringify({schemaVersion:1,status:'ok',summary:'done',files:[{name:'report',path:'report.md',kind:'text',bytes:data.length,sha256,mime:'text/markdown'}]}));
 appendEvent(join(f.runDir,'journal.ndjson'),{type:'runStarted',runId:f.runId});appendEvent(join(f.runDir,'journal.ndjson'),{type:'nodeDispatched',nodeId:'analyze',attemptId:attempt});appendEvent(join(f.runDir,'journal.ndjson'),{type:'nodeSucceeded',nodeId:'analyze',attemptId:attempt,manifestPath:join(dir,'manifest.json')});appendEvent(join(f.runDir,'journal.ndjson'),{type:'runSucceeded'});
 expect(workflowStatus(f.runId,f.baseDir).runStatus).toBe('succeeded');expect(workflowLogs(f.runId,'analyze',{baseDir:f.baseDir,tail:2})).toBe('second\nthird');
 const artifacts=await workflowArtifacts(f.runId,f.baseDir);expect(artifacts).toHaveLength(1);
 const destination=join(f.baseDir,'export');const exported=await exportWorkflowArtifacts(f.runId,destination,f.baseDir);expect(exported).toEqual(JSON.parse(readFileSync(join(destination,'manifest.json'),'utf8')).files);for(const file of exported){const bytes=readFileSync(join(destination,file.path));expect(bytes.length).toBe(file.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);}await expect(exportWorkflowArtifacts(f.runId,destination,f.baseDir)).resolves.toHaveLength(1);
 expect(JSON.parse(readFileSync(join(destination,'manifest.json'),'utf8')).files[0].path).toContain('report.md');expect(existsSync(join(destination,'stdout.log'))).toBe(false);
 const cloned=await cloneWorkflow(f.runId,{baseDir:f.baseDir});expect(cloned.lineage.parentRunId).toBe(f.runId);expect(workflowStatus(f.runId,f.baseDir).runStatus).toBe('succeeded');
 writeFileSync(join(work,'report.md'),'corrupted');await expect(workflowArtifacts(f.runId,f.baseDir)).rejects.toThrow();
});
it('rejects run traversal and symlink artifacts, and reports structured spec/DAG differences',()=>{
 const f=fixture();expect(()=>workflowStatus('../x',f.baseDir)).toThrow();const target=join(f.baseDir,'linked');symlinkSync(f.runDir,target);expect(()=>workflowStatus('linked',f.baseDir)).toThrow();
 hostSpecFinalize(f.runDir);writeFileSync(join(f.runDir,'dag.json'),JSON.stringify({nodes:[{id:'analyze',type:'goal',goal:'Changed goal',agentSelection:{candidateIds:[],requiredMountNames:['repos']}}]}));
 expect(workflowDiff(f.runId,f.baseDir)).toMatchObject({changedGoals:['analyze'],unmatchedCapabilities:['analyze']});
});
it('checks declared existing inputs without starting processes or escaping mounts',()=>{
 const f=fixture();writeFileSync(join(f.runDir,'input.txt'),'input');
 const paths=validateRequiredPaths([{mountName:'repos',path:'input.txt',kind:'file'},{mountName:'repos',path:'missing',kind:'directory'}]);
 const checks=checkInputPaths(paths,[{name:'repos',path:f.runDir}]);expect(checks[0].ok).toBe(true);expect(checks[1]).toMatchObject({ok:false,error:'input_missing'});
 expect(()=>validateRequiredPaths([{mountName:'repos',path:'../escape',kind:'file'}])).toThrow();symlinkSync(f.baseDir,join(f.runDir,'escape'));
 expect(checkInputPaths([{mountName:'repos',path:'escape',kind:'directory'}],[{name:'repos',path:f.runDir}])[0].error).toBe('path_outside_mount');
});
it('keeps resource audit in STATE without changing node execution semantics',()=>{
 const f=fixture(),events:any[]=[{type:'runStarted',runId:f.runId,ts:1},{type:'nodeResourceWaiting',nodeId:'analyze',attemptId:'a/001',jobId:'job',waitReason:'capacity',ts:2},{type:'nodeResourceAllocated',nodeId:'analyze',attemptId:'a/001',jobId:'job',runtime:{memberId:'member',queueMs:100,slot:0},ts:3}];
 const state=materialize(events);expect(state.nodes.size).toBe(0);expect(state.resources?.[0].runtime).toMatchObject({queueMs:100});writeState(join(f.runDir,'STATE'),state);expect(JSON.parse(readFileSync(join(f.runDir,'STATE'),'utf8')).resources[0].jobId).toBe('job');
});

it('validates upstream bytes before dispatch and supports retry of a pre-dispatch blocked attempt',async()=>{
 const {upstreamPreflight}=await import('../src/workflows/v3/upstream-preflight.js');
 const f=fixture(),attempt='analyze#001/attempts/001',dir=join(f.runDir,attempt),work=join(dir,'work');mkdirSync(work,{recursive:true});writeFileSync(join(work,'file.txt'),'first');
 const sha256=createHash('sha256').update('first').digest('hex');writeFileSync(join(dir,'manifest.json'),JSON.stringify({files:[{path:'file.txt',sha256,bytes:5}]}));
 const events:any[]=[{type:'nodeSucceeded',nodeId:'analyze',attemptId:attempt,manifestPath:join(dir,'manifest.json'),ts:1}];expect(()=>upstreamPreflight(f.runDir,[{path:join(work,'file.txt')}],events)).not.toThrow();writeFileSync(join(work,'file.txt'),'changed');expect(()=>upstreamPreflight(f.runDir,[{path:join(work,'file.txt')}],events)).toThrow('upstream_product_changed');
 appendEvent(join(f.runDir,'journal.ndjson'),{type:'runStarted',runId:f.runId});appendEvent(join(f.runDir,'journal.ndjson'),{type:'nodeBlocked',nodeId:'analyze',instanceId:'analyze#001',attemptId:attempt,errorClass:'artifactContractInvalid',errorCode:'INPUT_PREFLIGHT_FAILED'});appendEvent(join(f.runDir,'journal.ndjson'),{type:'runBlocked',blockedNodeId:'analyze'});
 expect(materialize((await import('../src/workflows/v3/journal.js')).readJournal(join(f.runDir,'journal.ndjson'))).blockedNodeId).toBe('analyze');
 // A legacy uncommitted test run has no authorization envelope; runtime retry
 // integrity is tested separately. The next attempt still advances from the blocked event.
 const {nextAttemptIdFor}=await import('../src/workflows/v3/shared-node-runtime.js');expect(nextAttemptIdFor([{type:'nodeBlocked',nodeId:'analyze',instanceId:'analyze#001',attemptId:attempt,errorClass:'artifactContractInvalid',ts:1}],'analyze#001')).toBe('analyze#001/attempts/002');
});
it('CLI help returns before feature gates, run identity or side effects',async()=>{
 const {cmdWorkflow}=await import('../src/cli/workflow.js');const {cmdWorkflowHost}=await import('../src/workflows/v3/host.js');
 const out=vi.spyOn(console,'log').mockImplementation(()=>{});vi.stubEnv('BOTMUX_WORKFLOW_ENABLED','false');
 try{await cmdWorkflow('new',['--help']);await cmdWorkflowHost('architect',['--help']);expect(out.mock.calls.join(' ')).toContain('Run operations');}finally{out.mockRestore();}
});

it('authoring status and artifacts do not initialize a remote journal from an unapproved DAG',async()=>{
 const f=fixture();writeFileSync(join(f.runDir,'dag.json'),JSON.stringify({runId:f.runId,nodes:[]}));
 const {configureJournalBackend}=await import('../src/workflows/v3/journal-backend.js');
 let invoked=false;configureJournalBackend(()=>{invoked=true;throw Error('must_not_register');});
 try{expect(workflowStatus(f.runId,f.baseDir).phase).toBe('authoring');expect(await workflowArtifacts(f.runId,f.baseDir)).toEqual([]);expect(invoked).toBe(false);}finally{configureJournalBackend(undefined);}
});

it('preflights selected outputs without reading unrelated missing products and rejects directories clearly',async()=>{
 const {upstreamPreflight}=await import('../src/workflows/v3/upstream-preflight.js');const f=fixture();const work=join(f.runDir,'a/001/work');mkdirSync(work,{recursive:true});writeFileSync(join(work,'good.txt'),'good');mkdirSync(join(work,'directory'));
 const manifestPath=join(work,'../manifest.json');writeFileSync(manifestPath,JSON.stringify({files:[{path:'unused.txt',kind:'text',bytes:0,sha256:''},{path:'good.txt',bytes:4,sha256:createHash('sha256').update('good').digest('hex')},{path:'directory',kind:'directory'}]}));
 const events:any[]=[{type:'nodeSucceeded',manifestPath}];expect(()=>upstreamPreflight(f.runDir,[{path:join(work,'good.txt')}],events)).not.toThrow();
 expect(()=>upstreamPreflight(f.runDir,[{path:join(work,'directory')}],events)).toThrow('upstream_directory_input_requires_archive');
 writeFileSync(join(work,'other.txt'),'other');expect(()=>upstreamPreflight(f.runDir,[{path:join(work,'other.txt')}],events)).toThrow('upstream_product_undeclared');
});
