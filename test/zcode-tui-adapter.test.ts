import {describe,expect,it} from 'vitest';
import {createZcodeAdapter} from '../src/platform/management/zcode-tui-adapter.js';

describe('managed ZCode adapter',()=>{
  it('starts native TUI in official yolo mode so remote Feishu turns do not wait for a local approval',()=>{
    const adapter=createZcodeAdapter('/opt/agent/native/zcode');
    expect(adapter.buildArgs({
      sessionId:'botmux-session',
      resume:false,
      systemPrompt:undefined,
      triggerSource:'user',
    })).toEqual(['tui','--mode','yolo']);
  });
});
