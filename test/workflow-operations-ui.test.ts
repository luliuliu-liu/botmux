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
it('ignores responses from a previously selected run',async()=>{
 let release:(value:any)=>void=()=>{};
 vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('/run-a/')?new Promise(resolve=>{release=resolve;}):Promise.resolve({ok:true,json:async()=>url.endsWith('/artifacts')?{files:[]}:{runStatus:'running',jobs:[]}})));
 let component:renderer.ReactTestRenderer;await act(async()=>{component=renderer.create(React.createElement(WorkflowOperations,{runId:'run-a'}));});
 await act(async()=>component!.update(React.createElement(WorkflowOperations,{runId:'run-b'})));await act(async()=>release({ok:true,json:async()=>({runStatus:'OLD_RUN',jobs:[]})}));
 expect(JSON.stringify(component!.toJSON())).not.toContain('OLD_RUN');await act(async()=>component!.unmount());
});
