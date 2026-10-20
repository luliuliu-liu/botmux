import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeWorkerProxyIdentity,nativeWorkerTerminalLink} from '../src/platform/management/native-worker-proxy-auth.js';
it('accepts only the exact instance token in an immutable Worker image',()=>{
  const dir=mkdtempSync(join(tmpdir(),'worker-proxy-auth-')),role=join(dir,'role'),token='a'.repeat(43);
  const request=(proof:string)=>({headers:{'x-platform-worker-token':proof,host:'sandbox:7891',origin:'http://127.0.0.1:7891'}} as any);
  try{
    writeFileSync(role,'worker');const apply=createNativeWorkerProxyIdentity(()=>token,role);
    const valid=request(token);apply(valid);expect(valid.headers.cookie).toBe(`botmux_dashboard_token=${token}`);expect(valid.headers['x-platform-worker-token']).toBeUndefined();
    expect(nativeWorkerTerminalLink(valid,'abc','http://172.17.0.2:8800/s/abc?token=private')).toBe('/s/abc?token=private');
    expect(nativeWorkerTerminalLink(valid,'abc','https://riff.example/term?token=private')).toBe('https://riff.example/term?token=private');
    expect(nativeWorkerTerminalLink(valid,'abc','http://172.17.0.2:8800/s/other?token=private')).toBe('http://172.17.0.2:8800/s/other?token=private');
    const invalid=request('b'.repeat(43));apply(invalid);expect(invalid.headers.cookie).toBeUndefined();expect(invalid.headers.host).toBe('sandbox:7891');
    expect(nativeWorkerTerminalLink(invalid,'abc','http://172.17.0.2:8800/s/abc?token=private')).toBe('http://172.17.0.2:8800/s/abc?token=private');
    writeFileSync(role,'control');const control=request(token);createNativeWorkerProxyIdentity(()=>token,role)(control);expect(control.headers.cookie).toBeUndefined();
    const missing=request(token);createNativeWorkerProxyIdentity(()=>token,join(dir,'absent'))(missing);expect(missing.headers.cookie).toBeUndefined();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
