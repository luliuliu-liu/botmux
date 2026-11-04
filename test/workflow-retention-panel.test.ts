import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
vi.mock('../src/dashboard/web/ui.js',()=>({ui:{platformManaged:true}}));
vi.mock('../src/dashboard/web/react-mount.js',()=>({mountReactPage:vi.fn()}));
import {ui} from '../src/dashboard/web/ui.js';
import {WorkflowRetentionPanel} from '../src/dashboard/web/workflow-retention.js';
import {clearManagementCache} from '../src/dashboard/web/platform/management-cache.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const capacity={schema:'workflow-capacity-v1',mode:'preview',readOnly:true,databaseWide:true,databaseTotalBytes:4096,generatedAt:'now',tables:[{name:'worker_execution',available:true,totalBytes:2048,heapBytes:1024,indexBytes:512,toastBytes:512,estimatedRows:7,estimatedDeadRows:2}]};
const preview={schema:'workflow-retention-preview-v1',mode:'preview',canExecute:false,archiveVerified:false,protectionEvidenceComplete:false,generatedAt:'now',scope:{controlId:'control',tenant:'default'},reviewItems:[{runId:'safe',status:'succeeded',canExecute:false,archiveVerified:false,protectionEvidenceComplete:false,ageDays:40,ageMatched:{logs:true,details:true,archive:false,summary:false},jobCountObserved:1,sampledColumnBytes:1024,protectionReasons:['protection_checks_unavailable']}],page:{hasMore:false,nextCursor:null},measurement:{complete:true}};
let renderer:TestRenderer.ReactTestRenderer|undefined,fetcher:ReturnType<typeof vi.fn>;
beforeEach(()=>{ui.platformManaged=true;fetcher=vi.fn(async(url:string)=>({ok:true,status:200,json:async()=>url.includes('/capacity')?capacity:preview}));vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{if(renderer)act(()=>renderer!.unmount());renderer=undefined;clearManagementCache();vi.unstubAllGlobals();});
async function mount(){await act(async()=>{renderer=TestRenderer.create(React.createElement(WorkflowRetentionPanel));});return renderer!;}
const refresh=(r:TestRenderer.ReactTestRenderer)=>r.root.findAllByType('button')[0].props.onClick();
it('普通Botmux不显示平台诊断，也不发请求',async()=>{ui.platformManaged=false;const r=await mount();expect(r.toJSON()).toBeNull();expect(fetcher).not.toHaveBeenCalled();});
it('查看、参数调整和分页仅GET，不保存参数或执行清理',async()=>{
 const r=await mount();expect(fetcher).not.toHaveBeenCalled();await act(async()=>refresh(r));
 expect(r.root.findAllByType('table')).toHaveLength(2);
 await act(async()=>r.root.findAllByType('input')[0].props.onChange({target:{value:'7'}}));expect(r.root.findAllByType('table')).toHaveLength(0);
 await act(async()=>refresh(r));
 expect(fetcher.mock.calls.some(([url])=>url.includes('successLogDays=7'))).toBe(true);
 for(const [,input] of fetcher.mock.calls){expect(input.method).toBe('GET');expect(input.body).toBeUndefined();}
 expect(r.root.findAllByType('button').length).toBeGreaterThanOrEqual(2);
});
it('失败清除旧容量和候选，旧服务不支持时显示错误而非零容量',async()=>{
 const r=await mount();await act(async()=>refresh(r));expect(r.root.findAllByType('table')).toHaveLength(2);
 fetcher.mockImplementation(async()=>({ok:false,status:404,json:async()=>({error:'not_found'})}));
 await act(async()=>refresh(r));expect(r.root.findAllByType('table')).toHaveLength(0);expect(r.root.findAllByProps({role:'alert'})).toHaveLength(1);
});
it('损坏响应或错误的可执行标记不被当作有效预览展示',async()=>{
 const r=await mount();fetcher.mockImplementation(async(url:string)=>({ok:true,status:200,json:async()=>url.includes('/capacity')?capacity:{...preview,canExecute:true}}));
 await act(async()=>refresh(r));expect(r.root.findAllByType('table')).toHaveLength(0);expect(r.root.findAllByProps({role:'alert'})).toHaveLength(1);
 fetcher.mockImplementation(async(url:string)=>({ok:true,status:200,json:async()=>url.includes('/capacity')?{...capacity,databaseTotalBytes:null}:preview}));
 await act(async()=>refresh(r));expect(r.root.findAllByType('table')).toHaveLength(0);
});
it('归档计划后才允许选择，压缩要求独立匹配 Run ID 与 Hash',async()=>{
 const row={runId:'archived',revision:3,state:'archive_verified',pinned:false,archiveHash:'a'.repeat(64),archiveVerifiedAt:'now',archiveBytes:10,lastError:null,summary:null,files:[],compactionReasons:[],canCompact:false,recommendedArchiveUntil:null};
 const plan={row:{...row,canCompact:true},files:[{key:'b'.repeat(64),nodeId:'report',attemptId:'a',path:'report.md',bytes:10,sha256:'c'.repeat(64),kind:'file',blob:'blob'}],canArchive:true,archiveReasons:[],notArchived:[],eligibleAt:'now'};
 fetcher.mockImplementation(async(url:string,init:any={})=>({ok:true,status:200,json:async()=>url.endsWith('/archives')?{schema:'acp-retention-archives-v1',automaticCleanup:false,rows:[row]}:url.endsWith('/plan')?plan:{...row,state:'compacted'}}));
 const r=await mount(),button=(text:string)=>r.root.findAllByType('button').find(b=>b.children.join('')===text)!;
 await act(async()=>button('刷新归档对象').props.onClick());expect(r.root.findByProps({'aria-label':'选择 archived'}).props.disabled).toBe(true);
 await act(async()=>button('查看具体计划').props.onClick());expect(r.root.findByProps({'aria-label':'选择 archived'}).props.disabled).toBe(false);expect(button('确认压缩').props.disabled).toBe(true);
 await act(async()=>r.root.findByProps({'aria-label':'确认 Run ID archived'}).props.onChange({target:{value:'archived'}}));await act(async()=>r.root.findByProps({'aria-label':'确认 Archive Hash archived'}).props.onChange({target:{value:'a'.repeat(64)}}));expect(button('确认压缩').props.disabled).toBe(false);
 await act(async()=>button('确认压缩').props.onClick());const compact=fetcher.mock.calls.find(([url])=>url.endsWith('/compact'));expect(JSON.parse(compact![1].body)).toMatchObject({revision:3,archiveHash:'a'.repeat(64),confirmCompact:true,confirmRunId:'archived'});
});
it('旧参数的慢响应不覆盖新的预览',async()=>{
 const pending:Array<(v:any)=>void>=[];
 fetcher.mockImplementation(()=>new Promise(resolve=>pending.push(resolve)));
 const r=await mount();await act(async()=>refresh(r));expect(pending).toHaveLength(2);
 await act(async()=>r.root.findAllByType('input')[0].props.onChange({target:{value:'7'}}));
 fetcher.mockImplementation(async(url:string)=>({ok:true,status:200,json:async()=>url.includes('/capacity')?capacity:{...preview,reviewItems:[]}}));
 await act(async()=>refresh(r));
 await act(async()=>{pending[0]({ok:true,status:200,json:async()=>capacity});pending[1]({ok:true,status:200,json:async()=>preview});});
 expect(r.root.findAllByType('code')).toHaveLength(0);
 expect(r.root.findAllByType('table')).toHaveLength(1);
});
