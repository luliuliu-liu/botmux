import {afterEach,describe,expect,it} from 'vitest';
import {createServer,request,type IncomingHttpHeaders,type Server} from 'node:http';
import {connect,type Socket} from 'node:net';
import {createWorkerDashboardProxy} from '../src/platform/management/worker-dashboard-proxy.js';
import {safeProxyPath,publicProxyLocation,proxyUpgrade} from '../src/platform/transport/http-proxy.js';

const id='12345678-1234-1234-1234-123456789012',other='12345678-1234-1234-1234-123456789013';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function listen(server:Server){
  const sockets=new Set<Socket>();server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  cleanup.push(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return (server.address() as {port:number}).port;
}
async function fixture(){
  const seen:Array<{url?:string;headers:IncomingHttpHeaders}>=[];
  const upstream=createServer((req,res)=>{
    seen.push({url:req.url,headers:req.headers});
    if(req.url===`/instance/${id}/`){res.writeHead(302,{location:`/instance/${id}/vnc.html?autoconnect=1&resize=scale`});res.end();return;}
    res.writeHead(200,{'content-type':'text/plain','set-cookie':'admin=must-not-leak','cache-control':'public, max-age=3600'});
    if(req.url?.endsWith('/events')){res.write('first-event\n');return;}
    res.end('worker');
  });
  upstream.on('upgrade',(req,socket)=>{seen.push({url:req.url,headers:req.headers});socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: private=must-not-leak\r\n\r\n');socket.write(Buffer.concat([Buffer.from([0x82,12]),Buffer.from('RFB 003.008\n')]));});
  const upstreamPort=await listen(upstream);let issuer='admin-token',now=1000;
  const proxy=createWorkerDashboardProxy({issuer:()=>issuer,now:()=>now,resolve:async containerId=>{
    if(containerId!==id&&containerId!==other)throw new Error('not_found');
    return {url:`http://127.0.0.1:${upstreamPort}/instance/${containerId}`,headers:{cookie:'botmux_session=native-private','x-api-key':'server-private'}};
  },resolveTerminal:async containerId=>({url:`http://127.0.0.1:${upstreamPort}/terminal/${containerId}`,headers:{'x-api-key':'server-private'}})});
  const server=createServer((req,res)=>{void proxy.http(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
  server.on('upgrade',(req,socket,head)=>void proxy.upgrade(req,socket,head));
  const port=await listen(server),host=`w-${id}.localhost:${port}`;
  const get=(path:string,headers:Record<string,string>={})=>new Promise<{status:number;headers:IncomingHttpHeaders;text:string}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,headers:{host,...headers}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,text}));});req.on('error',reject);req.end();
  });
  const login=async(secure=false)=>{const link=await proxy.link(id,`127.0.0.1:${port}`,secure);const response=await get(new URL(link.url).pathname+new URL(link.url).search);return {link,response,cookie:response.headers['set-cookie']![0]!.split(';')[0]!};};
  return {seen,proxy,port,host,get,login,rotate:()=>issuer='new-admin-token',expire:()=>now+=8*60*60_000+1};
}

describe('isolated Worker Dashboard proxy',()=>{
  it('forwards card capabilities without granting a Dashboard identity',async()=>{
    const f=await fixture(),sid='11111111-1111-4111-8111-111111111111',token='a'.repeat(43);
    const result=await f.get(`/s/${sid}?viewToken=${token}`,{cookie:'botmux_dashboard_token=forged','x-platform-worker-token':'forged'});
    expect(result.status).toBe(200);expect(result.headers['set-cookie']).toBeUndefined();
    expect(f.seen.at(-1)?.url).toBe(`/terminal/${id}/s/${sid}?viewToken=${token}`);
    expect(f.seen.at(-1)?.headers.cookie).toBeUndefined();expect(f.seen.at(-1)?.headers['x-platform-worker-token']).toBeUndefined();
    for(const path of ['/api/status?viewToken='+token,`/s/${sid}`,`/s/${sid}/../api/status?viewToken=${token}`])expect((await f.get(path)).status).toBe(403);
  });
  it('relays RFB bytes through two WebSocket hops without leaking upstream cookies',async()=>{
    const f=await fixture(),{cookie}=await f.login();
    const outer=createServer();outer.on('upgrade',(req,socket,head)=>proxyUpgrade(req,socket,head,{url:`http://127.0.0.1:${f.port}`,headers:{host:f.host,cookie}}));
    const port=await listen(outer);
    await new Promise<void>((resolve,reject)=>{
      const socket=connect(port,'127.0.0.1',()=>socket.write('GET /websockify HTTP/1.1\r\nHost: public.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
      let bytes=Buffer.alloc(0);socket.setTimeout(3000,()=>{socket.destroy();reject(Error('RFB timeout'));});
      socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.includes(Buffer.from('RFB 003.008\n'))){expect(bytes.toString()).toContain('101 Switching Protocols');expect(bytes.toString()).not.toContain('must-not-leak');socket.destroy();resolve();}});socket.on('error',reject);
    });
  });
  it('keeps noVNC redirects on the public instance origin, not the private proxy prefix',async()=>{
    const f=await fixture(),{cookie}=await f.login();
    const redirect=await f.get('/',{cookie});expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('/vnc.html?autoconnect=1&resize=scale');
    const page=await f.get(redirect.headers.location!,{cookie});expect(page.status).toBe(200);
    expect(f.seen.at(-1)?.url).toBe(`/instance/${id}/vnc.html?autoconnect=1&resize=scale`);
    const target=new URL('http://sandbox:8090/v1/sandboxes/test/proxy/7891');
    for(const location of ['/v1/sandboxes/test/proxy/7891/vnc.html?autoconnect=1','http://sandbox:8090/v1/sandboxes/test/proxy/7891/vnc.html?autoconnect=1'])expect(publicProxyLocation(location,target)).toBe('/vnc.html?autoconnect=1');
    for(const location of ['/vnc.html','https://other.example/v1/sandboxes/test/proxy/7891/vnc.html','/v1/sandboxes/test/proxy/78910/vnc.html'])expect(publicProxyLocation(location,target)).toBe(location);
  });
  it('keeps server authority private and scopes the one-use link and cookie to one instance',async()=>{
    const f=await fixture();expect((await f.get('/')).status).toBe(403);
    const {link,response,cookie}=await f.login(true);expect(response.status).toBe(303);
    expect(response.headers['set-cookie']![0]).toContain('HttpOnly');expect(response.headers['set-cookie']![0]).toContain('; Secure');
    expect((await f.get('/'+new URL(link.url).search)).status).toBe(401);
    const result=await f.get('/api/status?x=1',{cookie,authorization:'Bearer browser-global','x-api-key':'browser-private',origin:`http://${f.host}`});
    expect(result.status).toBe(200);expect(result.text).toBe('worker');expect(result.headers['set-cookie']).toBeUndefined();expect(result.headers['cache-control']).toBe('no-store');
    expect(f.seen.at(-1)).toMatchObject({url:`/instance/${id}/api/status?x=1`,headers:{cookie:'botmux_session=native-private','x-api-key':'server-private'}});
    expect(f.seen.at(-1)?.headers.authorization).toBeUndefined();expect(f.seen.at(-1)?.headers.origin).toBeUndefined();
    expect((await f.get('/',{cookie,host:`w-${other}.localhost:${f.port}`})).status).toBe(403);
    expect((await f.get('/',{cookie,origin:'http://127.0.0.1:7891'})).status).toBe(403);
    f.rotate();expect((await f.get('/',{cookie})).status).toBe(403);
  });
  it('expires tickets and sessions and refuses traversal outside the private proxy prefix',async()=>{
    const f=await fixture(),{cookie}=await f.login();f.expire();expect((await f.get('/',{cookie})).status).toBe(403);
    for(const path of ['/../admin','/%2e%2e/admin','/%252e%252e/admin','/a%2f..%2fadmin','//evil.test','/a\\b','/%00','/%2525252e'])expect(()=>safeProxyPath(path)).toThrow();
    expect(safeProxyPath('/assets/main.js?next=https://example.com/a')).toBe('/assets/main.js?next=https://example.com/a');
  });
  it('streams without buffering and closes a live stream after global access is revoked',async()=>{
    const f=await fixture(),{cookie}=await f.login();
    await new Promise<void>((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:f.port,path:'/events',headers:{host:f.host,cookie}},res=>{
        res.once('data',chunk=>{expect(chunk.toString()).toBe('first-event\n');f.rotate();});
        res.on('close',()=>resolve());
      });req.on('error',reject);req.end();
    });
  },5000);
  it('authenticates WebSocket upgrades and revokes the existing connection',async()=>{
    const f=await fixture(),{cookie}=await f.login();
    await new Promise<void>((resolve,reject)=>{
      const socket=connect(f.port,'127.0.0.1',()=>socket.write(`GET /ws HTTP/1.1\r\nHost: ${f.host}\r\nCookie: ${cookie}\r\nOrigin: http://${f.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
      socket.once('data',chunk=>{expect(chunk.toString()).toContain('101 Switching Protocols');expect(f.seen.at(-1)?.headers.cookie).toBe('botmux_session=native-private');f.rotate();});
      socket.on('close',()=>resolve());socket.on('error',reject);
    });
  },5000);
});
