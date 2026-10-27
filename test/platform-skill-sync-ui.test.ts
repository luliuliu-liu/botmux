import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import {it,expect,vi,afterEach} from 'vitest';
const {api}=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('../src/dashboard/web/platform/management-page.js',()=>({platformApi:api,Modal:({children,title}:any)=>React.createElement('section',{'aria-label':title},children)}));
import {SkillSyncDialog} from '../src/dashboard/web/platform/skill-sync-dialog.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const workers=[{id:'one',name:'Pi Worker',agentType:'pi',status:'ready',revision:2,supported:true,ready:true},{id:'two',name:'Codex Worker',agentType:'codex',status:'ready',revision:4,supported:true,ready:true},{id:'dsh',name:'DSH',agentType:'dsh',status:'ready',revision:1,supported:false,ready:true}];
let renderer:TestRenderer.ReactTestRenderer;
afterEach(()=>{if(renderer)act(()=>renderer.unmount());api.mockReset();});
it('loads workers without writing, supports multi-selection, keeps successes when another worker fails, and treats skips as success',async()=>{
 api.mockImplementation(async(path:string,method='GET')=>{if(method==='GET')return {workers};if(path.endsWith('two'))throw Error('Codex Worker 暂时不可用');return {applied:true,installed:[],skipped:['fixture']};});
 await act(async()=>{renderer=TestRenderer.create(React.createElement(SkillSyncDialog,{names:['fixture'],onClose:vi.fn()}));});
 expect(api).toHaveBeenCalledTimes(1);expect(api.mock.calls[0][0]).toBe('/skill-sync');
 expect(renderer.root.findByProps({'aria-label':'选择 DSH'}).props.disabled).toBe(true);
 await act(async()=>renderer.root.findByProps({'aria-label':'全选可同步的 Worker'}).props.onChange({target:{checked:true}}));
 const button=renderer.root.findAllByType('button').find(node=>node.props.className==='primary')!;
 await act(async()=>button.props.onClick());
 expect(api.mock.calls.filter(([,method])=>method==='POST').map(([path,,body])=>({path,body}))).toEqual([{path:'/skill-sync/one',body:{revision:2,names:['fixture']}},{path:'/skill-sync/two',body:{revision:4,names:['fixture']}}]);
 const text=JSON.stringify(renderer.toJSON());expect(text).toContain('新增 0 个，跳过 1 个同名 Skill');expect(text).toContain('Codex Worker 暂时不可用');
});
it('cancels the dialog without sending selected Skill content',async()=>{
 api.mockResolvedValue({workers});const close=vi.fn();
 await act(async()=>{renderer=TestRenderer.create(React.createElement(SkillSyncDialog,{names:['fixture'],onClose:close}));});
 await act(async()=>renderer.root.findAllByType('button').find(node=>node.children.join('')==='取消')!.props.onClick());
 expect(close).toHaveBeenCalledOnce();expect(api).toHaveBeenCalledTimes(1);
});
