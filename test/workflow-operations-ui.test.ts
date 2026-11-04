import React from 'react';
import renderer,{act} from 'react-test-renderer';
import {it,expect,vi,afterEach} from 'vitest';
import {WorkflowOperations} from '../src/dashboard/web/v3-operations.js';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it('clears prior run data on HTTP failure and recovers operations and artifacts independently',async()=>{
 vi.useFakeTimers();let failOps=false,failFiles=false;
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  const files=url.endsWith('/artifacts');return {ok:files?!failFiles:!failOps,status:409,json:async()=>files?{files:[{key:'file',nodeId:'node',path:url,bytes:1,url}]}:{runStatus:'succeeded',reportDelivery:{status:'succeeded'},jobs:[{jobId:'job',attemptId:url,state:'closed'}]}};
 }));
 let component:renderer.ReactTestRenderer;
 await act(async()=>{component=renderer.create(React.createElement(WorkflowOperations,{runId:'run-a'}));});expect(JSON.stringify(component!.toJSON())).toContain('/run-a/');
 failOps=true;failFiles=true;await act(async()=>{component!.update(React.createElement(WorkflowOperations,{runId:'run-b'}));});
 let result=JSON.stringify(component!.toJSON());expect(result).not.toContain('/run-a/');expect(result).toContain('运行详情暂不可用');expect(result).toContain('产物列表暂不可用');
 failOps=false;await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});result=JSON.stringify(component!.toJSON());expect(result).toContain('/run-b/operations');expect(result).toContain('产物列表暂不可用');expect(result).not.toContain('/run-a/');
 failFiles=false;await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(JSON.stringify(component!.toJSON())).toContain('/run-b/artifacts');
 await act(async()=>component!.unmount());
});
it('完整展示执行行和产物，表格在独立可滚动区且只发读请求',async()=>{
 const fetcher=vi.fn(async(url:string)=>({ok:true,json:async()=>url.endsWith('/artifacts')?{files:[{key:'report',nodeId:'summarize',path:'report.md',bytes:100,url:'/download/report'}]}:{runStatus:'succeeded',reportDelivery:{status:'awaiting_configuration'},jobs:[{jobId:'a',attemptId:'a/001',state:'closed',runtime:{displayName:'First',agentType:'pi',modelId:'model',slot:0,queueMs:20}},{jobId:'b',attemptId:'b/001',state:'closed',runtime:{displayName:'Second',agentType:'codex',modelId:'model',slot:1,queueMs:30}}]}}));
 vi.stubGlobal('fetch',fetcher);let component:renderer.ReactTestRenderer;
 await act(async()=>{component=renderer.create(React.createElement(WorkflowOperations,{runId:'run'}));});
 const root=component!.root,table=root.findByProps({'aria-label':'执行与交付任务记录'});
 expect(table.findByType('tbody').findAllByType('tr')).toHaveLength(2);
 expect(table.parent?.props.tabIndex).toBe(0);expect(root.findAllByType('a').some(a=>a.props.href==='/download/report')).toBe(true);
 expect(fetcher.mock.calls.map(([url])=>url)).toEqual(expect.arrayContaining(['/api/v3/runs/run/operations','/api/v3/runs/run/artifacts']));
 await act(async()=>component!.unmount());
});
it('ignores responses from a previously selected run',async()=>{
 let release:(value:any)=>void=()=>{};
 vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('/run-a/')?new Promise(resolve=>{release=resolve;}):Promise.resolve({ok:true,json:async()=>url.endsWith('/artifacts')?{files:[]}:{runStatus:'running',jobs:[]}})));
 let component:renderer.ReactTestRenderer;await act(async()=>{component=renderer.create(React.createElement(WorkflowOperations,{runId:'run-a'}));});
 await act(async()=>component!.update(React.createElement(WorkflowOperations,{runId:'run-b'})));await act(async()=>release({ok:true,json:async()=>({runStatus:'OLD_RUN',jobs:[]})}));
 expect(JSON.stringify(component!.toJSON())).not.toContain('OLD_RUN');await act(async()=>component!.unmount());
});
