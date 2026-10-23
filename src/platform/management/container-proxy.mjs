/** Container-local HTTP/CONNECT router; no transparent networking or sidecar. */
import {createServer,request} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {connect} from 'node:net';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

export const proxyFile=home=>join(home,'.botmux','platform','proxy.json');
export const proxyEnvironmentKeys=['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy','NODE_USE_ENV_PROXY'];
export function readProxy(home){return existsSync(proxyFile(home))?JSON.parse(readFileSync(proxyFile(home),'utf8')):null;}
export function proxyEnvironment(configuration){
 if(!configuration)return {};
 const url='http://127.0.0.1:3344',bypass='localhost,127.0.0.1,::1,control-plane,opensandbox-server,host.docker.internal';
 return {HTTP_PROXY:url,HTTPS_PROXY:url,http_proxy:url,https_proxy:url,NO_PROXY:bypass,no_proxy:bypass,NODE_USE_ENV_PROXY:'1'};
}
export function routeProxy(host,config){
 host=host.toLowerCase().replace(/^\[|\]$/g,'');
 if(!config||['localhost','::1','control-plane','opensandbox-server','host.docker.internal'].includes(host)||/^127\./.test(host))return 'direct';
 if(config.mode==='global')return 'proxy';
 return config.rules.find(r=>r.host===host||r.host.startsWith('*.')&&host.endsWith(r.host.slice(1)))?.action??config.defaultAction;
}
export function upstreamProxy(config){const u=new URL(config.url);if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))u.hostname='host.docker.internal';return u;}
export function createContainerProxy(configuration){
 const sockets=new Set();
 const server=createServer((req,res)=>{
  let url;try{url=new URL(req.url);}catch{return res.writeHead(400).end();}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return res.writeHead(400).end();
  const config=configuration(),proxied=routeProxy(url.hostname,config)==='proxy',upstream=proxied?upstreamProxy(config):url;
  const headers={...req.headers,host:url.host};delete headers['proxy-authorization'];delete headers['proxy-connection'];
  const outgoing=(!proxied&&url.protocol==='https:'?httpsRequest:request)({agent:false,hostname:upstream.hostname.replace(/^\[|\]$/g,''),port:upstream.port||(!proxied&&url.protocol==='https:'?443:80),method:req.method,path:proxied?url.href:url.pathname+url.search,headers},response=>{res.writeHead(response.statusCode||502,response.headers);response.pipe(res);});
  outgoing.setTimeout(120000,()=>outgoing.destroy());outgoing.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(outgoing);req.on('aborted',()=>outgoing.destroy());
 });
 server.on('connect',(req,client,head)=>{
  let target;try{target=new URL('http://'+req.url);}catch{return client.destroy();}
  const port=Number(target.port||80);
  if(!target.hostname||!/^.+:\d+$/.test(req.url)||port<1||port>65535||target.username||target.password)return client.destroy();
  const config=configuration();
  const pipe=(socket,pending)=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>client.destroy());client.on('error',()=>socket.destroy());client.on('close',()=>socket.destroy());client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(pending?.length)client.write(pending);if(head.length)socket.write(head);client.pipe(socket);socket.pipe(client);};
  if(routeProxy(target.hostname,config)==='direct'){
   const socket=connect(port,target.hostname.replace(/^\[|\]$/g,''),()=>pipe(socket));socket.on('error',()=>client.destroy());
  }else{
   const u=upstreamProxy(config),out=request({agent:false,hostname:u.hostname.replace(/^\[|\]$/g,''),port:u.port||80,method:'CONNECT',path:req.url,headers:{host:req.url}});
   out.setTimeout(20000,()=>out.destroy());out.on('error',()=>client.destroy());
   out.on('connect',(response,socket,pending)=>{if(response.statusCode!==200){socket.destroy();return client.destroy();}pipe(socket,pending);});out.end();
  }
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});
 return {server,reset(){for(const socket of sockets)socket.destroy();},async close(){for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(r=>server.close(r));}};
}
