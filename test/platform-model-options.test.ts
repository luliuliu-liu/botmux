import {describe,expect,it} from 'vitest';
import {configuredModelSelection,dynamicModel,idsOf,modelOptionLabel,modelGroupLabel,nativeOAuthSupported,normalizeModelSelection,normalizedAckModelId,type ModelOption} from '../src/dashboard/web/platform/model-options.js';

const base:ModelOption={profileId:'p1',displayName:'Main',provider:'openai',modelId:'gpt-default',enabled:true};

describe('model options',()=>{
 it('treats only CLI-selected-model protocols as dynamic',()=>{
  // Protocol identifiers are wire values shared with the backend model catalog.
  expect(dynamicModel({...base,protocol:'zcode-coding-plan'})).toBe(true);
  expect(dynamicModel({...base,protocol:'vercel-claude'})).toBe(true);
  expect(dynamicModel({...base,protocol:'openai-completions'})).toBe(false);
  expect(dynamicModel(base)).toBe(false);
 });
 it('offers a single empty id for dynamic models regardless of configured ids',()=>{
  expect(idsOf({...base,protocol:'vercel-claude',modelIds:['a','b']})).toEqual(['']);
  expect(idsOf({...base,protocol:'zcode-coding-plan'})).toEqual(['']);
 });
 it('lists all configured ids, falling back to the default model id when none are listed',()=>{
  expect(idsOf({...base,modelIds:['a','gpt-default','b']})).toEqual(['a','gpt-default','b']);
  expect(idsOf({...base,modelIds:[]})).toEqual(['gpt-default']);
  expect(idsOf(base)).toEqual(['gpt-default']);
 });
 it('labels static options by id and distinguishes the default id',()=>{
  const plain=modelOptionLabel(base,'other');
  expect(plain).toContain('other');
  const def=modelOptionLabel(base,'gpt-default');
  expect(def).toContain('gpt-default');
  expect(def).not.toBe('gpt-default');
  expect(modelOptionLabel(base,'gpt-default')).not.toBe(modelOptionLabel({...base,modelId:'x'},'gpt-default'));
 });
 it('gives each dynamic protocol its own label independent of the id',()=>{
  const vercel=modelOptionLabel({...base,protocol:'vercel-claude'},'');
  const zcode=modelOptionLabel({...base,protocol:'zcode-coding-plan'},'');
  expect(vercel).not.toBe(zcode);
  expect(modelOptionLabel({...base,protocol:'vercel-claude'},'ignored')).toBe(vercel);
  expect(vercel).not.toContain(base.modelId);
 });
 it('group label carries display name and provider and marks disabled profiles',()=>{
  const enabled=modelGroupLabel(base);
  expect(enabled).toContain('Main');expect(enabled).toContain('openai');
  const disabled=modelGroupLabel({...base,enabled:false});
  expect(disabled).not.toBe(enabled);
  expect(disabled.startsWith(enabled)).toBe(true);
 });
 it('admits native OAuth only for Codex and ZCode even when a catalog advertises it for Claude',()=>{
  expect(nativeOAuthSupported('codex',['api-key','oauth'])).toBe(true);
  expect(nativeOAuthSupported('zcode',['api-key','oauth'])).toBe(true);
  expect(nativeOAuthSupported('claude-code',['api-key','oauth'])).toBe(false);
  expect(nativeOAuthSupported('traex',['oauth'])).toBe(false);
 });
 it('normalizes ZCode OAuth and dynamic API connections to an empty model identity',()=>{
  expect(normalizeModelSelection('zcode',configuredModelSelection('oauth',null,null),'must-not-persist')).toEqual({authMethod:'oauth',modelProfileId:null,modelId:null});
  const dynamic={...base,profileId:'vercel',protocol:'vercel-claude'};
  expect(normalizeModelSelection('claude-code',JSON.stringify(['vercel','stale']),undefined,[dynamic])).toEqual({authMethod:'api-key',modelProfileId:'vercel',modelId:null});
  expect(normalizedAckModelId('zcode','oauth','stale')).toBeNull();
  expect(normalizedAckModelId('claude-code','api-key','stale','vercel-claude')).toBeNull();
 });
 it('keeps a trimmed optional Codex OAuth model and rejects Claude native OAuth',()=>{
  expect(normalizeModelSelection('codex','[null,null]','  gpt-native  ')).toEqual({authMethod:'oauth',modelProfileId:null,modelId:'gpt-native'});
  expect(()=>normalizeModelSelection('claude-code','[null,null]','')).toThrow('不支持');
 });
});
