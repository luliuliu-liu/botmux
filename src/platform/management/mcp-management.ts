import {dirname,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {withFileLock} from '../../utils/file-lock.js';
import {applyMcpBundle} from './mcp-native.js';
export class McpManagementError extends Error{constructor(readonly status:number,readonly code:string,message:string){super(message);}}
function fail(r:{status:number;data:any}){throw new McpManagementError(r.status,r.data.error??'mcp_failed',r.data.message??'MCP 操作未确认');}
export function createMcpManagement(botsJsonPath:string,request:(path:string,method?:string,body?:unknown)=>Promise<{status:number;data:any}>,configure:(operation:()=>Promise<any>)=>Promise<any>){
 const home=dirname(dirname(botsJsonPath));
 return {async target(id:string,input?:any){
  if(input===undefined){const r=await request('/mcp-targets/'+id);if(r.status!==200)fail(r);return r.data;}
  const perform=async()=>{const r=await request('/mcp-targets/'+id,'POST',input);if(r.status!==200)fail(r);if(id!=='control')return r.data;
   const image=JSON.parse(readFileSync('/opt/agent/image.json','utf8')),applied=(()=>{try{return applyMcpBundle(home,r.data.bundle,image.agents.map((a:any)=>a.id));}catch{throw new McpManagementError(409,'mcp_native_conflict','MCP 原生配置有冲突或未确认，请检查手工条目后重试原请求');}})();
   const ack=await request('/mcp-targets/control/ack','POST',applied);if(ack.status!==200)fail(ack);return ack.data;
  };
  return id==='control'?configure(()=>withFileLock(join(home,'.botmux/platform/control-mcp-operation'),perform)):perform();
 }};
}
