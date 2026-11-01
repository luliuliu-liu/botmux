/** Data-only execution boundary, shared by HTTP and future NATS transports. */
import {createHash} from 'node:crypto';
import type {V3GoalNode} from '../../workflows/v3/dag.js';
export const WORKER_COMMAND_SCHEMA='botmux-worker-command-v1';
export type InputProduct={from:string;name:string;kind:string;preview?:string;output?:string;data:string;sha256:string};
export type WorkerCommand={schema:typeof WORKER_COMMAND_SCHEMA;jobId:string;runId:string;attemptId:string;node:V3GoalNode;goal:string;inputs:InputProduct[];omitted?:unknown[];timeoutMs:number;conventionsVersion?:1;conventionsDigest?:string};
export const sha256=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
export function workerJobId(runId:string,attemptId:string):string{
  const value=sha256(JSON.stringify(['botmux-worker-v1',runId,attemptId])).slice(0,32);
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
export function validateWorkerCommand(value:WorkerCommand){
  if(value?.schema!==WORKER_COMMAND_SCHEMA||!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value.jobId)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId)||
    typeof value.attemptId!=='string'||!value.attemptId||value.attemptId.length>512||!value.node||value.node.type!=='goal'||typeof value.node.id!=='string'||
    typeof value.goal!=='string'||Buffer.byteLength(value.goal)>128*1024||!Number.isSafeInteger(value.timeoutMs)||value.timeoutMs<1000||value.timeoutMs>24*60*60_000||
    !Array.isArray(value.inputs)||value.inputs.length>128)throw new Error('invalid_worker_command');
  let bytes=0;
  if(value.conventionsVersion!==undefined&&value.conventionsVersion!==1)throw Error('unsupported_workflow_conventions');
  if(value.conventionsDigest!==undefined&&!/^[a-f0-9]{64}$/.test(value.conventionsDigest))throw Error('invalid_conventions_digest');
  for(const item of value.inputs){
    if(!item||typeof item.data!=='string'||typeof item.from!=='string'||typeof item.name!=='string'||typeof item.kind!=='string'||!item.kind||typeof item.sha256!=='string')throw new Error('invalid_worker_input');
    const data=Buffer.from(item.data,'base64');bytes+=data.length;
    if(data.toString('base64')!==item.data||sha256(data)!==item.sha256||bytes>4*1024*1024)throw new Error('invalid_worker_input');
  }
  if(Object.keys(value).some(key=>!['schema','jobId','runId','attemptId','node','goal','inputs','omitted','timeoutMs','conventionsVersion','conventionsDigest'].includes(key)))throw new Error('unknown_worker_command_field');
  return value;
}
export interface ExecutionTransport {
  reserve(attemptId:string):Promise<{jobId:string}>;
  submit(command:WorkerCommand):Promise<unknown>;
  inspect(jobId:string):Promise<unknown>;
  cancel(jobId:string):Promise<unknown>;
}
