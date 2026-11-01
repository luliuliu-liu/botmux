import {request as httpRequest,type IncomingMessage,type ServerResponse} from 'node:http';
import {request as httpsRequest} from 'node:https';
import type {Duplex} from 'node:stream';
import {connect} from 'node:net';
import {connect as connectTls} from 'node:tls';

export type ProxyTarget={url:string;headers?:Record<string,string>};
const hop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const connectionHeaders=(headers:IncomingMessage['headers'])=>new Set(String(headers.connection||'').toLowerCase().split(',').map(value=>value.trim()));
export function safeProxyPath(raw:string){
  if(!raw.startsWith('/')||raw.startsWith('//')||/[\\\r\n\0#]/.test(raw))throw new Error('invalid_proxy_path');
  let path=raw.split('?')[0]!;
  for(let i=0;i<3;i++){
    const decoded=decodeURIComponent(path);
    if(decoded.split('/').some(part=>part==='.'||part==='..')||/[\\\r\n\0]/.test(decoded))throw new Error('invalid_proxy_path');
    if(decoded===path)return raw;path=decoded;
  }
  throw new Error('invalid_proxy_path');
}
/** OpenSandbox rewrites upstream redirects to its private proxy prefix. The
 * browser lives on an instance origin, so remove only that exact target prefix
 * before forwarding Location through our next proxy hop. */
export function publicProxyLocation(location:string,target:URL){
  const prefix=target.pathname.replace(/\/$/,'');
  if(!prefix)return location;
  try{
    const resolved=new URL(location,target);
    if(resolved.origin!==target.origin||!(resolved.pathname===prefix||resolved.pathname.startsWith(prefix+'/')))return location;
    return safeProxyPath((resolved.pathname.slice(prefix.length)||'/')+resolved.search)+resolved.hash;
  }catch{return location;}
}
function options(req:IncomingMessage,target:ProxyTarget,upgrade=false){
  const url=new URL(target.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('invalid_proxy_target');
  const headers:Record<string,string|string[]|undefined>={};
  const nominated=connectionHeaders(req.headers);
  for(const [name,value] of Object.entries(req.headers)){
    if(hop.has(name)||nominated.has(name)||['cookie','authorization','x-api-key','host','origin','referer'].includes(name)||name.startsWith('x-forwarded-')||name.startsWith('x-platform-'))continue;
    headers[name]=value;
  }
  if(upgrade){headers.connection='Upgrade';headers.upgrade='websocket';}
  return {url,method:req.method,headers:{...headers,...target.headers},
    path:url.pathname.replace(/\/$/,'')+safeProxyPath(req.url||'/')};
}
export function proxyHttp(req:IncomingMessage,res:ServerResponse,target:ProxyTarget){
  const opts=options(req,target),request=(opts.url.protocol==='https:'?httpsRequest:httpRequest)(opts.url,{method:opts.method,path:opts.path,headers:opts.headers},upstream=>{
    const headers:Record<string,any>={},nominated=connectionHeaders(upstream.headers);
    for(const [name,value] of Object.entries(upstream.headers))if(!hop.has(name)&&!nominated.has(name)&&!['set-cookie','content-security-policy-report-only'].includes(name))headers[name]=value;
    if(typeof headers.location==='string')headers.location=publicProxyLocation(headers.location,opts.url);
    headers['cache-control']='no-store';headers['referrer-policy']='no-referrer';
    res.writeHead(upstream.statusCode||502,headers);upstream.pipe(res);
  });
  request.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end('{"error":"worker_unavailable"}');});
  req.on('aborted',()=>request.destroy());res.on('close',()=>request.destroy());req.pipe(request);
}
export function proxyUpgrade(req:IncomingMessage,socket:Duplex,head:Buffer,target:ProxyTarget){
  const opts=options(req,target,true),lines=[`${opts.method||'GET'} ${opts.path} HTTP/1.1`];
  const headers={host:opts.url.host,...opts.headers};
  for(const [name,value] of Object.entries(headers)){
    if(value===undefined)continue;
    for(const item of Array.isArray(value)?value:[value]){
      if(!/^[a-z0-9-]+$/i.test(name)||/[\r\n\0]/.test(item))throw Error('invalid_proxy_header');
      lines.push(`${name}: ${item}`);
    }
  }
  // Relay wire bytes, not an HTTP client's upgraded stream. Bun-to-Bun HTTP
  // upgrade streams can stall frame delivery across a second proxy hop.
  const connected=()=>{upstream.write(lines.join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);};
  const upstream=opts.url.protocol==='https:'?connectTls({host:opts.url.hostname,port:Number(opts.url.port||443),servername:opts.url.hostname},connected):connect({host:opts.url.hostname,port:Number(opts.url.port||80)},connected);
  let pending=Buffer.alloc(0);
  const handshake=(chunk:Buffer)=>{
    pending=Buffer.concat([pending,chunk]);const end=pending.indexOf('\r\n\r\n');
    if(end<0){if(pending.length>65536)upstream.destroy();return;}
    if(end>65536){upstream.destroy();return;}
    upstream.removeListener('data',handshake);
    const clean=pending.subarray(0,end).toString('latin1').split('\r\n').filter(line=>!/^set-cookie\s*:/i.test(line));
    socket.write(clean.join('\r\n')+'\r\n\r\n','latin1');if(pending.length>end+4)socket.write(pending.subarray(end+4));
    pending=Buffer.alloc(0);upstream.pipe(socket);
  };
  upstream.on('data',handshake);
  upstream.on('error',()=>socket.destroy());upstream.on('close',()=>socket.destroy());
  socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
}
