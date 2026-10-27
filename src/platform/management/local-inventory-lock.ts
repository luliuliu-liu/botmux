// Both platform inventory senders share this queue with local detach. A stale
// in-flight inventory must finish BEFORE releasing the exact local claim.
let tail:Promise<unknown>=Promise.resolve();
export function withLocalInventoryLock<T>(run:()=>Promise<T>):Promise<T>{
  const next=tail.then(run,run);tail=next.catch(()=>{});return next;
}
