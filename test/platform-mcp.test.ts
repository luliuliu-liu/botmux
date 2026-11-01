import {it,expect,afterEach} from 'vitest';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'smol-toml';
import {validateMcpConfig,mcpTargets,publicMcpConfig,mergeMcpSecrets,importMcpJson,editableMcpConfig,MCP_API_KEY_VARIABLE} from '../src/platform/management/mcp-schema.js';
import {applyMcpBundle,mcpDigest,nativeMcpPath,nativeMcpValue,mergeNativeMcp} from '../src/platform/management/mcp-native.js';
const folders:string[]=[];afterEach(()=>{for(const f of folders.splice(0))rmSync(f,{recursive:true,force:true});});
const config=()=>validateMcpConfig({name:'repo',displayName:'Repository',transport:'stdio',command:'node',args:['server.js'],env:{API_KEY:'private-key'},headers:{},auth:{type:'none'}});
const bundle=(revision=1,servers:any[]=[{id:'server-id',revision:1,configuration:config()}])=>({schema:'platform-mcp-bundle-v1',revision,requestId:'request-'+revision,servers,digest:mcpDigest(servers)});
it('validates import, adapter capabilities, names and secret round trips',()=>{
 const c=config();expect(publicMcpConfig(c).env.API_KEY).toBe('');expect(publicMcpConfig(c).secretsConfigured).toContain('env.API_KEY');expect(mergeMcpSecrets({...c,env:{API_KEY:''}},c,[]).env.API_KEY).toBe('private-key');expect(mergeMcpSecrets({...c,env:{API_KEY:''}},c,['env.API_KEY']).env.API_KEY).toBe('');
 expect(()=>validateMcpConfig({...c,name:'botmux'})).toThrow();expect(()=>validateMcpConfig({...c,command:'node server.js'})).toThrow();expect(()=>validateMcpConfig({...c,args:'oops'})).toThrow();
 const sse=validateMcpConfig({name:'events',transport:'sse',url:'https://service/sse',auth:{type:'none'}});expect(mcpTargets(sse,['pi','codex','claude-code','zcode','dsh'])).toEqual(['claude-code','zcode']);expect(importMcpJson({mcpServers:{docs:{url:'https://service/mcp'}}})[0].name).toBe('docs');
});

it('keeps Header templates public, resolves an encrypted API Key for every CLI and never writes placeholders',()=>{
 const template='Bearer '+MCP_API_KEY_VARIABLE;
 const c=mergeMcpSecrets(validateMcpConfig({name:'template',transport:'http',url:'https://fixture/mcp',apiKey:'private-template-key',headers:{Authorization:template,'X-API-Key':MCP_API_KEY_VARIABLE,'X-Extra':'literal'}}),undefined,[]);
 const publicConfig=publicMcpConfig(c);expect(publicConfig.apiKey).toBe('');expect(publicConfig.headers.Authorization).toBe(template);expect(publicConfig.secretsConfigured).toContain('apiKey');
 const {secretsConfigured,...draft}=publicConfig;
 expect(mergeMcpSecrets(validateMcpConfig(draft),c,[]).apiKey).toBe(c.apiKey);
 for(const cli of ['pi','codex','claude-code','zcode','traex','dsh'] as const){const v=nativeMcpValue(c,cli),h=cli==='dsh'?v.config.headers:cli==='codex'||cli==='traex'?v.http_headers:v.headers;expect(h.Authorization).toBe('Bearer private-template-key');expect(h['X-API-Key']).toBe('private-template-key');expect(h['X-Extra']).toBe('literal');}
 expect(()=>mergeMcpSecrets(validateMcpConfig({...draft,headers:{Authorization:template},secretKeys:['apiKey'],apiKey:''}),undefined,[])).toThrow('mcp_api_key_required');
 expect(()=>nativeMcpValue(validateMcpConfig({...draft,apiKey:''}),'pi')).toThrow('mcp_api_key_required');
 expect(()=>mergeMcpSecrets(validateMcpConfig(draft),c,['apiKey'])).toThrow('mcp_api_key_required');
 expect(mergeMcpSecrets(validateMcpConfig({...draft,headers:{},secretKeys:['apiKey']}),c,['apiKey']).apiKey).toBe('');
 const legacy=validateMcpConfig({name:'legacy',transport:'http',url:'https://fixture/mcp',auth:{type:'bearer',token:'legacy-private'},headers:{}}),edit=editableMcpConfig(legacy);
 expect(mergeMcpSecrets(validateMcpConfig({...edit,apiKey:''}),legacy,[]).apiKey).toBe('legacy-private');
 expect(nativeMcpValue(legacy,'pi').headers.Authorization).toBe('Bearer legacy-private');
});
it.each(['pi','codex','claude-code','zcode','traex','dsh'] as const)('merges managed MCP into %s and deselects without touching hand-written entries',cli=>{
 const home=mkdtempSync(join(tmpdir(),'mcp-native-'));folders.push(home);const path=nativeMcpPath(home,cli);mkdirSync(join(path,'..'),{recursive:true});
 const manual={command:'node',args:['manual.js']};const raw=cli==='codex'||cli==='traex'?'# user comment\nmodel = "keep"\n[mcp_servers.manual]\ncommand = "node"\nargs = ["manual.js"]\n':cli==='zcode'?JSON.stringify({ui:{locale:'zh-CN'},mcp:{servers:{manual}}}):cli==='dsh'?JSON.stringify([{insert:[{id:'custom',name:'custom',config:{serverName:'manual'}}]}]):JSON.stringify({other:'keep',mcpServers:{manual}});writeFileSync(path,raw);
 applyMcpBundle(home,bundle(),[cli]);const after=readFileSync(path,'utf8');expect(after).toContain('manual');expect(after).toContain('repo');expect(applyMcpBundle(home,bundle(),[cli]).applied).toBe(true);
 applyMcpBundle(home,bundle(2,[]),[cli]);const removed=readFileSync(path,'utf8');expect(removed).toContain('manual');expect(removed).not.toContain('server.js');if(cli==='codex'||cli==='traex'){expect(parse(removed).model).toBe('keep');expect(removed).toContain('# user comment');}else if(cli==='zcode')expect(JSON.parse(removed).ui.locale).toBe('zh-CN');
});
it('refuses manual conflicts, modified managed entries and unsafe paths before changing files',()=>{
 const home=mkdtempSync(join(tmpdir(),'mcp-conflict-'));folders.push(home);const pi=nativeMcpPath(home,'pi'),codex=nativeMcpPath(home,'codex');mkdirSync(join(pi,'..'),{recursive:true});mkdirSync(join(codex,'..'),{recursive:true});writeFileSync(pi,'{}');writeFileSync(codex,'[mcp_servers.repo]\ncommand="manual"\n');expect(()=>applyMcpBundle(home,bundle(),['pi','codex'])).toThrow('manual_name_conflict');expect(readFileSync(pi,'utf8')).toBe('{}');
 writeFileSync(codex,'');applyMcpBundle(home,bundle(),['pi']);const c=JSON.parse(readFileSync(pi,'utf8'));c.mcpServers.repo.command='user-edit';writeFileSync(pi,JSON.stringify(c));expect(()=>applyMcpBundle(home,bundle(2,[]),['pi'])).toThrow('managed_entry_modified');
 const external=join(home,'external');mkdirSync(external);symlinkSync(join(external,'config.json'),join(home,'.claude.json'));expect(()=>applyMcpBundle(home,bundle(),['claude-code'])).toThrow('unsafe_mcp_file');
});
it('keeps botmux and unrelated TOML nested blocks intact',()=>{
 const raw='model="keep"\n[mcp_servers.botmux]\ncommand="botmux"\n[mcp_servers.repo]\ncommand="old"\n[mcp_servers.repo.env]\nKEY="value"\n[projects."/a"]\ntrust_level="trusted"\n';
 const result=mergeNativeMcp(raw,'codex',{repo:{command:'new'}},{repo:{command:'old',env:{KEY:'value'}}});expect(parse(result).mcp_servers).toEqual({botmux:{command:'botmux'},repo:{command:'new'}});expect((parse(result).projects as any)['/a'].trust_level).toBe('trusted');
});
it.each(['codex','traex'] as const)('preserves %s native tool settings across connection sync and restart while fencing connection edits',cli=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'mcp-native-tools-')));folders.push(home);applyMcpBundle(home,bundle(),[cli]);
 const path=nativeMcpPath(home,cli);writeFileSync(path,readFileSync(path,'utf8')+'\n[mcp_servers.repo.tools.lookup]\nenabled = false\n');
 applyMcpBundle(home,bundle(),[cli]);expect((parse(readFileSync(path,'utf8')).mcp_servers as any).repo.tools.lookup.enabled).toBe(false);
 const next=bundle(2,[{id:'server-id',revision:2,configuration:{...config(),args:['replacement.js']}}]);applyMcpBundle(home,next,[cli]);expect((parse(readFileSync(path,'utf8')).mcp_servers as any).repo.tools.lookup.enabled).toBe(false);
 writeFileSync(path,readFileSync(path,'utf8').replace('replacement.js','manual.js'));expect(()=>applyMcpBundle(home,bundle(3,[]),[cli])).toThrow('managed_entry_modified');
});

it('redacts dotted header keys and rejects unsupported import fields instead of dropping them',()=>{
 const c=validateMcpConfig({name:'headers',transport:'http',url:'https://fixture/mcp',headers:{'X.Api.Key':'sensitive'},auth:{type:'bearer',token:'private'}});
 expect(publicMcpConfig(c).headers['X.Api.Key']).toBe('********');expect(publicMcpConfig(c).auth.token).toBe('');
 expect(()=>importMcpJson({mcpServers:{bad:{command:'node',unknownOption:42}}})).toThrow('unsupported');
 expect(importMcpJson({name:'single',type:'stdio',command:'node'})[0].name).toBe('single');
 const oauth=validateMcpConfig({name:'oauth',transport:'http',url:'https://fixture/mcp',auth:{type:'oauth'}});
 expect(nativeMcpValue(oauth,'zcode').oauth).toEqual({type:'authorization_code'});
});
it('recovers interrupted writes, preserves manual edits and rejects stale bundles',()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'mcp-recover-')));folders.push(home);const path=nativeMcpPath(home,'pi');applyMcpBundle(home,bundle(),['pi']);
 const state=join(home,'.botmux/platform'),before=readFileSync(path,'utf8'),after=before.replace('server.js','new.js');
 const ledger=JSON.parse(readFileSync(join(state,'mcp-configuration.json'),'utf8'));ledger.entries.pi.repo.args=['new.js'];
 writeFileSync(join(state,'mcp-pending.json'),JSON.stringify({files:[{path,before,after}],ledger}));writeFileSync(path,after);
 applyMcpBundle(home,bundle(2,[]),['pi']);expect(readFileSync(path,'utf8')).not.toContain('new.js');
 expect(()=>applyMcpBundle(home,bundle(),['pi'])).toThrow('revision_conflict');
 writeFileSync(join(state,'mcp-pending.json'),JSON.stringify({files:[{path,before,after}],ledger}));writeFileSync(path,'{"manual":true}');
 expect(()=>applyMcpBundle(home,bundle(3,[]),['pi'])).toThrow('recovery_conflict');expect(readFileSync(path,'utf8')).toBe('{"manual":true}');
});

it('retains inactive CLI ownership across an image change so later deselection can remove only platform entries',()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'mcp-cli-change-')));folders.push(home);applyMcpBundle(home,bundle(),['pi','codex']);
 applyMcpBundle(home,bundle(2,[]),['pi']);expect(readFileSync(nativeMcpPath(home,'codex'),'utf8')).toContain('server.js');
 applyMcpBundle(home,bundle(3,[]),['pi','codex']);expect(readFileSync(nativeMcpPath(home,'codex'),'utf8')).not.toContain('server.js');
});

it('shows fixed Header masks, preserves unchanged masked values and saves custom authentication formats verbatim',()=>{
 const c=validateMcpConfig({name:'search',transport:'http',url:'https://fixture/mcp',headers:{Authorization:'Bearer private-key','X.Api.Key':'another-private-key'},auth:{type:'none'}});
 const masked=publicMcpConfig(c);
 expect(masked.headers).toEqual({Authorization:'Bearer ********','X.Api.Key':'********'});
 const {secretsConfigured,...draft}=masked;
 expect(mergeMcpSecrets(validateMcpConfig(draft),c,[]).headers).toEqual(c.headers);
 expect(mergeMcpSecrets(validateMcpConfig(draft),c,['headers.Authorization']).headers.Authorization).toBe('');
 expect(mergeMcpSecrets(validateMcpConfig({...draft,headers:{...draft.headers,Authorization:'Token custom-value'}}),c,[]).headers.Authorization).toBe('Token custom-value');
 expect(mergeMcpSecrets(validateMcpConfig({...draft,headers:{...draft.headers,Authorization:'raw-custom-value'}}),c,[]).headers.Authorization).toBe('raw-custom-value');
 expect(()=>mergeMcpSecrets(validateMcpConfig(draft),undefined,[])).toThrow('placeholder');
 expect(()=>mergeMcpSecrets(validateMcpConfig({...draft,headers:{...draft.headers,Authorization:'Basic ********'}}),c,[])).toThrow('placeholder');
 expect(publicMcpConfig(validateMcpConfig({...c,headers:{...c.headers,Authorization:'Basic private-key'}})).headers.Authorization).toBe('Basic ********');
 expect(publicMcpConfig(validateMcpConfig({...c,headers:{...c.headers,Authorization:'Token private-key'}})).headers.Authorization).toBe('Token ********');
 expect(publicMcpConfig(validateMcpConfig({...c,headers:{...c.headers,Authorization:'private-key'}})).headers.Authorization).toBe('********');
 for(const cli of ['pi','codex','claude-code','zcode','traex','dsh'] as const){const native=nativeMcpValue(validateMcpConfig({...c,headers:{...c.headers,Authorization:'Custom literal-value'}}),cli);expect(cli==='dsh'?native.config.headers.Authorization:cli==='codex'||cli==='traex'?native.http_headers.Authorization:native.headers.Authorization).toBe('Custom literal-value');}
 expect(secretsConfigured).toContain('headers.X.Api.Key');
});

it('can restore and deselect a valid bundle exceeding the old 2 MiB reader limit across CLIs',()=>{
 const home=mkdtempSync(join(tmpdir(),'mcp-large-'));folders.push(home);const env=Object.fromEntries(Array.from({length:64},(_,i)=>['FIELD_'+i,'x'.repeat(500)]));
 const servers=Array.from({length:80},(_,i)=>({id:'large-'+i,revision:1,configuration:validateMcpConfig({...config(),name:'large-'+i,env,secretKeys:[]})}));const clis=['pi','codex','claude-code','zcode','traex','dsh'];
 expect(applyMcpBundle(home,bundle(1,servers),clis).applied).toBe(true);expect(readFileSync(join(home,'.botmux/platform/mcp-configuration.json')).length).toBeGreaterThan(2*1024*1024);
 expect(applyMcpBundle(home,bundle(1,servers),clis).applied).toBe(true);expect(applyMcpBundle(home,bundle(2,[]),clis).applied).toBe(true);
 for(const cli of clis)expect(readFileSync(nativeMcpPath(home,cli as any),'utf8')).not.toContain('large-0');
});
