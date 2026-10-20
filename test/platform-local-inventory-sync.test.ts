import {afterEach,describe,expect,it,vi} from 'vitest';

const request=vi.hoisted(()=>vi.fn());
const enabled=vi.hoisted(()=>vi.fn(()=>true));
vi.mock('../src/platform/management/dashboard-api.js',()=>({platformRequest:request,platformManagementEnabled:enabled}));
vi.mock('../src/platform/management/local-inventory-lock.js',()=>({withLocalInventoryLock:(fn:()=>unknown)=>fn()}));
import {PlatformLocalInventory} from '../src/platform/management/local-inventory-sync.js';

describe('native local inventory without retired Pi transport',()=>{
  afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
  it('syncs claims and never fetches remote Bot credentials or forwards messages',async()=>{
    vi.useFakeTimers();request.mockResolvedValue({status:200});
    const inventory=new PlatformLocalInventory(()=>[{larkAppId:'cli_local',name:'Local'}]);
    inventory.start();await vi.advanceTimersByTimeAsync(10000);inventory.stop();
    expect(request.mock.calls.length).toBeGreaterThanOrEqual(2);
    for(const [path,method,body] of request.mock.calls){
      expect(path).toBe('/local-claims');expect(method).toBe('POST');
      expect(body.bots).toEqual([{appId:'cli_local',displayName:'Local'}]);
      expect(JSON.stringify(body)).not.toContain('appSecret');
    }
    const count=request.mock.calls.length;await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(count);
  });
});
