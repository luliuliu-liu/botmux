/** Optional host seam; upstream installations retain their original pool. */
import type {RunNode} from './contract.js';
import type {AttemptLeaseProvider} from './runtime-host-contract.js';
export type ExecutionBackend={runNode:RunNode;attemptLeaseProvider:AttemptLeaseProvider};
let resolve:((runDir:string)=>ExecutionBackend|undefined)|undefined;
export function configureExecutionBackend(value:typeof resolve){resolve=value;}
export function resolveExecutionBackend(runDir:string){return resolve?.(runDir);}
