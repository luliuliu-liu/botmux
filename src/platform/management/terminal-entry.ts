import {safeProxyPath,type ProxyTarget} from '../transport/http-proxy.js';

/** The anonymous front door forwards native session capabilities, never a
 * Dashboard login. Native Botmux remains the authority for token validation. */
export function terminalCapabilityPath(raw:string):boolean{
 try{
  safeProxyPath(raw);const u=new URL(raw,'http://terminal.local');
  if(!/^\/s\/[0-9a-f-]{36}(?:\/[^%\\]*)?$/.test(u.pathname))return false;
  const values=[...u.searchParams.getAll('viewToken'),...u.searchParams.getAll('token')];
  return values.length===1&&values[0]!.length>=20&&values[0]!.length<=4096;
 }catch{return false;}
}
export function terminalOnlyTarget(target:ProxyTarget):ProxyTarget{
 const headers={...target.headers};
 for(const name of Object.keys(headers))if(['cookie','authorization','x-platform-worker-token'].includes(name.toLowerCase())||name.toLowerCase().startsWith('x-botmux-'))delete headers[name];
 return {...target,headers};
}
