import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ModelAuthSelector} from '../src/dashboard/web/platform/model-auth-selector.js';
import {normalizeModelSelection,type ModelOption} from '../src/dashboard/web/platform/model-options.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>vi.unstubAllGlobals());
const models:ModelOption[]=[
 {profileId:'api',displayName:'API',provider:'anthropic',modelId:'chosen',modelIds:['chosen','other'],protocol:'anthropic-messages',authMethod:'api-key',enabled:true},
 {profileId:'subscription',displayName:'Subscription',provider:'vercel',modelId:'',protocol:'vercel-claude',authMethod:'api-key',enabled:true},
];
async function render(agentType:string,value:string){
 vi.stubGlobal('window',{location:{hash:''}});
 let renderer:TestRenderer.ReactTestRenderer;
 const changed=vi.fn();await act(async()=>{renderer=TestRenderer.create(React.createElement(ModelAuthSelector,{agentType,models,value,onChange:changed,authMethods:['api-key','oauth'],selectAriaLabel:'认证模型'}));});
 return {renderer:renderer!,changed};
}
describe('共享认证模型界面',()=>{
 it('Claude保留API与Vercel分组选项，不展示不能保存的纯OAuth',async()=>{
  const {renderer,changed}=await render('claude-code','["api","chosen"]');
  try{
   const select=renderer.root.findByType('select');const options=renderer.root.findAllByType('option');
   expect(options.some(option=>option.props.value==='[null,null]')).toBe(false);
   expect(options.some(option=>option.props.value==='["subscription",""]')).toBe(true);
   await act(async()=>select.props.onChange({target:{value:'["subscription",""]'}}));
   expect(normalizeModelSelection('claude-code',changed.mock.calls[0][0],null,models)).toEqual({authMethod:'api-key',modelProfileId:'subscription',modelId:null});
  }finally{await act(async()=>renderer.unmount());}
 });
 it.each(['codex','zcode'])('%s提供原生OAuth，只有Codex提供可固定模型字段',async agentType=>{
  const {renderer}=await render(agentType,'[null,null]');try{
   expect(renderer.root.findAllByType('option').some(option=>option.props.value==='[null,null]')).toBe(true);
   expect(renderer.root.findAllByType('input').length).toBe(agentType==='codex'?1:0);
  }finally{await act(async()=>renderer.unmount());}
 });
});
