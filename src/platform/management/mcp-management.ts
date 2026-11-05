import {dirname,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {withFileLock} from '../../utils/file-lock.js';
import {applyMcpBundle,isNativeMcpSynchronized} from './mcp-native.js';
export class McpManagementError extends Error{constructor(readonly status:number,readonly code:string,message:string){super(message);}}
function fail(r:{status:number;data:any}){throw new McpManagementError(r.status,r.data.error??'mcp_failed',r.data.message??'MCP 操作未确认');}
function imageCliIds(){const image=JSON.parse(readFileSync('/opt/agent/image.json','utf8'));if(!Array.isArray(image?.agents)||image.agents.some((a:any)=>!a||typeof a.id!=='string'))throw Error('invalid_agent_image');return image.agents.map((a:any)=>a.id) as string[];}
export function createMcpManagement(botsJsonPath:string,request:(path:string,method?:string,body?:unknown)=>Promise<{status:number;data:any}>,configure:(operation:()=>Promise<any>)=>Promise<any>){
 const home=dirname(dirname(botsJsonPath));
 return {async target(id:string,input?:any){
  if(input===undefined){const r=await request('/mcp-targets/'+id);if(r.status!==200)fail(r);if(id!=='control')return r.data;let synchronized=false;try{synchronized=isNativeMcpSynchronized(home,r.data,imageCliIds());}catch{}return {...r.data,synchronized};}
  const perform=async()=>{const r=await request('/mcp-targets/'+id,'POST',input);if(r.status!==200)fail(r);if(id!=='control')return r.data;
   const applied=(()=>{try{return applyMcpBundle(home,r.data.bundle,imageCliIds());}catch{throw new McpManagementError(409,'mcp_native_conflict','MCP 原生配置有冲突或未确认，请检查手工条目后重试原请求');}})();
   const ack=await request('/mcp-targets/control/ack','POST',applied);if(ack.status!==200)fail(ack);return ack.data;
  };
  return id==='control'?configure(()=>withFileLock(join(home,'.botmux/platform/control-mcp-operation'),perform)):perform();
 }};
}
