/** Optional host seam; upstream installations retain their original pool. */
import type {RunNode,BotSnapshot} from './contract.js';
import type {V3Node} from './dag.js';
import type {AttemptLeaseProvider} from './runtime-host-contract.js';
export type ResourceWait={jobId:string;attemptId:string;nodeId:string;waitReason:string;poolId:string;selection:unknown;lastError?:string};
export type PrepareResource=(input:{runId:string;attemptId:string;node:V3Node;botSnapshot:BotSnapshot})=>{ready:boolean;cancelled?:boolean;wait?:ResourceWait;blocked?:{code:string;message:string}};
export type ExecutionBackend={runNode:RunNode;attemptLeaseProvider:AttemptLeaseProvider;prepareResource?:PrepareResource;resourceManaged?:()=>boolean};
let resolve:((runDir:string)=>ExecutionBackend|undefined)|undefined;
export function configureExecutionBackend(value:typeof resolve){resolve=value;}
export function resolveExecutionBackend(runDir:string){return resolve?.(runDir);}
