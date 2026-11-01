import {afterEach,expect,it,vi} from 'vitest';
import {cachedManagementGet,clearManagementCache} from '../src/dashboard/web/platform/management-cache.js';
afterEach(()=>{clearManagementCache();vi.useRealTimers();});
it('serves cross-tab list changes only after an explicit refresh and keeps fresh in-flight ownership',async()=>{
 let containers=[{containerId:'old',poolId:null}],release!:(value:unknown)=>void;
 const load=vi.fn(async()=>({containers:structuredClone(containers)}));
 await cachedManagementGet('/containers',load);containers=[{containerId:'fresh',poolId:'other-pool'}];
 expect(await cachedManagementGet('/containers',load)).toEqual({containers:[{containerId:'old',poolId:null}]});
 clearManagementCache();expect(await cachedManagementGet('/containers',load)).toEqual({containers});expect(load).toHaveBeenCalledTimes(2);
 clearManagementCache();const stale=cachedManagementGet('/models',()=>new Promise(resolve=>release=resolve));
 clearManagementCache();const fresh=vi.fn(async()=>({models:['new']}));await cachedManagementGet('/models',fresh);
 release({models:['stale']});await stale;
 expect(await cachedManagementGet('/models',fresh)).toEqual({models:['new']});expect(fresh).toHaveBeenCalledOnce();
});
it('caches non-secret lists until their respective TTL and returns independent copies',async()=>{
 vi.useFakeTimers();const load=vi.fn(async()=>({items:[1]}));
 const first=await cachedManagementGet('/containers',load) as {items:number[]};first.items.push(2);
 expect(await cachedManagementGet('/containers',load)).toEqual({items:[1]});expect(load).toHaveBeenCalledTimes(1);
 vi.advanceTimersByTime(10*60_000);await cachedManagementGet('/containers',load);expect(load).toHaveBeenCalledTimes(2);
 await cachedManagementGet('/models',load);vi.advanceTimersByTime(30*60_000);await cachedManagementGet('/models',load);expect(load).toHaveBeenCalledTimes(3);
});
it('never caches credential endpoints or failures',async()=>{
 const load=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({ok:true});
 await expect(cachedManagementGet('/models',load)).rejects.toThrow('offline');await cachedManagementGet('/models',load);
 await cachedManagementGet('/credentials',load);await cachedManagementGet('/credentials',load);expect(load).toHaveBeenCalledTimes(4);
});
it('does not cache a request that completed after invalidation',async()=>{
 let resolve!:(v:unknown)=>void;const load=vi.fn(()=>new Promise(r=>resolve=r));
 const old=cachedManagementGet('/models',load);clearManagementCache();resolve({revision:1});await old;
 const fresh=vi.fn(async()=>({revision:2}));expect(await cachedManagementGet('/models',fresh)).toEqual({revision:2});expect(fresh).toHaveBeenCalledOnce();
});
