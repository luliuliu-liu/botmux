import {it,expect,vi} from 'vitest';
import {saveInstanceConfiguration,saveLocalConfiguration} from '../src/dashboard/web/platform/configuration-save.js';
const initial={agentType:'codex',botId:'bot',proxyProfileId:'',workspaceKind:'volume',workspaceSource:'old',workspaceReadOnly:false,hostMountIds:[],mcpServerIds:['mcp'],modelChoice:'["profile","model"]'};
const base=()=>({initial,row:{containerId:'id',agentType:'codex',revision:4,botId:'bot',image:'same-image'},mcp:{revision:1,serverIds:['mcp']},clis:[{agentType:'codex',configured:true,revision:4},{agentType:'pi',configured:true,revision:2}]});
it('saves MCP, binding and the selected CLI then rebuilds mounts under the resulting revision',async()=>{
 const calls:any[]=[];const api=vi.fn(async(p,m,b)=>{calls.push([p,m,b]);if(p.startsWith('/mcp-targets'))return {applied:true};if(m==='PUT')return {container:{containerId:'id',status:'ready',appliedRevision:5,revision:5,agentType:'codex'}};if(p.endsWith('/activate'))return {clis:[{agentType:'pi',active:true,revision:2,appliedRevision:2}]};if(p==='/containers')return {containers:[{containerId:'id',revision:6,agentType:'pi',image:'same-image'}]};return {container:{status:'ready'}};});
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
it('applies local MCP, proxy and selected Bot CLI, queues workspace rebuild last and retains other operations',async()=>{
 const b:any={...base(),row:{bots:[{appId:'bot',cliId:'codex'}]},proxy:{revision:2},controlWorkspace:{revision:1,actual:{containerId:'control'}}};
 const api=vi.fn(async p=>p.startsWith('/mcp')?{applied:true}:p==='/control-proxy'?{applied:true}:p.startsWith('/local-agent')?{changed:true}:{queued:true});
 expect(await saveLocalConfiguration(api,b,{...initial,agentType:'pi',hostMountIds:['mount'],confirmRestart:true},'request')).toEqual({queued:true});
 expect(api.mock.calls.map(c=>c[0])).toEqual(['/mcp-targets/control','/control-proxy','/local-agent/bots/bot','/control-workspace']);
 expect(api.mock.calls[2][2]).toMatchObject({cliId:'pi',confirmRestart:true});
});
