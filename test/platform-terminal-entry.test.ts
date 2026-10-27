import {describe,it,expect} from 'vitest';
import {terminalCapabilityPath,terminalOnlyTarget} from '../src/platform/management/terminal-entry.js';
const sid='11111111-1111-4111-8111-111111111111',token='a'.repeat(43);
describe('isolated native terminal entry',()=>{
 it('allows only scoped terminal capability paths',()=>{
  expect(terminalCapabilityPath(`/s/${sid}?viewToken=${token}`)).toBe(true);
  expect(terminalCapabilityPath(`/s/${sid}/ws?token=${token}`)).toBe(true);
  for(const path of [`/api/platform/models?viewToken=${token}`,`/s/${sid}`,`/s/${sid}/%2e%2e/api?token=${token}`,`/s/${sid}/../api?token=${token}`,`//s/${sid}?token=${token}`,`/s/${sid}?token=${token}&viewToken=${token}`])expect(terminalCapabilityPath(path),path).toBe(false);
 });
 it('cannot turn a card capability into a native management identity',()=>{
  const target={url:'http://internal/proxy',headers:{'x-api-key':'sandbox-key','x-platform-worker-token':'dashboard-key',cookie:'management','x-botmux-terminal-control':'forged',host:'127.0.0.1'}};
  expect(terminalOnlyTarget(target).headers).toEqual({'x-api-key':'sandbox-key',host:'127.0.0.1'});
  expect(target.headers['x-platform-worker-token']).toBe('dashboard-key');
 });
});
