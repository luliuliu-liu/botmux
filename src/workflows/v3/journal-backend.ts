/** Host-provided persistence seam. The default remains the original file
 * journal; platform implementations live outside the Workflow engine. */
import type {JournalMutation,StoredEvent} from './event-contract.js';
export interface JournalBackend{
  read():StoredEvent[];
  withMutationSync<T>(fn:(mutation:JournalMutation)=>T):T;
}
export type JournalBackendResolver=(path:string,operation:'read'|'mutation')=>JournalBackend|undefined;
let resolver:JournalBackendResolver|undefined;
export function configureJournalBackend(value:JournalBackendResolver|undefined){resolver=value;}
export function resolveJournalBackend(path:string,operation:'read'|'mutation'){return resolver?.(path,operation);}
