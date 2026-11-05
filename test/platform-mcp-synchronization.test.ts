import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parse,stringify} from 'smol-toml';
import {applyMcpBundle,isNativeMcpSynchronized,mcpDigest,nativeMcpPath} from '../src/platform/management/mcp-native.js';

const homes:string[]=[];
const config=()=>({name:'repo',displayName:'Repo',description:'fixture',transport:'stdio' as const,command:'/usr/bin/node',args:['server.js'],env:{TOKEN:'fixture-secret'},headers:{},auth:{type:'none' as const},cliIds:['pi','codex'],options:{},secretKeys:['env.TOKEN']});
const bundle=(revision=1,servers:any[]=[{id:'server-id',revision:1,configuration:config()}])=>({schema:'platform-mcp-bundle-v1' as const,revision,requestId:'request-1',servers,digest:mcpDigest(servers)});
const target=(revision=1,serverRevision=1,serverIds=['server-id'],cliIds=['pi','codex'])=>({revision,serverIds,cliIds,servers:[{id:'server-id',revision:serverRevision,configuration:{...config(),env:{TOKEN:'********'}}}]});
function home(){mkdirSync(tmpdir(),{recursive:true});const value=mkdtempSync(join(tmpdir(),'control-sync-'));homes.push(value);return value;}
function snapshot(root:string):any{return readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).map(entry=>[entry.name,entry.isDirectory()?snapshot(join(root,entry.name)):readFileSync(join(root,entry.name),'utf8')]);}
afterEach(()=>{for(const value of homes.splice(0))rmSync(value,{recursive:true,force:true});});

describe('control MCP synchronized probe',()=>{
 it('accepts an empty managed revision without creating native directories',()=>{const root=home();applyMcpBundle(root,bundle(1,[]),['pi','codex']);const before=snapshot(root);expect(isNativeMcpSynchronized(root,{revision:1,serverIds:[],cliIds:['pi','codex'],servers:[]},['pi','codex'])).toBe(true);expect(snapshot(root)).toEqual(before);expect(readdirSync(root)).toEqual(['.botmux']);});
 it('accepts manual entries and Codex native tool permissions without writes',()=>{const root=home();applyMcpBundle(root,bundle(),['pi','codex']);const pi=nativeMcpPath(root,'pi'),piData=JSON.parse(readFileSync(pi,'utf8'));piData.mcpServers.manual={command:'manual'};writeFileSync(pi,JSON.stringify(piData,null,2)+'\n');const codex=nativeMcpPath(root,'codex'),codexData:any=parse(readFileSync(codex,'utf8'));codexData.mcp_servers.manual={command:'manual'};codexData.mcp_servers.repo.tools={lookup:{enabled:false}};writeFileSync(codex,stringify(codexData));const before=snapshot(root);expect(isNativeMcpSynchronized(root,target(),['pi','codex'])).toBe(true);expect(snapshot(root)).toEqual(before);});
 it('fails closed for server revision and pending work',()=>{const root=home();applyMcpBundle(root,bundle(),['pi','codex']);expect(isNativeMcpSynchronized(root,target(1,2),['pi','codex'])).toBe(false);writeFileSync(join(root,'.botmux/platform/mcp-pending.json'),'{}');expect(isNativeMcpSynchronized(root,target(),['pi','codex'])).toBe(false);});
 it('fails closed for missing or modified managed entries',()=>{const missing=home();applyMcpBundle(missing,bundle(),['pi','codex']);unlinkSync(nativeMcpPath(missing,'pi'));expect(isNativeMcpSynchronized(missing,target(),['pi','codex'])).toBe(false);const modified=home();applyMcpBundle(modified,bundle(),['pi','codex']);const path=nativeMcpPath(modified,'pi'),data=JSON.parse(readFileSync(path,'utf8'));data.mcpServers.repo.command='/usr/bin/false';writeFileSync(path,JSON.stringify(data));expect(isNativeMcpSynchronized(modified,target(),['pi','codex'])).toBe(false);});
 it('本地ledger丢失管理条目不能把非空目标伪装成已同步',()=>{
  const root=home();applyMcpBundle(root,bundle(),['pi','codex']);const path=join(root,'.botmux/platform/mcp-configuration.json');const ledger=JSON.parse(readFileSync(path,'utf8'));ledger.entries.pi={};writeFileSync(path,JSON.stringify(ledger));expect(isNativeMcpSynchronized(root,target(),['pi','codex'])).toBe(false);
 });
 it('fails closed when ledger, target, and image CLI coverage differ',()=>{const root=home();applyMcpBundle(root,bundle(),['pi','codex']);expect(isNativeMcpSynchronized(root,target(1,1,['server-id'],['pi']),['pi','codex'])).toBe(false);expect(isNativeMcpSynchronized(root,target(),['pi'])).toBe(false);});
 it('空CLI或不支持当前CLI的server不能伪装成空集合已同步',()=>{
  const root=home();applyMcpBundle(root,bundle(1,[]),['pi','codex']);expect(isNativeMcpSynchronized(root,{revision:1,serverIds:[],cliIds:[],servers:[]},[])).toBe(false);
  const configured=home();applyMcpBundle(configured,bundle(),['pi','codex']);const wrong=target();wrong.servers[0].configuration.cliIds=['claude-code'];expect(isNativeMcpSynchronized(configured,wrong,['pi','codex'])).toBe(false);
 });
 it('fails closed for legacy target metadata',()=>{const root=home();expect(isNativeMcpSynchronized(root,{revision:1,serverIds:[]},[])).toBe(false);});
});
