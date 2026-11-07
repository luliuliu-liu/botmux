import {it,expect,vi} from 'vitest';
import {saveInstanceConfiguration,saveLocalConfiguration} from '../src/dashboard/web/platform/configuration-save.js';
const initial={agentType:'codex',botId:'bot',proxyProfileId:'',workspaceKind:'volume',workspaceSource:'old',workspaceReadOnly:false,hostMountIds:[],mcpServerIds:['mcp'],modelChoice:'["profile","model"]'};
const base=()=>({initial,row:{containerId:'id',agentType:'codex',revision:4,botId:'bot',proxyProfileId:null,image:'same-image',authMethod:'api-key',modelProfileId:'profile',modelId:'model'},models:[],mcp:{revision:1,serverIds:['mcp']},clis:[{agentType:'codex',configured:true,revision:4},{agentType:'pi',configured:true,revision:2}]});
it('saves MCP, binding and the selected CLI then rebuilds mounts under the resulting revision',async()=>{
 const calls:any[]=[];const api=vi.fn(async(p,m,b)=>{calls.push([p,m,b]);if(p.startsWith('/mcp-targets'))return {applied:true};if(m==='PUT')return {container:{containerId:'id',status:'ready',appliedRevision:5,revision:5,agentType:'codex',botId:'bot',proxyProfileId:null}};if(p.endsWith('/activate'))return {clis:[{agentType:'pi',active:true,revision:2,appliedRevision:2}]};if(p==='/containers')return {containers:[{containerId:'id',revision:6,agentType:'pi',image:'same-image'}]};return {container:{status:'ready'}};});
 await saveInstanceConfiguration(api,base(),{...initial,agentType:'pi',workspaceSource:'new',confirmRestart:true},'request');
 expect(calls.map(x=>x[0])).toEqual(['/mcp-targets/id','/containers/id','/containers/id/clis/pi/activate','/containers','/containers/id/upgrade']);
 expect(calls[1][2]).not.toHaveProperty('modelProfileId');expect(calls.at(-1)[2]).toMatchObject({revision:6,image:'same-image',workspaceSource:'new',confirmRestart:true});
});
it('retries the frozen MCP request first and stops before changing binding on failed confirmation',async()=>{
 const b=base();(b.mcp as any).pendingRequestId='pending';const api=vi.fn(async()=>({applied:false}));
 await expect(saveInstanceConfiguration(api,b,initial,'new')).rejects.toThrow('MCP');expect(api).toHaveBeenCalledOnce();expect(api.mock.calls[0][2]).toMatchObject({requestId:'pending',serverIds:['mcp']});
});
it('preserves fixed single-CLI models and rejects mount confirmation before destruction',async()=>{
 const b=base();b.clis=[b.clis[0]];const api=vi.fn(async(p,m)=>p.startsWith('/mcp')?{applied:true}:{container:{containerId:'id',status:'ready',revision:5,appliedRevision:5,agentType:'codex'}});
 await expect(saveInstanceConfiguration(api,b,{...initial,workspaceSource:'new',confirmRestart:false},'request')).rejects.toThrow('确认');
 expect(api.mock.calls.some(c=>c[0].endsWith('/upgrade'))).toBe(false);expect(api).not.toHaveBeenCalled();
});
it('仅改挂载时跳过明确已同步且未变化的MCP、Proxy和Bot CLI',async()=>{
 const b:any={...base(),row:{bots:[{appId:'bot',cliId:'codex'}]},proxy:{revision:2,proxyProfileId:null,synchronized:true},controlWorkspace:{revision:1,actual:{containerId:'control'}}};b.mcp.synchronized=true;
 const api=vi.fn(async p=>p==='/mcp-targets/control'?b.mcp:p==='/control-proxy'?b.proxy:{queued:true});
 expect(await saveLocalConfiguration(api,b,{...initial,hostMountIds:['mount'],confirmRestart:true},'request')).toEqual({queued:true});
 expect(api.mock.calls.map(c=>[c[0],c[1]])).toEqual([['/mcp-targets/control',undefined],['/control-proxy',undefined],['/control-workspace','POST']]);
});
it('无变化保存只核对同步证据，不进行任何写入',async()=>{
 const b:any={...base(),row:{bots:[{appId:'bot',cliId:'codex'}]},proxy:{revision:2,proxyProfileId:null,synchronized:true},controlWorkspace:{}};b.mcp.synchronized=true;
 const api=vi.fn(async p=>p==='/mcp-targets/control'?b.mcp:b.proxy);
 expect(await saveLocalConfiguration(api,b,initial,'request')).toEqual({applied:true});expect(api.mock.calls.every(c=>c[1]===undefined)).toBe(true);
});
it('同步证据不足或当前配置修订改变不能跳过，保留pending冻结请求',async()=>{
 const b:any={...base(),row:{bots:[{appId:'bot',cliId:'codex'}]},proxy:{revision:2},controlWorkspace:{}};b.mcp.pendingRequestId='pending';
 const api=vi.fn(async(p,m)=>p.startsWith('/mcp')?{applied:true}:{applied:true});await saveLocalConfiguration(api,b,{...initial,mcpServerIds:['new']},'new');
 expect(api.mock.calls[0][2]).toMatchObject({requestId:'pending',serverIds:['mcp']});expect(api.mock.calls[1][1]).toBe('PUT');
 delete b.mcp.pendingRequestId;b.mcp.synchronized=true;api.mockClear();api.mockImplementation(async()=>({...b.mcp,revision:3}));
 await expect(saveLocalConfiguration(api,b,initial,'request')).rejects.toThrow('已变化');expect(api.mock.calls).toHaveLength(1);
});
it('本地漂移或同ID修订使同步证据变为false时，仍执行确认步骤',async()=>{
 const b:any={...base(),row:{bots:[{appId:'bot',cliId:'codex'}]},proxy:{revision:2,proxyProfileId:null,synchronized:true},controlWorkspace:{}};b.mcp.synchronized=true;
 const api=vi.fn(async(p,m)=>m==='POST'||m==='PUT'?{applied:true}:p==='/mcp-targets/control'?{...b.mcp,synchronized:false}:{...b.proxy,synchronized:false});
 await saveLocalConfiguration(api,b,initial,'request');expect(api.mock.calls.map(c=>c[1])).toEqual([undefined,'POST',undefined,'PUT']);
});
it('明确挂载noop为成功，不假报排队或重做已确认步骤',async()=>{
 const b:any={...base(),row:{bots:[]},proxy:{revision:0},controlWorkspace:{revision:1,actual:{containerId:'control'}}};
 const api=vi.fn(async p=>p==='/control-workspace'?{noop:true,queued:false}:{applied:true});expect(await saveLocalConfiguration(api,b,{...initial,botId:'',hostMountIds:['mount'],confirmRestart:true},'request')).toEqual({applied:true,noop:true});
});
it('applies local MCP, proxy and selected Bot CLI, queues workspace rebuild last and retains other operations',async()=>{
 const b:any={...base(),row:{bots:[{appId:'bot',cliId:'codex'}]},proxy:{revision:2},controlWorkspace:{revision:1,actual:{containerId:'control'}}};
 const api=vi.fn(async p=>p.startsWith('/mcp')?{applied:true}:p==='/control-proxy'?{applied:true}:p.startsWith('/local-agent')?{changed:true}:{queued:true});
 expect(await saveLocalConfiguration(api,b,{...initial,agentType:'pi',hostMountIds:['mount'],confirmRestart:true},'request')).toEqual({queued:true});
 expect(api.mock.calls.map(c=>c[0])).toEqual(['/mcp-targets/control','/control-proxy','/local-agent/bots/bot','/control-workspace']);
 expect(api.mock.calls[2][2]).toMatchObject({cliId:'pi',confirmRestart:true});
});
it.each([['codex','native-model'],['zcode',null]] as const)('单CLI %s只改OAuth模型原地保存，不重建或重绑Bot',async(agentType,expectedModel)=>{
 const b:any=base();b.initial={...initial,agentType};b.row={...b.row,agentType};b.clis=[{agentType,configured:true,revision:4}];
 const api=vi.fn(async(p,m,body)=>p.startsWith('/mcp-targets')?{applied:true}:{container:{...b.row,...body,status:'ready',revision:5,appliedRevision:5,sandboxId:'existing-sandbox'}});
 const result=await saveInstanceConfiguration(api,b,{...b.initial,modelChoice:'[null,null]',oauthModelId:'  native-model  '},'request');
 expect(result).toEqual({applied:true});expect(api.mock.calls.map(c=>[c[0],c[1]])).toEqual([['/mcp-targets/id','POST'],['/containers/id','PUT']]);
 expect(api.mock.calls[1][2]).toMatchObject({modelProfileId:null,modelId:expectedModel,authMethod:'oauth'});expect(api.mock.calls[1][2]).not.toHaveProperty('botId');
});
it('普通保存只有在认证、模型、Bot、Proxy和递增修订全部回读一致时才成功',async()=>{
 const b:any=base();b.clis=[b.clis[0]];
 for(const patch of [{authMethod:'oauth'},{modelProfileId:'other'},{modelId:'other'},{botId:null},{proxyProfileId:'other'},{revision:4,appliedRevision:4},{containerId:'other'}]){
  const api=vi.fn(async(p,_m,body)=>p.startsWith('/mcp-targets')?{applied:true}:{container:{...b.row,...body,status:'ready',revision:5,appliedRevision:5,...patch}});
  await expect(saveInstanceConfiguration(api,b,initial,'request')).rejects.toThrow('实例未确认生效');
 }
});
it('OAuth默认模型清空为null，切回API Key不受旧OAuth输入影响',async()=>{
 const b:any=base();b.clis=[b.clis[0]];const api=vi.fn(async(p,_m,body)=>p.startsWith('/mcp-targets')?{applied:true}:{container:{...b.row,...body,status:'ready',revision:5,appliedRevision:5}});
 await saveInstanceConfiguration(api,b,{...initial,modelChoice:'[null,null]',oauthModelId:'   '},'request');expect(api.mock.calls[1][2]).toMatchObject({modelProfileId:null,modelId:null,authMethod:'oauth'});
 api.mockClear();await saveInstanceConfiguration(api,b,{...initial,modelChoice:'["profile","api-model"]',oauthModelId:'stale-native-model'},'request');expect(api.mock.calls[1][2]).toMatchObject({modelProfileId:'profile',modelId:'api-model',authMethod:'api-key'});expect(api.mock.calls).toHaveLength(2);
});
