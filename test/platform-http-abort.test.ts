import {afterEach,expect,it} from 'vitest';
import {createServer,type RequestListener,type Server} from 'node:http';
import {getEventListeners} from 'node:events';
import {getJson,postJson} from '../src/platform/platform-http.js';

const servers:Server[]=[];
async function endpoint(handler?:RequestListener){
 const server=createServer(handler??((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');});}));servers.push(server);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('no test endpoint');return 'http://127.0.0.1:'+address.port;
}
const settled=()=>new Promise<void>(resolve=>setImmediate(resolve));
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});

it.each(['GET','POST'] as const)('%s完成后共享signal的监听器不累积',async method=>{
 const url=await endpoint(),controller=new AbortController(),before=getEventListeners(controller.signal,'abort').length;
 for(let i=0;i<12;i++){
  const options={signal:controller.signal,timeoutMs:3000,freshConnection:true};
  const result=method==='GET'?await getJson(url,options):await postJson(url,{index:i},options);
  expect(result).toEqual({status:200,json:{ok:true}});expect(getEventListeners(controller.signal,'abort')).toHaveLength(before);
 }
 controller.abort();
});
it('预先中止不保留signal监听器',async()=>{
 const url=await endpoint(),controller=new AbortController();controller.abort();
 await expect(getJson(url,{signal:controller.signal})).rejects.toThrow();await settled();expect(getEventListeners(controller.signal,'abort')).toHaveLength(0);
});
it('响应等待期间仍能中止，结束后注销监听器',async()=>{
 let entered!:()=>void;const received=new Promise<void>(resolve=>entered=resolve),url=await endpoint(()=>entered()),controller=new AbortController();
 const pending=getJson(url,{signal:controller.signal,timeoutMs:3000});const checked=expect(pending).rejects.toThrow();await received;
 expect(getEventListeners(controller.signal,'abort').length).toBeGreaterThan(0);controller.abort();await checked;await settled();expect(getEventListeners(controller.signal,'abort')).toHaveLength(0);
});
it('超时和连接断开均注销signal监听器',async()=>{
 const timeout=await endpoint(()=>{}),reset=await endpoint(req=>req.socket.destroy()),controller=new AbortController();
 await expect(getJson(timeout,{signal:controller.signal,timeoutMs:30})).rejects.toThrow();await settled();expect(getEventListeners(controller.signal,'abort')).toHaveLength(0);
 await expect(postJson(reset,{}, {signal:controller.signal,timeoutMs:3000})).rejects.toThrow();await settled();expect(getEventListeners(controller.signal,'abort')).toHaveLength(0);
});
