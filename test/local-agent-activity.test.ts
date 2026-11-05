import {it,expect,vi,afterEach} from 'vitest';
import {probeLocalAgentActivity,waitForLocalAgentReady} from '../src/platform/management/local-agent-activity.js';
afterEach(()=>vi.useRealTimers());
it('认证响应证明空闲，离线和非法结构不冒充真实任务',async()=>{
 const read=async()=>Response.json({sessions:[{status:'idle'}]});expect(await probeLocalAgentActivity(['bot'],read)).toBe('idle');
 expect(await probeLocalAgentActivity(['bot'],async()=>null)).toBe('unavailable');
 expect(await probeLocalAgentActivity(['bot'],async()=>Response.json({}))).toBe('unavailable');
 expect(await probeLocalAgentActivity(['bot'],async()=>Response.json({sessions:[{}]}))).toBe('unavailable');
 expect(await probeLocalAgentActivity(['bot'],async()=>Response.json({sessions:[{status:'running'}]}))).toBe('busy');
 expect(await probeLocalAgentActivity(['offline','busy'],async id=>id==='offline'?null:Response.json([{status:'running'}]))).toBe('busy');
});
it('进程启动但尚未注册时等待认证就绪，不提前返回',async()=>{
 vi.useFakeTimers();let ready=false,done=false;const work=waitForLocalAgentReady(async()=>ready?'idle':'unavailable',{timeoutMs:1000}).then(()=>done=true);
 await vi.advanceTimersByTimeAsync(600);expect(done).toBe(false);ready=true;await vi.advanceTimersByTimeAsync(200);await work;expect(done).toBe(true);
});
it('真正忙碌立即拒绝，不通过等待掩盖新开始的任务',async()=>{
 await expect(waitForLocalAgentReady(async()=> 'busy')).rejects.toMatchObject({state:'busy'});
});
it('未知状态到期拒绝，挂起的IPC探针同样有界',async()=>{
 vi.useFakeTimers();const probe=vi.fn(()=>new Promise<never>(()=>{}));const work=waitForLocalAgentReady(probe,{timeoutMs:1000});const checked=expect(work).rejects.toMatchObject({state:'unavailable'});
 await vi.advanceTimersByTimeAsync(5000);await checked;expect(probe).toHaveBeenCalledOnce();
});
