import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

describe('currentPoolCatalog',()=>{
 it('returns undefined outside a Control container without touching storage',()=>{
  writeIdentity();
  for(const role of ['worker',undefined] as const){mocks.role.mockReturnValue(role);expect(currentPoolCatalog(home)).toBeUndefined();}
  expect(mocks.request).not.toHaveBeenCalled();
 });
 it('fails closed when the Control workflow storage identity has not been bootstrapped',()=>{
  mocks.role.mockReturnValue('control');
  expect(()=>currentPoolCatalog(home)).toThrow('workflow_storage_bootstrap_not_ready');
  expect(mocks.request).not.toHaveBeenCalled();
 });
 it('reports a corrupt storage identity as not bootstrapped rather than a parse error',()=>{
  mocks.role.mockReturnValue('control');mkdirSync(join(home,'.botmux/platform'),{recursive:true});
  writeFileSync(join(home,'.botmux/platform/workflow-storage.json'),'{"baseUrl":');
  expect(()=>currentPoolCatalog(home)).toThrow('workflow_storage_bootstrap_not_ready');
  expect(mocks.request).not.toHaveBeenCalled();
 });
 it('posts /agent-pools with the stored identity and default workspace, returning only pool id and members',()=>{
  mocks.role.mockReturnValue('control');writeIdentity();
  const members=[{memberId:'m1'}];
  mocks.request.mockReturnValue({poolId:'pool-1',members,extra:'ignored'});
  expect(currentPoolCatalog(home)).toEqual({poolId:'pool-1',members});
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.request).toHaveBeenCalledWith({...identity,path:'/agent-pools',method:'POST',body:{workspaceKind:'volume',workspaceSource:'agent-workspace'}});
 });
 it('uses the workspace kind and claim from the environment',()=>{
  mocks.role.mockReturnValue('control');writeIdentity();
  vi.stubEnv('BOTMUX_WORKSPACE_KIND','hostpath');vi.stubEnv('BOTMUX_WORKSPACE_CLAIM','/tenant/project');
  mocks.request.mockReturnValue({poolId:'pool-2',members:[]});
  currentPoolCatalog(home);
  expect(mocks.request.mock.calls[0][0].body).toEqual({workspaceKind:'hostpath',workspaceSource:'/tenant/project'});
 });
 it('cannot let the stored identity override the request route or method',()=>{
  mocks.role.mockReturnValue('control');writeIdentity({...identity,path:'/runs/other',method:'DELETE'});
  mocks.request.mockReturnValue({poolId:'p',members:[]});
  currentPoolCatalog(home);
  expect(mocks.request.mock.calls[0][0]).toMatchObject({path:'/agent-pools',method:'POST'});
 });
 it('propagates storage request failures',()=>{
  mocks.role.mockReturnValue('control');writeIdentity();
  mocks.request.mockImplementation(()=>{throw new Error('storage_unreachable');});
  expect(()=>currentPoolCatalog(home)).toThrow('storage_unreachable');
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
