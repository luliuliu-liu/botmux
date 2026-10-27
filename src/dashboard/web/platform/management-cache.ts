// Only non-secret list responses are cached, in this tab's memory. Authentication,
// credentials, login sessions, and arbitrary GET endpoints always bypass it.
const ttl:Record<string,number>={'/bots':30*60_000,'/models':60*60_000,'/containers':10*60_000,'/local-agent':10*60_000,'/catalog':60*60_000,'/workspaces':30*60_000,'/proxies':30*60_000};
const entries=new Map<string,{value:unknown;expires:number}>();
const pending=new Map<string,Promise<unknown>>();
let generation=0;
export function clearManagementCache(){generation++;entries.clear();pending.clear();}
export async function cachedManagementGet(path:string,load:()=>Promise<unknown>){
 const duration=ttl[path];if(!duration)return load();
 const entry=entries.get(path);if(entry&&entry.expires>Date.now())return structuredClone(entry.value);
 let promise=pending.get(path);
 if(!promise){const current=generation;promise=load().then(value=>{if(generation===current)entries.set(path,{value:structuredClone(value),expires:Date.now()+duration});return value;});pending.set(path,promise);const owned=promise;void promise.finally(()=>{if(pending.get(path)===owned)pending.delete(path);}).catch(()=>{});}
 return structuredClone(await promise);
}
