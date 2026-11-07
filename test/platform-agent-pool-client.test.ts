import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJsonStringify} from '../src/utils/canonical-json.js';
import {writeProjectWorkspaceSelection,readProjectWorkspaceSelection,type ProjectWorkspaceBinding} from '../src/platform/workflow/project-workspace.js';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({role:vi.fn<()=>'control'|'worker'|undefined>(),request:vi.fn()}));
// The role is read from an immutable image file (/etc/botmux-platform-role) that tests cannot create.
vi.mock('../src/platform/management/container-role.js',()=>({containerRole:mocks.role}));
vi.mock('../src/platform/workflow/sync-request.js',()=>({requestPersistenceSync:mocks.request}));
import {currentPoolCatalog,workflowResourceRequest} from '../src/platform/workflow/agent-pool-client.js';

const identity={baseUrl:'http://storage.test',token:'scoped-token'};
let home:string;
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),'agent-pool-client-'));
 mocks.role.mockReset();mocks.request.mockReset();
 vi.stubEnv('BOTMUX_WORKSPACE_KIND','');vi.stubEnv('BOTMUX_WORKSPACE_CLAIM','');
});
afterEach(()=>{vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true});});
const writeIdentity=(value:unknown=identity)=>{mkdirSync(join(home,'.botmux/platform'),{recursive:true});writeFileSync(join(home,'.botmux/platform/workflow-storage.json'),JSON.stringify(value));};

const poolId='11111111-1111-4111-8111-111111111111';
function binding(claim='project-a'):ProjectWorkspaceBinding{
 const fields={schema:'workflow-project-workspace-v1' as const,poolId,kind:'volume' as const,claim,executionMode:'pool' as const,controlRelativeRoot:'',controlRoot:{kind:'volume' as const,claim},accessEvidence:{sameClaim:true as const}};
 return {...fields,bindingHash:createHash('sha256').update(canonicalJsonStringify(fields)).digest('hex')};
}
function selectedRun(){const run=join(home,'run');mkdirSync(run);writeProjectWorkspaceSelection(run,binding());return run;}
const servePool=(members:unknown[]=[])=>mocks.request.mockImplementation((request:any)=>request.path.endsWith('/workspace')?binding():{members});

describe('currentPoolCatalog',()=>{
 it('returns undefined outside a Control container without touching storage',()=>{
  writeIdentity();
  for(const role of ['worker',undefined] as const){mocks.role.mockReturnValue(role);expect(currentPoolCatalog(home)).toBeUndefined();}
  expect(mocks.request).not.toHaveBeenCalled();
 });
 it('fails closed when the Control workflow storage identity has not been bootstrapped',()=>{
  mocks.role.mockReturnValue('control');
  expect(()=>currentPoolCatalog(home,selectedRun())).toThrow('workflow_storage_bootstrap_not_ready');
  expect(mocks.request).not.toHaveBeenCalled();
 });
 it('reports a corrupt storage identity as not bootstrapped rather than a parse error',()=>{
  mocks.role.mockReturnValue('control');mkdirSync(join(home,'.botmux/platform'),{recursive:true});
  writeFileSync(join(home,'.botmux/platform/workflow-storage.json'),'{"baseUrl":');
  expect(()=>currentPoolCatalog(home,selectedRun())).toThrow('workflow_storage_bootstrap_not_ready');
  expect(mocks.request).not.toHaveBeenCalled();
 });
 it('只读取显式冻结池，重验工作区后读取成员，不自动创建默认池',()=>{
  mocks.role.mockReturnValue('control');writeIdentity();
  const members=[{memberId:'m1'}];servePool(members);
  expect(currentPoolCatalog(home,selectedRun())).toEqual({poolId,workspace:binding(),members});
  expect(mocks.request.mock.calls.map(([request])=>request)).toEqual([
   {...identity,path:`/agent-pools/${poolId}/workspace`,method:'GET'},
   {...identity,path:`/agent-pools/${poolId}`,method:'GET'},
  ]);
 });
 it('修改环境不能切换已经冻结的池或工作区',()=>{
  mocks.role.mockReturnValue('control');writeIdentity();const run=selectedRun();servePool();
  vi.stubEnv('BOTMUX_WORKSPACE_KIND','hostpath');vi.stubEnv('BOTMUX_WORKSPACE_CLAIM','/tenant/other');
  expect(currentPoolCatalog(home,run)?.workspace).toEqual(binding());
  expect(mocks.request.mock.calls.every(([request])=>request.method==='GET'&&request.path.includes(poolId))).toBe(true);
 });
 it('存储身份不能覆盖只读请求的路径和方法',()=>{
  mocks.role.mockReturnValue('control');writeIdentity({...identity,path:'/runs/other',method:'DELETE'});servePool();
  currentPoolCatalog(home,selectedRun());
  expect(mocks.request.mock.calls[0][0]).toMatchObject({path:`/agent-pools/${poolId}/workspace`,method:'GET'});
 });
 it('传播实时工作区读取失败，不降级到默认池',()=>{
  mocks.role.mockReturnValue('control');writeIdentity();
  mocks.request.mockImplementation(()=>{throw new Error('storage_unreachable');});
  expect(()=>currentPoolCatalog(home,selectedRun())).toThrow('storage_unreachable');
 });
 it('缺少显式选择时拒绝，实时绑定变化时不读取成员或改写原选择',()=>{
  mocks.role.mockReturnValue('control');writeIdentity();
  expect(()=>currentPoolCatalog(home)).toThrow('workflow_pool_selection_required');expect(mocks.request).not.toHaveBeenCalled();
  const run=selectedRun();mocks.request.mockReturnValue(binding('project-b'));
  expect(()=>currentPoolCatalog(home,run)).toThrow('workflow_workspace_binding_changed');
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(readProjectWorkspaceSelection(run)).toEqual(binding());
 });
});

describe('workflowResourceRequest',()=>{
 const runIdentity={...identity,runId:'run-42'};
 beforeEach(()=>writeFileSync(join(home,'journal.api.json'),JSON.stringify(runIdentity)));
 it('GETs the run resource collection by default without a body',()=>{
  mocks.request.mockReturnValue({jobs:[]});
  expect(workflowResourceRequest(home)).toEqual({jobs:[]});
  const input=mocks.request.mock.calls[0][0];
  expect(input).toEqual({...runIdentity,path:'/runs/run-42/resources',method:'GET'});
  expect('body' in input).toBe(false);
 });
 it('appends the suffix and forwards method and body',()=>{
  mocks.request.mockReturnValue({ok:true});
  const job='11111111-1111-1111-1111-111111111111';
  workflowResourceRequest(home,`/${job}/resolve`,'POST',{memberId:'m1'});
  expect(mocks.request).toHaveBeenCalledWith({...runIdentity,path:`/runs/run-42/resources/${job}/resolve`,method:'POST',body:{memberId:'m1'}});
 });
 it('forwards falsy-but-defined bodies',()=>{
  mocks.request.mockReturnValue({});
  workflowResourceRequest(home,'','POST',null);
  expect(mocks.request.mock.calls[0][0]).toHaveProperty('body',null);
 });
 it('throws when the run journal identity is missing',()=>{
  rmSync(join(home,'journal.api.json'));
  expect(()=>workflowResourceRequest(home)).toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
 });
});

describe('controlRuntime',()=>{
 const record=(value:unknown)=>{mkdirSync(join(home,'.botmux/platform'),{recursive:true});writeFileSync(join(home,'.botmux/platform/control-runtime.json'),JSON.stringify(value));};
 it('uses the entrypoint record when a CLI pane lost the BOTMUX_* environment',async()=>{
  const {controlRuntime}=await import('../src/platform/workflow/agent-pool-client.js');
  record({role:'control',workspaceKind:'hostpath',workspaceClaim:'/srv/work'});
  expect(controlRuntime(home,{},{role:()=>'worker',imageRole:()=>'dev'})).toEqual({workspaceKind:'hostpath',workspaceClaim:'/srv/work'});
 });
 it('never treats a Worker-only image or a missing record as Control',async()=>{
  const {controlRuntime}=await import('../src/platform/workflow/agent-pool-client.js');
  expect(controlRuntime(home,{},{role:()=>'worker',imageRole:()=>'dev'})).toBeUndefined();
  record({role:'control',workspaceKind:'hostpath',workspaceClaim:'/srv/work'});
  expect(controlRuntime(home,{},{role:()=>'worker',imageRole:()=>'worker'})).toBeUndefined();
 });
 it('prefers live environment values over the record',async()=>{
  const {controlRuntime}=await import('../src/platform/workflow/agent-pool-client.js');
  record({role:'control',workspaceKind:'hostpath',workspaceClaim:'/srv/old'});
  expect(controlRuntime(home,{BOTMUX_WORKSPACE_KIND:'volume',BOTMUX_WORKSPACE_CLAIM:'shared'},{role:()=>'control',imageRole:()=>'dev'})).toEqual({workspaceKind:'volume',workspaceClaim:'shared'});
 });
});
