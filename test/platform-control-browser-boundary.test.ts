import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createControlBrowserBoundary} from '../src/platform/management/control-browser-boundary.js';
it('protects native Control APIs and shell framing without changing Worker/unmanaged behavior',()=>{
  const dir=mkdtempSync(join(tmpdir(),'control-origin-')),path=join(dir,'role');
  try{
    writeFileSync(path,'control');const boundary=createControlBrowserBoundary(path);let status=0;const headers:Record<string,string>={};
    const res={setHeader:(key:string,value:string)=>headers[key]=value,writeHead:(v:number)=>status=v,end:()=>{}} as any;
    const foreign={method:'PUT',headers:{host:'control.example.com',origin:'https://worker.example.com'}} as any;
    expect(boundary(foreign,res,'/api/settings')).toBe(true);expect(status).toBe(403);
    expect(boundary({method:'POST',headers:{host:'127.0.0.1:7891'}} as any,res,'/__cli/ensure')).toBe(false);
    expect(boundary({method:'GET',headers:{host:'control.example.com'}} as any,res,'/')).toBe(false);
    expect(headers['content-security-policy']).toContain("frame-ancestors 'self'");
    writeFileSync(path,'worker');expect(createControlBrowserBoundary(path)(foreign,res,'/api/settings')).toBe(false);
    expect(createControlBrowserBoundary(join(dir,'absent'))(foreign,res,'/api/settings')).toBe(false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
