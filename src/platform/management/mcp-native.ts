import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,realpathSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse,stringify} from 'smol-toml';
import {mcpTargets,type McpCli} from './mcp-schema.js';
import {mcpDigest,validateMcpBundle} from './mcp-bundle.js';
export {mcpDigest,validateMcpBundle,type McpBundle} from './mcp-bundle.js';
function checkedDir(home:string,path:string){const root=realpathSync(home),target=resolve(path);if(target!==root&&!target.startsWith(root+sep))throw Error('mcp_path_outside_state');let current=root;for(const part of target.slice(root.length).split(sep).filter(Boolean)){current=join(current,part);try{const stat=lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('unsafe_mcp_path');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;mkdirSync(current,{mode:0o700});}}}
const NATIVE_LIMIT=16*1024*1024,RECOVERY_LIMIT=256*1024*1024;
function limit(path:string){return path.endsWith('/mcp-pending.json')?RECOVERY_LIMIT:NATIVE_LIMIT;}
function bounded(path:string,value:string){if(Buffer.byteLength(value)>limit(path))throw Error('mcp_configuration_too_large');}
function text(home:string,path:string){checkedDir(home,dirname(path));try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>limit(path))throw Error('unsafe_mcp_file');return readFileSync(path,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return '';throw e;}}
function syncDirectory(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function atomic(home:string,path:string,value:string){bounded(path,value);checkedDir(home,dirname(path));text(home,path);const temporary=path+'.platform-'+randomUUID();try{const fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,path);syncDirectory(dirname(path));}finally{try{unlinkSync(temporary);}catch{}}}
export function nativeMcpPath(home:string,cli:McpCli){return cli==='pi'?join(home,'.pi/agent/mcp.json'):cli==='claude-code'?join(home,'.claude.json'):cli==='zcode'?join(home,'.zcode/cli/config.json'):cli==='codex'?join(home,'.codex/config.toml'):cli==='traex'?join(home,'.trae/traecli.toml'):join(home,'.dsh/platform-mcp.patch.json');}
import {nativeMcpValue} from './mcp-native-value.js';
export {nativeMcpValue} from './mcp-native-value.js';
function mapIn(data:any,cli:McpCli){if(cli==='dsh'){if(!Array.isArray(data)||data.some(v=>!v||Object.keys(v).length!==1||!Array.isArray(v.insert)||v.insert.some((r:any)=>!r.config?.serverName)))throw Error('invalid_dsh_mcp_patch');const rows=data.flatMap(v=>v.insert);if(new Set(rows.map(v=>v.config.serverName)).size!==rows.length)throw Error('duplicate_dsh_mcp_patch');return Object.fromEntries(rows.map(v=>[v.config.serverName,v]));}if(cli==='zcode'){data.mcp??={};if(!data.mcp||typeof data.mcp!=='object'||Array.isArray(data.mcp))throw Error('invalid_zcode_mcp');data.mcp.servers??={};return data.mcp.servers;}data.mcpServers??={};return data.mcpServers;}
function stripTables(raw:string,names:Set<string>){let skipping=false;const result:string[]=[];for(const line of raw.split(/\r?\n/)){if(/^\s*\[/.test(line)){const match=line.match(/^\s*\[([^\]]*)\]\s*(?:#.*)?$/);skipping=false;if(match){try{const dummy=parse('['+match[1]+']\nplatform_probe = true');const group=dummy.mcp_servers;if(group&&typeof group==='object')skipping=Object.keys(group).some(n=>names.has(n));}catch{}}}if(!skipping)result.push(line);}return result.join('\n');}
export function mergeNativeMcp(raw:string,cli:McpCli,next:Record<string,any>,owned:Record<string,any>){
 const toml=cli==='codex'||cli==='traex';const data:any=toml?(raw?parse(raw):{}):raw?JSON.parse(raw):cli==='dsh'?[]:{};
 const existing=toml?(data.mcp_servers??{}):mapIn(data,cli);if(!existing||typeof existing!=='object'||Array.isArray(existing))throw Error('invalid_native_mcp_map');
 // Codex persists per-tool permissions under the server's tools table. These
 // native preferences are not connection fields owned by the platform.
 const nativeTools=(name:string)=>toml&&existing[name]?.tools!==undefined&&owned[name]?.tools===undefined;
 for(const name of Object.keys(owned)){const current=existing[name];if(current!==undefined){const compare=nativeTools(name)?Object.fromEntries(Object.entries(current).filter(([k])=>k!=='tools')):current;if(mcpDigest(compare)!==mcpDigest(owned[name]))throw Error('mcp_managed_entry_modified:'+name);}}
 for(const name of Object.keys(next)){if(existing[name]!==undefined&&!Object.hasOwn(owned,name))throw Error('mcp_manual_name_conflict:'+name);}
 const written=Object.fromEntries(Object.entries(next).map(([name,value])=>[name,Object.hasOwn(owned,name)&&nativeTools(name)?{...value,tools:existing[name].tools}:value]));
 const merged={...existing};for(const name of Object.keys(owned))delete merged[name];Object.assign(merged,written);
 if(toml){const names=new Set([...Object.keys(owned),...Object.keys(next)]);const rest=stripTables(raw,names);const untouched={...existing};for(const n of names)delete untouched[n];const parsed:any=rest.trim()?parse(rest):{};if(mcpDigest(parsed.mcp_servers??{})!==mcpDigest(untouched))throw Error('mcp_toml_inline_table_conflict');return rest.trimEnd()+'\n'+(Object.keys(written).length?stringify({mcp_servers:written}):'');}
 if(cli==='dsh')return JSON.stringify(Object.keys(merged).length?[{insert:Object.values(merged)}]:[],null,2)+'\n';if(cli==='zcode')data.mcp.servers=merged;else data.mcpServers=merged;return JSON.stringify(data,null,2)+'\n';
}
export function recoverPendingMcp(home:string){const root=realpathSync(home),state=join(root,'.botmux/platform'),ledgerPath=join(state,'mcp-configuration.json'),pendingPath=join(state,'mcp-pending.json');checkedDir(root,state);
 const pendingRaw=text(root,pendingPath);if(!pendingRaw)return;
 const p=JSON.parse(pendingRaw);for(const f of p.files){const current=text(root,f.path);if(current!==f.before&&current!==f.after)throw Error('mcp_recovery_conflict');}
 for(const f of p.files)atomic(root,f.path,f.after);atomic(root,ledgerPath,JSON.stringify(p.ledger));unlinkSync(pendingPath);syncDirectory(state);
}
export function applyMcpBundle(home:string,input:any,clis:string[]){const bundle=validateMcpBundle(input),root=realpathSync(home),state=join(root,'.botmux/platform'),ledgerPath=join(state,'mcp-configuration.json'),pendingPath=join(state,'mcp-pending.json');checkedDir(root,state);recoverPendingMcp(root);
 const raw=text(root,ledgerPath),previous=raw?JSON.parse(raw):{revision:0,entries:{}};
 if(bundle.revision<previous.revision||bundle.revision===previous.revision&&bundle.digest!==previous.digest)throw Error('mcp_revision_conflict');
 const entries:Record<string,Record<string,any>>={...previous.entries},files:Array<{path:string;before:string;after:string}>=[],applied:any[]=[];
 for(const server of bundle.servers){const targets=mcpTargets(server.configuration,clis);if(!targets.length)throw Error('mcp_incompatible:'+server.configuration.name);applied.push({id:server.id,name:server.configuration.name,cliIds:targets});}
 for(const cli of clis as McpCli[]){const next:Record<string,any>={};for(const s of bundle.servers)if(mcpTargets(s.configuration,[cli]).length)next[s.configuration.name]=nativeMcpValue(s.configuration,cli);entries[cli]=next;
  if(!Object.keys(next).length&&!Object.keys(previous.entries[cli]??{}).length)continue;
  const path=nativeMcpPath(root,cli),before=text(root,path),after=mergeNativeMcp(before,cli,next,previous.entries[cli]??{});if(before!==after)files.push({path,before,after});
 }
 const ledger={schema:'platform-mcp-runtime-v1',revision:bundle.revision,requestId:bundle.requestId,digest:bundle.digest,entries,servers:bundle.servers.map(s=>({id:s.id,revision:s.revision,name:s.configuration.name}))};
 const ledgerText=JSON.stringify(ledger),pendingText=JSON.stringify({files,ledger});
 // Validate every expanded output before writing any native file or journal.
 bounded(ledgerPath,ledgerText);bounded(pendingPath,pendingText);for(const f of files)bounded(f.path,f.after);
 if(files.length){atomic(root,pendingPath,pendingText);for(const f of files)atomic(root,f.path,f.after);}
 atomic(root,ledgerPath,ledgerText);if(existsSync(pendingPath)){unlinkSync(pendingPath);syncDirectory(state);}
 return {applied:true,revision:bundle.revision,requestId:bundle.requestId,digest:bundle.digest,servers:applied};
}
