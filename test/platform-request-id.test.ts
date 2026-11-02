import {describe,expect,it} from 'vitest';
import {newPlatformRequestId} from '../src/dashboard/web/platform/request-id.js';

const UUID_V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('platform request id',()=>{
  it('uses the native UUID implementation when available',()=>{
    expect(newPlatformRequestId({randomUUID:()=> 'native-id'})).toBe('native-id');
  });

  it('does not depend on randomUUID in an HTTP-like WebCrypto environment',()=>{
    const id=newPlatformRequestId({getRandomValues:bytes=>{for(let i=0;i<bytes.length;i++)bytes[i]=i;return bytes;}});
    expect(id).toMatch(UUID_V4);
  });

  it('still produces a UUID-shaped id without WebCrypto',()=>{
    expect(newPlatformRequestId({})).toMatch(UUID_V4);
  });

  it('uses secure random bytes when the native UUID implementation throws',()=>{
    let randomBytesUsed=false;
    expect(newPlatformRequestId({randomUUID:()=>{throw Error('unavailable');},getRandomValues:bytes=>{randomBytesUsed=true;return bytes;}})).toMatch(UUID_V4);
    expect(randomBytesUsed).toBe(true);
  });

  it('generates different keys for separate mutations without native UUID support',()=>{
    const crypto={getRandomValues:(bytes:Uint8Array)=>globalThis.crypto.getRandomValues(bytes)};
    const ids=Array.from({length:100},()=>newPlatformRequestId(crypto));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id=>UUID_V4.test(id))).toBe(true);
  });
});
