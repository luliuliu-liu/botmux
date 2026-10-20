import {readFileSync} from 'node:fs';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {controlRequestOriginState} from '../../dashboard/control-csrf.js';

/** A Worker is a separate browser origin, not a trusted Control UI. Apply the
 * existing native Origin policy to every Control write, including native
 * settings APIs, rather than guarding only our /api/platform additions. */
export function createControlBrowserBoundary(rolePath='/etc/botmux-platform-role'){
  let control=false;try{control=readFileSync(rolePath,'utf8').trim()==='control';}catch{}
  return (req:IncomingMessage,res:ServerResponse,pathname:string)=>{
    if(!control)return false;
    if(req.method==='GET'&&(pathname==='/'||pathname==='/dashboard')){
      res.setHeader('x-frame-options','SAMEORIGIN');
      res.setHeader('content-security-policy',"frame-ancestors 'self'");
    }
    if(['POST','PUT','PATCH','DELETE'].includes(req.method||'')&&controlRequestOriginState(req.headers)==='foreign'){
      res.writeHead(403,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"control_origin_rejected"}');return true;
    }
    return false;
  };
}
