import {spawnSync} from 'node:child_process';
export type PersistenceRequest={baseUrl:string;token:string;path:string;method?:string;body?:unknown};
export class PersistenceRequestError extends Error{
  constructor(readonly status:number,readonly code:string){super(`Workflow persistence: ${code}`);}
}
/** Preserve the upstream synchronous read/check/append boundary. This bounded
 * helper talks only to the resource API, never plans or executes a task. No
 * credential is placed in argv or inherited from the Control environment. */
const helper=String.raw`
import {readFileSync} from 'node:fs';
try{
 const input=JSON.parse(readFileSync(0,'utf8'));
 const target=new URL(input.baseUrl);
 if(!['http:','https:'].includes(target.protocol)||target.username||target.password||!/^\/runs(?:\/[A-Za-z0-9._-]+(?:\/(?:acquire|append|release|session|attempts(?:\/[0-9a-f-]{36}(?:\/(?:submit|cancel))?)?))?)?$/.test(input.path))throw new Error();
 const response=await fetch(input.baseUrl.replace(/\/$/,'')+'/internal/v1/workflow-storage'+input.path,{method:input.method||'GET',redirect:'error',
  headers:{authorization:'Bearer '+input.token,'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)}),signal:AbortSignal.timeout(15000)});
 const value=await response.json();
 console.log(JSON.stringify({ok:response.ok,status:response.status,value}));
}catch{console.log(JSON.stringify({ok:false,status:0,value:{error:'storage_unreachable'}}));}
`;
export type PersistenceRequester=(input:PersistenceRequest)=>any;
export function createPersistenceRequester(nodeBinary='/usr/local/bin/node'):PersistenceRequester{return input=>{
  const result=spawnSync(nodeBinary,['--input-type=module','--eval',helper],{
    input:JSON.stringify(input),encoding:'utf8',maxBuffer:64*1024*1024,timeout:20000,
    env:{PATH:process.env.PATH,HOME:process.env.HOME,...(process.env.NODE_EXTRA_CA_CERTS?{NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS}:{})},
  });
  if(result.error||result.status!==0)throw new PersistenceRequestError(0,'storage_unreachable');
  let response;try{response=JSON.parse(result.stdout);}catch{throw new PersistenceRequestError(0,'storage_invalid_response');}
  if(!response.ok){const code=response.value?.error;throw new PersistenceRequestError(response.status,typeof code==='string'&&/^[a-z_]{1,100}$/.test(code)?code:'storage_request_failed');}
  return response.value;
};}
export const requestPersistenceSync=createPersistenceRequester();
