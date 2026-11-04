import {describe,expect,it} from 'vitest';
import {createRouteKindResolver} from '../src/platform/management/worker-dashboard-proxy.js';

describe('Worker dashboard route kind cache',()=>{
  const setup=(answers:Record<string,boolean>)=>{
    let time=0;const calls:string[]=[];
    const resolve=createRouteKindResolver({probes:['containers','logins','browsers'],now:()=>time,ttlMs:1000,
      probe:async(kind,id)=>{calls.push(kind+':'+id);return !!answers[kind];}});
    return {resolve,calls,advance:(ms:number)=>{time+=ms;}};
  };
  it('probes in order once and reuses the answering kind within the window',async()=>{
    const {resolve,calls,advance}=setup({logins:true});
    expect(await resolve('a')).toBe('logins');expect(await resolve('a')).toBe('logins');
    expect(calls).toEqual(['containers:a','logins:a']);
    advance(1001);expect(await resolve('a')).toBe('logins');
    expect(calls).toEqual(['containers:a','logins:a','containers:a','logins:a']);
  });
  it('rejects unknown targets without caching them',async()=>{
    const answers:Record<string,boolean>={};const {resolve,calls}=setup(answers);
    await expect(resolve('b')).rejects.toThrow('worker_unavailable');
    answers.browsers=true;expect(await resolve('b')).toBe('browsers');
    expect(calls.filter(c=>c==='containers:b')).toHaveLength(2);
  });
});
