import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {containerRole} from './container-role.js';

const authenticatedWorkerRequests=new WeakSet<IncomingMessage>();
export const isNativeWorkerProxyRequest=(req:IncomingMessage)=>authenticatedWorkerRequests.has(req);

/** Preserve native capabilities without exposing container-only terminal ports.
 * External sandbox/Riff URLs are deliberately not rewritten. */
export function nativeWorkerTerminalLink(req:IncomingMessage,sessionId:string,value:unknown):unknown{
  if(!authenticatedWorkerRequests.has(req)||typeof value!=='string')return value;
  try{
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||url.pathname.replace(/\/$/,'')!==`/s/${encodeURIComponent(sessionId)}`)return value;
    return `${url.pathname}${url.search}${url.hash}`;
  }catch{return value;}
}

/** OpenSandbox deliberately strips Cookie/Authorization on its port proxy.
 * Translate a server-only, instance-local token back to native authentication.
 * Control images cannot opt into this using environment variables. */
export function createNativeWorkerProxyIdentity(token:()=>string|null,rolePath='/etc/botmux-platform-role'){
  const worker=containerRole(rolePath)==='worker';
  return (req:IncomingMessage)=>{
    const supplied=req.headers['x-platform-worker-token'];delete req.headers['x-platform-worker-token'];
    if(!worker||typeof supplied!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(supplied))return;
    const expected=token();if(!expected)return;
    const left=Buffer.from(supplied),right=Buffer.from(expected);
    if(left.length!==right.length||!timingSafeEqual(left,right))return;
    authenticatedWorkerRequests.add(req);
    req.headers.cookie=`botmux_dashboard_token=${supplied}`;
    // The outer Control Agent validates the isolated browser Origin.
    // Reconstruct the local hop which OpenSandbox rewrites/removes.
    req.headers.host=`127.0.0.1:${process.env.BOTMUX_DASHBOARD_PORT||7891}`;
    if(req.headers.origin)req.headers.origin=`http://${req.headers.host}`;
  };
}
