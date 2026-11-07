import {expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {createPersistenceRequester,PersistenceRequestError,requestPersistence} from '../src/platform/workflow/sync-request.js';
it('uses the actual bounded helper, authenticates only the workflow API and never follows redirects',async()=>{
  const fixture=String.raw`
    import {createServer} from 'node:http';
    const server=createServer((req,res)=>{
      if(req.url.endsWith('/redirect')){res.writeHead(302,{location:'/should-not-follow'});res.end();return;}
      if(req.url.endsWith('/unauthorized')){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:'workflow_identity_required'}));return;}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({authorization:req.headers.authorization,masterHeader:req.headers['x-api-key']||null,path:req.url}));
    });
    server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
  `;
  const server=spawn(process.execPath,['--input-type=module','--eval',fixture],{stdio:['ignore','pipe','pipe']});server.stderr.resume();
  try{
    const port=await new Promise<number>((resolve,reject)=>{server.once('error',reject);server.stdout.once('data',chunk=>resolve(JSON.parse(chunk.toString()).port));});
    const request=createPersistenceRequester(process.execPath),input={baseUrl:`http://127.0.0.1:${port}`,token:'run-scoped-only',path:'/runs/test'};
    expect(request(input)).toEqual({authorization:'Bearer run-scoped-only',masterHeader:null,path:'/internal/v1/workflow-storage/runs/test'});
    const job='11111111-1111-1111-1111-111111111111';
    for(const path of ['/agent-pools','/agent-pools/'+job,`/agent-pools/${job}/workspace`,`/agent-pools/${job}/input-preflight`,'/model-catalog',`/runs/test/attempts/${job}/prepare`,`/runs/test/resources`,`/runs/test/resources/${job}/resolve`,`/runs/test/resources/${job}/cancel`]){
      expect(request({...input,path})).toMatchObject({path:'/internal/v1/workflow-storage'+path,authorization:'Bearer run-scoped-only'});
    }
    for(const path of ['/agent-pools/../../admin',`/agent-pools/${job}/workspace-extra`,`/agent-pools/${job}/workspace/admin`,`/agent-pools/${'0'.repeat(36)}/workspace`,`/agent-pools/${job}/%77orkspace`,`/agent-pools/${job}/workspace/../admin`]){
      expect(()=>request({...input,path})).toThrow('storage_unreachable');
      await expect(requestPersistence({...input,path})).rejects.toMatchObject({status:0,code:'storage_unreachable'});
    }
    expect(()=>request({...input,path:'/runs/redirect'})).toThrow('storage_unreachable');
    try{request({...input,path:'/runs/unauthorized'});throw new Error('expected rejection');}catch(error){expect(error).toBeInstanceOf(PersistenceRequestError);expect((error as PersistenceRequestError).status).toBe(401);}
    expect(()=>request({...input,path:'/runs/test/../../admin'})).toThrow('storage_unreachable');
    // The non-blocking requester keeps the same path allowlist and error contract.
    expect(await requestPersistence(input)).toEqual({authorization:'Bearer run-scoped-only',masterHeader:null,path:'/internal/v1/workflow-storage/runs/test'});
    expect(await requestPersistence({...input,path:`/agent-pools/${job}/workspace`})).toEqual({authorization:'Bearer run-scoped-only',masterHeader:null,path:`/internal/v1/workflow-storage/agent-pools/${job}/workspace`});
    for(const path of ['/agent-pools/../../admin','/runs/test/../../admin','/internal'])await expect(requestPersistence({...input,path})).rejects.toMatchObject({status:0,code:'storage_unreachable'});
    await expect(requestPersistence({...input,path:'/runs/redirect'})).rejects.toMatchObject({status:0,code:'storage_unreachable'});
    await expect(requestPersistence({...input,path:'/runs/unauthorized'})).rejects.toMatchObject({status:401,code:'workflow_identity_required'});
    await expect(requestPersistence({...input,baseUrl:`http://user:pass@127.0.0.1:${port}`})).rejects.toMatchObject({status:0});
  }finally{server.kill('SIGTERM');await new Promise<void>(resolve=>server.once('exit',()=>resolve()));}
},10000);
