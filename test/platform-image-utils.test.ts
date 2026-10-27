import {describe,it,expect} from 'vitest';
import {splitImageRef,remoteSourceOfTags,registryHostOfTags,imageDisplayName,imageOptionLabel,hostFirst} from '../src/dashboard/web/platform/image-utils.js';

describe('image catalogue reference and architecture presentation',()=>{
 it.each(['registry.example/team/worker-agent:pi-release','localhost:5000/team/worker-agent:pi-release'])(
  'separates source and image name for %s',reference=>{
   const host=reference.split('/')[0]!;
   expect(splitImageRef(reference)).toEqual({registry:host,short:'worker-agent:pi-release'});
   expect(remoteSourceOfTags([reference])).toEqual({registry:host+'/team',repository:'worker-agent'});
  });
 it('does not invent a registry for local or Docker namespace-only references',()=>{
  expect(splitImageRef('worker-agent:pi-release')).toEqual({registry:null,short:'worker-agent:pi-release'});
  expect(splitImageRef('library/node:24')).toEqual({registry:null,short:'library/node:24'});
  expect(remoteSourceOfTags(['worker-agent:pi-release'])).toBeNull();
 });
 it('deduplicates registry aliases for display without losing their source',()=>{
  const tags=['registry.example/team/dev-agent:release','dev-agent:release'];
  expect(imageDisplayName(tags,'sha256:'+'a'.repeat(64))).toBe('dev-agent:release');
  expect(registryHostOfTags(tags)).toBe('registry.example');
  expect(imageOptionLabel(tags,'id','arm64','arm64')).not.toContain('registry.example');
  expect(imageOptionLabel(tags,'id','amd64','arm64')).toContain('不可在本机运行');
 });
 it('sorts native images first without mutating inventory order',()=>{
  const foreign={id:'foreign',architecture:'amd64'},native={id:'native',architecture:'arm64'},images=[foreign,native];
  expect(hostFirst(images,'arm64')).toEqual([native,foreign]);
  expect(images).toEqual([foreign,native]);
  expect(hostFirst(images)).toEqual(images);
 });
});
