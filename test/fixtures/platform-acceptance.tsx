// Browser smoke data only. Production components and styles render unchanged.
import {validateMcpConfig,publicMcpConfig,mergeMcpSecrets} from '../../src/platform/management/mcp-schema.js';
import {clearManagementCache} from '../../src/dashboard/web/platform/management-cache.js';
import {initIconTooltips} from '../../src/dashboard/web/icon-tooltip.js';
import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import {AgentsManagement} from '../../src/dashboard/web/platform/agents.js';
import {Configuration} from '../../src/dashboard/web/platform/configuration.js';
import {ui} from '../../src/dashboard/web/ui.js';
import '../../src/dashboard/web/design-tokens.css';
import '../../src/dashboard/web/style.css';
import '../../src/dashboard/web/platform/management.css';

initIconTooltips();
Object.assign(ui,{authed:true,platformManaged:true});
const agents=[['pi','Pi'],['codex','Codex'],['claude-code','Claude Code'],['zcode','ZCode']].map(([id,name])=>({id,name,supported:true,version:'fixture',authMethods:id==='pi'||id==='dsh'?['api-key']:['api-key','oauth'],protocols:id==='codex'?['openai-responses']:id==='claude-code'?['anthropic-messages','vercel-claude']:id==='zcode'?['zcode-coding-plan']:['openai-completions'],images:[{id:'dev',image:'dev-agent:fixture',label:'Dev'},{id:'native',image:`worker-agent:${id}-fixture`,label:'Worker'}]}));
const image={id:'sha256:'+'1'.repeat(64),tags:['dev-agent:fixture'],agents:agents.map(a=>a.id),roles:['worker','control'],size:2300000000,architecture:'arm64',os:'linux',created:1793145600};
const remote={key:'remote-fixture',id:'sha256:'+'2'.repeat(64),reference:'registry.example/team/worker-agent:pi-fixture',tag:'pi-fixture',registry:'registry.example/team',digest:'sha256:'+'3'.repeat(64),agents:['pi'],roles:['worker'],size:330000000,architecture:'arm64',os:'linux',created:'2026-10-28T00:00:00Z'};
const models=[{profileId:'fixture',displayName:'Fixture connection',provider:'fixture',baseUrl:'https://example.invalid',modelId:'fixture-one',modelIds:['fixture-one'],protocol:'openai-completions',authMethod:'api-key',apiKeyConfigured:true,enabled:true},
 {profileId:'vercel-fixture',displayName:'Vercel fixture',provider:'vercel',baseUrl:'https://ai-gateway.vercel.sh',modelId:'',modelIds:[],protocol:'vercel-claude',authMethod:'api-key',apiKeyConfigured:true,enabled:true},
 {profileId:'zcode-fixture',displayName:'ZCode fixture',provider:'zai',baseUrl:'https://api.z.ai',modelId:'',modelIds:[],protocol:'zcode-coding-plan',authMethod:'api-key',apiKeyConfigured:true,enabled:true}];
const instance={containerId:'fixture-dev',displayName:'Dev acceptance',agentType:'pi',image:image.id,imageLabel:'dev-agent:fixture',imageAgents:image.agents,sandboxId:'fixture-sandbox',authMethod:'api-key',modelProfileId:'fixture',modelName:'Fixture connection',modelId:'fixture-one',status:'ready',revision:1,appliedRevision:1,botId:null,botName:null,workspaceClaim:'fixture-workspace',stateClaim:'fixture-state',lastError:null,runtimeKind:'native-botmux',createdAt:'2026-10-28T00:00:00Z'};
const workspaces={hostPathEnabled:true,hostPathMode:'unrestricted',hostRoots:[],tenantHome:'/workspace',defaultHostPath:'/workspace',globalReadOnlyHostPath:'/fixture-global',workspaces:[{kind:'volume',source:'fixture-workspace',readOnly:false,useCount:1},{kind:'hostpath',source:'/fixture-review-workspace',readOnly:false,useCount:1}]};
const cache={images:[image],remote:[remote],sources:[],updatedAt:'2026-10-28T00:00:00Z',hostArch:'arm64'};
const responses:Record<string,unknown>={
 '/feishu-session':{session:{status:'missing'}},'/bots':{bots:[{botId:'cli_fixture',appId:'cli_fixture',displayName:'Fixture bot',usage:'local',ownerConfigured:true,localConfigured:true}]},'/models':{models},'/containers':{containers:[instance,{...instance,containerId:'fixture-worker',displayName:'Worker acceptance',imageAgents:['pi']}]},'/catalog':{agents},'/workspaces':workspaces,
 '/image-cache':cache,'/images':cache,'/proxies':{proxies:[{profileId:'direct',displayName:'Direct proxy',configuration:{mode:'global',url:'http://127.0.0.1:7890'},revision:1,enabled:true}]},
 '/credentials':{credentials:[{credentialId:'fixture',displayName:'Registry fixture',kind:'docker',endpoint:'registry.example',username:'fixture',revision:1},{credentialId:'github-fixture',displayName:'GitHub fixture',kind:'github',endpoint:'github.com',username:'fixture',revision:1}]},
 '/github-git-profiles':{profiles:[{profileId:'github-fixture',displayName:'GitHub fixture',gitName:'Fixture User',gitEmail:'fixture@example.invalid',credentialId:'github-fixture',githubAccount:'fixture',fingerprint:'SHA256:fixture',registrationState:'registered',revision:1}]},'/cli-logins/control':{logins:[],capabilities:{github:true,docker:true}},'/cli-logins/fixture-dev':{logins:[],capabilities:{github:true,docker:true}},'/cli-logins/fixture-worker':{logins:[],capabilities:{github:true,docker:false}},
 '/control-proxy':{revision:1,appliedRevision:1,proxyProfileId:null},'/control-upgrade':{currentImage:'dev-agent:fixture'},
 '/local-agent':{name:'Dev Agent',controlId:'fixture',agents:agents.map(a=>({agentType:a.id,revision:1,appliedRevision:1,authMethod:['codex','zcode'].includes(a.id)?'oauth':'api-key',requiresLogin:['codex','zcode'].includes(a.id),status:'synced',modelName:'Fixture',currentModel:'fixture-one',credentialPresent:true})),bots:[{appId:'cli_fixture',displayName:'Fixture bot',cliId:'pi'}]},
 '/browser-profiles':{profiles:[]},'/logins':{logins:[]},'/containers/fixture-dev/clis':{clis:agents.map((a,i)=>({agentType:a.id,active:i===0,configured:a.id!=='codex',authMethod:a.id==='zcode'?'oauth':'api-key',modelProfileId:i===0?'fixture':a.id==='claude-code'?'vercel-fixture':a.id==='zcode'?'zcode-fixture':null,modelName:i===0?'Fixture connection':a.id==='claude-code'?'Vercel fixture':a.id==='zcode'?'ZCode fixture':null,modelProtocol:a.id==='claude-code'?'vercel-claude':a.id==='zcode'?'zcode-coding-plan':null,modelId:i===0?'fixture-one':null,revision:1,appliedRevision:1}))},
};
const mcpRows:any[]=[{id:'11111111-2222-4333-8444-555555555555',revision:1,configuration:{name:'docs',displayName:'Shared docs',description:'Read docs',transport:'http',url:'https://fixture.invalid/mcp',env:{},headers:{},auth:{type:'none'},cliIds:agents.map(a=>a.id),options:{},secretKeys:[],secretsConfigured:[]}},{id:'66666666-7777-4888-8999-000000000000',revision:1,configuration:{name:'events',displayName:'Claude events',description:'CLI specific',transport:'sse',url:'https://fixture.invalid/sse',env:{},headers:{},auth:{type:'none'},cliIds:['claude-code'],options:{},secretKeys:[],secretsConfigured:[]}}];
const mcpSecrets=new Map<string,any>();
const mcpTargets:Record<string,any>={};responses['/mcp-servers']={servers:mcpRows};
const smoke={clearCache:clearManagementCache,failNextMcp:false,requests:[] as Array<{path:string;method:string;body:any}>,unknown:[] as string[],failNextCliLogin:false,data:responses,models,
 failNextPoolAction:false,unconfirmedNextPoolAction:false,holdNextPoolAction:false,releasePoolAction:(()=>{}) as ()=>void,holdDetailId:'',failNextPoolDetail:false,releaseDetails:(()=>{}) as ()=>void};
Object.assign(window,{platformSmoke:smoke});
const namedMountMode=new URLSearchParams(location.search).has('mounts');
const namedMounts:Array<{id:string;name:string;hostPath:string;revision:number}>=namedMountMode?[{id:'11111111-1111-4111-8111-111111111111',name:'default',hostPath:'/fixture-global',revision:1}]:[];
if(namedMountMode){Object.assign(workspaces,{globalReadOnlyMounts:namedMounts});(responses['/credentials'] as any).reportSettings={appId:'',userOpenId:'',folderToken:'',revision:0};}
const poolId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',otherPoolId='cccccccc-cccc-cccc-cccc-cccccccccccc';
const member={memberId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',poolId,containerId:'fixture-dev',displayName:'Pool coder',description:'Implement and test code',agentType:'pi',modelProfileId:'fixture',modelId:'fixture-one',cpu:4,memoryMiB:8192,taskCpu:1,taskMemoryMiB:2048,capacity:4,occupied:0,enabled:true,quarantined:false,configurationPending:false,revision:1,status:'ready',globalReadOnlyHostPath:null};
responses['/agent-pools']={pools:[{poolId,displayName:'Workspace pool',workspaceKind:'volume',workspaceSource:'fixture-workspace'},{poolId:otherPoolId,displayName:'Review pool',workspaceKind:'hostpath',workspaceSource:'/fixture-review-workspace'}]};
responses['/agent-pools/'+poolId]={members:[member,{...member,memberId:'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',containerId:'pending-container',displayName:'Pending coder',revision:3,status:'error',quarantined:true,configurationPending:true,configurationError:'Historical pending fixture'}]};
responses['/agent-pools/'+otherPoolId]={members:[{...member,memberId:'dddddddd-dddd-dddd-dddd-dddddddddddd',poolId:otherPoolId,containerId:'review-container',displayName:'Pool reviewer'}]};
responses['/workflow-resources']={jobs:[{jobId:'99999999-9999-9999-9999-999999999999',poolId,runId:'fixture-coding-run',attemptId:'coding-node',waitReason:'capacity',selection:{requirement:'Wait for coding capacity'}},{jobId:'ffffffff-ffff-ffff-ffff-ffffffffffff',poolId:otherPoolId,runId:'fixture-review-run',attemptId:'review-node',waitReason:'capability',selection:{requirement:'Review in the other shared workspace'}}]};
(responses['/containers'] as any).containers=[{...instance,poolId,poolMemberId:member.memberId},{...instance,containerId:'fixture-worker',displayName:'Worker acceptance',imageAgents:['pi'],poolId:null,poolMemberId:null},{...instance,containerId:'foreign-pool-agent',displayName:'Other pool reserved',imageAgents:['pi'],poolId:otherPoolId,poolMemberId:'dddddddd-dddd-dddd-dddd-dddddddddddd'},{...instance,containerId:'historical-marked-agent',displayName:'Historical member marker',imageAgents:['pi'],poolId:null,poolMemberId:'historical-marker'}];
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
responses['/control-workspace']={revision:0,status:null,actual:{containerId:'fixture-control',workspace:{kind:'volume',source:'fixture-workspace',readOnly:false,path:'/workspace'},hostMounts:[]}};
window.fetch=async(input,init)=>{
 const path=String(input).replace('/api/platform','');
 const method=init?.method??'GET';

 smoke.requests.push({path,method,body:init?.body?JSON.parse(String(init.body)):null});
 if(path==='/mcp-servers'||path.startsWith('/mcp-servers/')){
  const input=init?.body?JSON.parse(String(init.body)):{};
  const row=mcpRows.find(r=>r.id===path.split('/')[2]);
  if(method==='POST'||method==='PUT'&&row){try{
   const config=mergeMcpSecrets(validateMcpConfig(input.configuration),row?mcpSecrets.get(row.id):undefined,input.clearSecrets),id=row?.id??crypto.randomUUID();
   mcpSecrets.set(id,config);const saved={id,revision:(row?.revision??0)+1,configuration:publicMcpConfig(config)};
   if(row)Object.assign(row,saved);else mcpRows.push(saved);
  }catch{return reply({message:'Invalid MCP configuration'},400);}}
  if(method==='DELETE'&&row)mcpRows.splice(mcpRows.indexOf(row),1);
  return reply({servers:mcpRows},method==='POST'?201:200);
 }
 if(path.startsWith('/mcp-targets/')){
  const id=path.split('/')[2],data=mcpTargets[id]??={targetId:id,revision:0,serverIds:[],cliIds:id==='control'||id==='fixture-dev'?agents.map(a=>a.id):['pi']};
  if(method==='POST'){const input=JSON.parse(String(init?.body));if(!data.pendingRequestId)data.revision++;data.serverIds=input.serverIds;if(smoke.failNextMcp){smoke.failNextMcp=false;data.pendingRequestId=input.requestId;return reply({message:'Fixture MCP sync unconfirmed'},502);}delete data.pendingRequestId;return reply({applied:true,revision:data.revision});}
  return reply({...data,servers:mcpRows});
 }
 if(method==='GET'&&/^\/containers\/[^/]+\/clis$/.test(path)&&!responses[path]){const c=(responses['/containers'] as any).containers.find((c:any)=>c.containerId===path.split('/')[2]);if(c)return reply({clis:[{agentType:c.agentType,configured:true,active:true,revision:c.revision,appliedRevision:c.appliedRevision}]});}
 if(path==='/containers/fixture-dev'&&method==='PUT'){const row=(responses['/containers'] as any).containers.find((c:any)=>c.containerId==='fixture-dev');const input=JSON.parse(String(init?.body));Object.assign(row,input,{revision:row.revision+1,appliedRevision:row.revision+1});return reply({container:row});}
 if(path.startsWith('/containers/')&&method==='PUT'&&!path.includes('/clis')){const row=(responses['/containers'] as any).containers.find((c:any)=>c.containerId===path.split('/')[2]);if(row){const input=JSON.parse(String(init?.body));Object.assign(row,input,{revision:row.revision+1,appliedRevision:row.revision+1});return reply({container:row});}}
 if(path==='/control-proxy'&&method==='PUT'){const input=JSON.parse(String(init?.body));Object.assign(responses[path],input,{revision:input.revision+1,appliedRevision:input.revision+1});return reply({applied:true});}
 if(path.startsWith('/local-agent/bots/')&&method==='PUT'){const b=(responses['/local-agent'] as any).bots.find((b:any)=>b.appId===path.split('/')[3]);if(b)b.cliId=JSON.parse(String(init?.body)).cliId;return reply({changed:true});}
 if(path==='/containers'&&method==='POST'){const input=JSON.parse(String(init?.body));const c={...instance,...input,containerId:crypto.randomUUID()};(responses[path] as any).containers.push(c);return reply({container:c},201);}
 if(namedMountMode&&path.startsWith('/host-mounts')){
  const input=init?.body?JSON.parse(String(init.body)):{};
  if(method==='POST'){namedMounts.push({id:crypto.randomUUID(),name:input.name,hostPath:input.hostPath,revision:1});return reply({mounts:namedMounts},201);}
  const row=namedMounts.find(m=>m.id===path.split('/')[2]);if(method==='PUT'&&row){Object.assign(row,input,{revision:row.revision+1});return reply({mounts:namedMounts});}
  if(method==='DELETE'&&row){namedMounts.splice(namedMounts.indexOf(row),1);return reply({mounts:namedMounts});}
  return reply({mounts:namedMounts});
 }
 if(path==='/workspaces'&&method==='PUT'){const input=JSON.parse(String(init?.body));Object.assign(workspaces,{hostPathRoot:input.hostPathRoot,defaultHostPath:input.hostPathRoot,hostRoots:[input.hostPathRoot],hostPathMode:'restricted'});return reply(workspaces);}
 if(path==='/control-workspace'&&method==='POST'){Object.assign(responses[path],{status:'queued'});return reply({queued:true},202);}
 if(namedMountMode&&path==='/report-settings'&&method==='PUT'){const value=JSON.parse(String(init?.body));(responses['/credentials'] as any).reportSettings={...value,revision:value.revision+1};return reply((responses['/credentials'] as any).reportSettings);}
 if(method==='GET'&&/^\/agent-pools\/[^/]+$/.test(path)){
  const value=structuredClone(responses[path]);
  if(smoke.failNextPoolDetail){smoke.failNextPoolDetail=false;return reply({message:'Fixture pool detail unavailable'},503);}
  if(smoke.holdDetailId===path.split('/')[2]){await new Promise<void>(resolve=>{smoke.releaseDetails=resolve;});}
  if(value)return reply(value);
 }
 const poolRoute=path.match(/^\/agent-pools(?:\/([^/]+)(?:\/(members|enroll)(?:\/([^/]+)(?:\/(rebuild|reconcile|configuration|configuration\/cancel))?)?)?)?$/);
 const resourceRoute=path.match(/^\/workflow-resources\/([^/]+)\/([^/]+)\/(resolve|cancel)$/);
 if(method!=='GET'&&(poolRoute||resourceRoute)){
  const failed=smoke.failNextPoolAction,unconfirmed=smoke.unconfirmedNextPoolAction;smoke.failNextPoolAction=false;smoke.unconfirmedNextPoolAction=false;
  if(smoke.holdNextPoolAction){smoke.holdNextPoolAction=false;await new Promise<void>(resolve=>{smoke.releasePoolAction=resolve;});}
  if(failed)return reply({message:'Fixture pool action rejected'},409);
  const input=JSON.parse(String(init?.body||'{}'));
  const addMember=(id:string,value:any)=>{const created={...member,...value,poolId:id,memberId:crypto.randomUUID(),containerId:crypto.randomUUID(),revision:1,configurationPending:false,quarantined:false,status:'ready'};created.capacity=Math.min(Math.floor(created.cpu/created.taskCpu),Math.floor(created.memoryMiB/created.taskMemoryMiB));(responses['/agent-pools/'+id] as any).members.push(created);return created;};
  if(resourceRoute&&method==='POST'){
   const jobs=(responses['/workflow-resources'] as any).jobs,job=jobs.find((row:any)=>row.jobId===resourceRoute[2]&&row.runId===resourceRoute[1]);
   if(!job)return reply({message:'Fixture job not found'},404);
   if(resourceRoute[3]==='resolve'){
    if(input.memberId&&!(responses['/agent-pools/'+job.poolId] as any).members.some((row:any)=>row.memberId===input.memberId))return reply({message:'Wrong pool member'},409);
    if(input.create)addMember(job.poolId,input.create);
   }
   (responses['/workflow-resources'] as any).jobs=jobs.filter((row:any)=>row!==job);return reply({resolved:true});
  }
  if(poolRoute){
   const [,id,collection,memberId,operation]=poolRoute;
   if(!id&&method==='POST'){const created={poolId:crypto.randomUUID(),...input};(responses['/agent-pools'] as any).pools.push(created);responses['/agent-pools/'+created.poolId]={members:[]};return reply({pool:created},201);}
   const detail=responses['/agent-pools/'+id] as any;
   if(id&&!collection&&method==='DELETE'){if(detail?.members.length)return reply({message:'请先移出池内所有成员'},409);const pools=(responses['/agent-pools'] as any).pools;pools.splice(pools.findIndex((p:any)=>p.poolId===id),1);delete responses['/agent-pools/'+id];return reply({deleted:true,pools});}
   if(!detail)return reply({message:'Fixture pool not found'},404);
   if(!memberId&&method==='POST'&&collection==='members')return reply({member:addMember(id!,input)},201);
   if(!memberId&&method==='POST'&&collection==='enroll'){
    const container=(responses['/containers'] as any).containers.find((row:any)=>row.containerId===input.containerId);
    if(!container||container.poolId||container.poolMemberId)return reply({message:'Fixture already belongs to pool'},409);
    const created=addMember(id!,{...input,displayName:container.displayName});created.containerId=container.containerId;container.poolId=id;container.poolMemberId=created.memberId;return reply({members:detail.members},201);
   }
   const row=detail.members.find((item:any)=>item.memberId===memberId);
   if(!row)return reply({message:'Fixture member not found'},404);
   if(method==='DELETE'){detail.members=detail.members.filter((item:any)=>item!==row);return reply({members:detail.members});}
   if(method==='PUT'||method==='POST'&&operation==='rebuild'){
    if(operation==='rebuild'&&!input.confirmRestart)return reply({message:'Fixture rebuild requires confirmation'},400);
    Object.assign(row,input,{revision:row.revision+1});row.capacity=Math.min(Math.floor(row.cpu/row.taskCpu),Math.floor(row.memoryMiB/row.taskMemoryMiB));row.globalReadOnlyHostPath=input.mountGlobalReadOnly?workspaces.globalReadOnlyHostPath:null;return reply({members:detail.members});
   }
   if(method==='POST'&&operation){
    if(!unconfirmed)Object.assign(row,{configurationPending:false,quarantined:false,status:'ready',revision:row.revision+1,configurationError:null});
    return reply({members:detail.members,...(operation==='configuration/cancel'?{cancelled:!unconfirmed}:{})});
   }
  }
 }
 if(init?.method==='POST'&&path==='/containers/fixture-dev/clis/claude-code/activate'){
  const revision=JSON.parse(String(init.body)).revision;
  return new Response(JSON.stringify({clis:[{agentType:'claude-code',active:true,revision:revision+1,appliedRevision:revision+1}]}),{status:200,headers:{'content-type':'application/json'}});
 }
 if(init?.method==='POST'&&/^\/cli-logins\/(control|fixture-dev)\/(github|docker)$/.test(path)){
  const [, ,target,cli]=path.split('/'),input=JSON.parse(String(init.body));
  const failed=smoke.failNextCliLogin;smoke.failNextCliLogin=false;
  responses['/cli-logins/'+target]={logins:[{cli,desiredId:input.id,revision:input.revision+1,appliedRevision:failed?input.revision:input.revision+1,synced:!failed,verification:failed?'failed':'verified',...(failed?{lastError:'Fixture login rejected'}:{})}],capabilities:{github:true,docker:true}};
  return new Response(JSON.stringify(failed?{error:'cli_login_unconfirmed',message:'Fixture login rejected'}:{applied:true,verified:true}),{status:failed?502:200,headers:{'content-type':'application/json'}});
 }
 if(method==='GET'&&Object.hasOwn(responses,path))return new Response(JSON.stringify(responses[path]),{status:200,headers:{'content-type':'application/json'}});
 smoke.unknown.push(method+' '+path);
 return new Response(JSON.stringify({error:'unexpected_smoke_request',message:method+' '+path}),{status:500,headers:{'content-type':'application/json'}});
};
function Fixture(){const [hash,setHash]=useState(location.hash);useEffect(()=>{const update=()=>setHash(location.hash);window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);},[]);return hash.includes('platform-configuration')?<Configuration/>:<AgentsManagement/>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
