import {randomBytes,createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Duplex} from 'node:stream';
import {proxyHttp,proxyUpgrade,type ProxyTarget} from '../transport/http-proxy.js';

type Grant={containerId:string;issuer:string;expires:number;secure:boolean};
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function createWorkerDashboardProxy(deps:{resolve:(id:string)=>Promise<ProxyTarget>;issuer:()=>string;domain?:string;now?:()=>number}){
  const domain=deps.domain||'localhost',now=deps.now||Date.now,tickets=new Map<string,Grant>(),sessions=new Map<string,Grant>();
  const active=new Map<ServerResponse|Duplex,Grant>();
  let revocationTimer:ReturnType<typeof setInterval>|undefined;
  const valid=(value:Grant)=>value.expires>now()&&!!deps.issuer()&&value.issuer===digest(deps.issuer());
  function track(connection:ServerResponse|Duplex,value:Grant){
    active.set(connection,value);
    connection.once('close',()=>{active.delete(connection);if(!active.size&&revocationTimer){clearInterval(revocationTimer);revocationTimer=undefined;}});
    revocationTimer??=setInterval(()=>{for(const [connection,grant] of active)if(!valid(grant))connection.destroy();},1000);
    revocationTimer.unref();
  }
  if(!/^[a-z0-9.-]+$/.test(domain))throw new Error('invalid_worker_dashboard_domain');
  const hostPattern=new RegExp(`^w-(${uuid})\\.${domain.replace(/\./g,'\\.')}(?::[0-9]+)?$`);
  const id=(req:IncomingMessage)=>req.headers.host?.match(hostPattern)?.[1];
  const prune=()=>{for(const map of [tickets,sessions]){for(const [key,value] of map)if(value.expires<=now())map.delete(key);if(map.size>2048)throw new Error('worker_proxy_session_limit');}};
  function grant(req:IncomingMessage){
    const containerId=id(req),cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('agent_worker_session='))?.slice('agent_worker_session='.length);
    const value=cookie?sessions.get(digest(cookie)):undefined;
    return value&&value.containerId===containerId&&valid(value)?value:undefined;
  }
  function originAllowed(req:IncomingMessage){
    const origin=req.headers.origin;if(!origin)return true;
    try{return new URL(origin).host===req.headers.host&&['http:','https:'].includes(new URL(origin).protocol);}catch{return false;}
  }
  return {
    matches:(req:IncomingMessage)=>!!id(req),
    async link(containerId:string,requestHost:string,secure=false){
      if(!new RegExp(`^${uuid}$`).test(containerId))throw new Error('invalid_container_id');
      if(!deps.issuer())throw new Error('dashboard_auth_unavailable');
      // Validate existence/readiness before issuing a one-use, instance-bound ticket.
      await deps.resolve(containerId);prune();const ticket=randomBytes(32).toString('base64url');
      tickets.set(digest(ticket),{containerId,issuer:digest(deps.issuer()),expires:now()+60000,secure});
      const port=new URL(`http://${requestHost}`).port;
      return {url:`${secure?'https':'http'}://w-${containerId}.${domain}${port?`:${port}`:''}/?ticket=${ticket}`};
    },
    async http(req:IncomingMessage,res:ServerResponse){
      prune();const containerId=id(req);if(!containerId)return false;
      const url=new URL(req.url||'/',`http://${req.headers.host}`),ticket=url.searchParams.get('ticket');
      if(ticket){
        const key=digest(ticket),value=tickets.get(key);tickets.delete(key);
        if(req.method!=='GET'||url.pathname!=='/'||!value||value.containerId!==containerId||!valid(value)){res.writeHead(401,{'cache-control':'no-store','referrer-policy':'no-referrer'});res.end('Worker access link expired');return true;}
        const session=randomBytes(32).toString('base64url');sessions.set(digest(session),{...value,expires:now()+8*60*60_000});
        res.writeHead(303,{location:'/', 'set-cookie':`agent_worker_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${value.secure?'; Secure':''}`, 'cache-control':'no-store','referrer-policy':'no-referrer'});res.end();return true;
      }
      const session=grant(req);
      if(!session||!originAllowed(req)){res.writeHead(403,{'cache-control':'no-store'});res.end('Worker access denied');return true;}
      try{const target=await deps.resolve(containerId);if(!valid(session))throw new Error('access_revoked');track(res,session);proxyHttp(req,res,target);}catch{res.writeHead(502);res.end('Worker unavailable');}return true;
    },
    async upgrade(req:IncomingMessage,socket:Duplex,head:Buffer){
      const session=grant(req);
      if(!session||!originAllowed(req)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
      try{const target=await deps.resolve(id(req)!);if(!valid(session))throw new Error('access_revoked');track(socket,session);proxyUpgrade(req,socket,head,target);}catch{socket.destroy();}
    },
  };
}
