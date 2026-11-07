import {randomBytes,createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Duplex} from 'node:stream';
import {proxyHttp,proxyUpgrade,type ProxyTarget} from '../transport/http-proxy.js';
import {terminalCapabilityPath} from './terminal-entry.js';

type Grant={containerId:string;issuer:string;expires:number;secure:boolean};
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

export class WorkerDashboardEntryError extends Error {
  readonly status=409;
  constructor(readonly code:'worker_dashboard_domain_required'|'invalid_worker_dashboard_host',message:string){super(message);}
}
/** localhost只能用于客户端本机入口；远程实例保持独立来源，不回退Control同源。 */
export function workerDashboardOrigin(domain:string,requestHost:string,secure=false):string {
  let entry:URL;
  try{entry=new URL(`http://${requestHost}`);}catch{throw new WorkerDashboardEntryError('invalid_worker_dashboard_host','工作台入口地址无效');}
  if(entry.username||entry.password||entry.pathname!=='/'||entry.search||entry.hash)throw new WorkerDashboardEntryError('invalid_worker_dashboard_host','工作台入口地址无效');
  const host=entry.hostname.toLowerCase();
  const loopback=host==='localhost'||host.endsWith('.localhost')||host==='[::1]'||/^127\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/.test(host);
  if((domain==='localhost'||domain.endsWith('.localhost'))&&!loopback){
    throw new WorkerDashboardEntryError('worker_dashboard_domain_required','远程工作台尚未配置可达泛域名：BOTMUX_WORKER_DASHBOARD_DOMAIN 仍为 localhost，会连接到你的电脑。请配置指向 devbox 的独立实例域名后重试。');
  }
  return `${secure?'https':'http'}://${domain}${entry.port?`:${entry.port}`:''}`;
}
export function createWorkerDashboardProxy(deps:{resolve:(id:string)=>Promise<ProxyTarget>;resolveTerminal?:(id:string)=>Promise<ProxyTarget>;issuer:()=>string;domain?:string;now?:()=>number}){
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
      const endpoint=new URL(workerDashboardOrigin(domain,requestHost,secure));
      endpoint.hostname=`w-${containerId}.${domain}`;
      // Validate existence/readiness before issuing a one-use, instance-bound ticket.
      await deps.resolve(containerId);prune();const ticket=randomBytes(32).toString('base64url');
      tickets.set(digest(ticket),{containerId,issuer:digest(deps.issuer()),expires:now()+60000,secure});
      return {url:`${endpoint.origin}/?ticket=${ticket}`};
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
      if(!session&&req.method==='GET'&&terminalCapabilityPath(req.url||'')&&deps.resolveTerminal&&originAllowed(req)){
        try{proxyHttp(req,res,await deps.resolveTerminal(containerId));}catch{res.writeHead(502);res.end('Terminal unavailable');}return true;
      }
      if(!session||!originAllowed(req)){res.writeHead(403,{'cache-control':'no-store'});res.end('Worker access denied');return true;}
      try{const target=await deps.resolve(containerId);if(!valid(session))throw new Error('access_revoked');track(res,session);proxyHttp(req,res,target);}catch{res.writeHead(502);res.end('Worker unavailable');}return true;
    },
    async upgrade(req:IncomingMessage,socket:Duplex,head:Buffer){
      const session=grant(req);
      if(!session&&req.method==='GET'&&terminalCapabilityPath(req.url||'')&&deps.resolveTerminal&&originAllowed(req)){
        try{proxyUpgrade(req,socket,head,await deps.resolveTerminal(id(req)!));}catch{socket.destroy();}return;
      }
      if(!session||!originAllowed(req)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
      try{const target=await deps.resolve(id(req)!);if(!valid(session))throw new Error('access_revoked');track(socket,session);proxyUpgrade(req,socket,head,target);}catch{socket.destroy();}
    },
  };
}

/** Worker routes are probed in order (Agent, login, local login, browser) and
 * each probe costs a control-plane round trip, so every proxied asset paid up
 * to four. Remember which probe answered for a short window; a failure drops
 * the entry so a deleted or moved target is re-resolved on the next request. */
export function createRouteKindResolver(deps:{probes:readonly string[];probe:(kind:string,id:string)=>Promise<boolean>;now?:()=>number;ttlMs?:number}){
  const now=deps.now||Date.now,ttl=deps.ttlMs??10_000,known=new Map<string,{kind:string;until:number}>();
  return async(id:string):Promise<string>=>{
    const cached=known.get(id);
    if(cached&&cached.until>now())return cached.kind;
    known.delete(id);
    for(const kind of deps.probes)if(await deps.probe(kind,id)){
      if(known.size>2048)known.clear();
      known.set(id,{kind,until:now()+ttl});return kind;
    }
    throw new Error('worker_unavailable');
  };
}
