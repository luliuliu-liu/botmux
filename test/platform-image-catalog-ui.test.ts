import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const {api}=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('../src/dashboard/web/platform/management-page.js',()=>({platformApi:api,Modal:({children}:any)=>React.createElement('section',{},children)}));
import {ImageCatalog,catalogImages,type CatalogAgent} from '../src/dashboard/web/platform/image-catalog.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const id='sha256:'+'a'.repeat(64);
const agent:CatalogAgent={id:'pi',name:'Pi',supported:true,version:'fixture',authMethods:['api-key'],images:[{id:'native',image:'worker-agent:pi-fixture',label:'Pi'}]};
const local={id,tags:['registry.example/team/worker-agent:pi-fixture'],agents:['pi'],roles:['worker'],size:10,architecture:'arm64',os:'linux'};
const cache={images:[local],remote:[],sources:['registry.example/team'],updatedAt:null,hostArch:'arm64'};
let renderer:TestRenderer.ReactTestRenderer;
beforeEach(()=>{vi.useFakeTimers();api.mockResolvedValue(cache);});
afterEach(()=>{if(renderer)act(()=>renderer.unmount());api.mockReset();vi.useRealTimers();});
async function mount(){await act(async()=>{renderer=TestRenderer.create(React.createElement(ImageCatalog,{agents:[agent]}));});}
const findButton=(text:string)=>renderer.root.findAllByType('button').find(button=>button.children.join('')===text)!;
async function expand(){await act(async()=>renderer.root.findByProps({className:'pm-image-toggle'}).props.onClick());}

it('merges identical local/remote content, excludes incompatible roles, and sorts native architecture first',()=>{
 const foreign={...local,id:'foreign',architecture:'amd64'},controlOnly={...local,id:'control',roles:['control']};
 const remote={...local,key:'remote',reference:'registry.example/team/worker-agent:pi-fixture',tag:'pi-fixture',registry:'registry.example/team',digest:id};
 const entries=catalogImages(agent,{...cache,images:[foreign,controlOnly,local],remote:[remote]});
 expect(entries.map(entry=>entry.id)).toEqual([id,'foreign']);
 expect(entries[0]?.local).toBe(local);expect(entries[0]?.remote).toEqual([remote]);
});
const openMenu=async()=>{await act(async()=>renderer.root.findByProps({className:'pm-actions-trigger',type:'button'}).props.onClick());};
it('opening version details performs no image mutation; deletion hides behind the ⋯ menu and a second click',async()=>{
 await mount();await expand();
 expect(api.mock.calls.every(([,method])=>method!=='POST')).toBe(true);
 await openMenu();
 await act(async()=>findButton('删除').props.onClick());
 expect(api.mock.calls.every(([,method])=>method!=='POST')).toBe(true);
 await act(async()=>findButton('确认删除').props.onClick());
 expect(api).toHaveBeenLastCalledWith('/image-cache/remove','POST',{id});
});
it('delete confirmation expires without deleting an image',async()=>{
 await mount();await expand();await openMenu();await act(async()=>findButton('删除').props.onClick());
 await act(async()=>vi.advanceTimersByTime(5000));
 expect(findButton('删除')).toBeDefined();
 expect(api.mock.calls.some(([,method])=>method==='POST')).toBe(false);
});
it('pull-latest sends the selected registry/repository rather than a mutable local tag',async()=>{
 await mount();await expand();await openMenu();await act(()=>findButton('拉取最新').props.onClick());
 expect(api).toHaveBeenLastCalledWith('/image-cache/pull-latest','POST',{registry:'registry.example/team',repository:'worker-agent',agent:'pi',role:'worker'});
});
it('query cancellation reads credential choices but never queries or pulls a registry',async()=>{
 api.mockImplementation(async(path:string)=>path==='/credentials'?{credentials:[]}:cache);
 await mount();await act(async()=>findButton('查询远端仓库').props.onClick());
 await act(async()=>findButton('取消').props.onClick());
 expect(api.mock.calls.map(([path])=>path)).toEqual(['/image-cache','/credentials']);
});
it('uses the saved Docker credential host and editable default namespace',async()=>{
 api.mockImplementation(async(path:string)=>path==='/credentials'?{credentials:[{kind:'docker',credentialId:'acr',displayName:'ACR',endpoint:'registry.example',username:'team'}]}:cache);
 await mount();await act(async()=>findButton('查询远端仓库').props.onClick());
 const input=renderer.root.findAllByType('input').find(v=>v.props.placeholder==='仓库命名空间')!;expect(input.props.value).toBe('team');
 await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));
 expect(api).toHaveBeenLastCalledWith('/image-cache/registry','POST',{registry:'registry.example/team',credentialId:'acr'});
});
it('pulls selected remote images and retains failed selections for retry',async()=>{
 const remote={...local,id:'sha256:'+'b'.repeat(64),key:'remote-key',reference:'registry.example/team/worker-agent:pi-remote',tag:'pi-remote',registry:'registry.example/team',digest:id};
 const remoteCache={...cache,remote:[remote]};api.mockImplementation(async(path:string)=>{if(path==='/image-cache/pull')throw Error('offline');return remoteCache;});
 await mount();await expand();const checkbox=renderer.root.findByProps({type:'checkbox'});
 await act(async()=>checkbox.props.onChange({target:{checked:true}}));
 await act(async()=>findButton('拉取选中（1）').props.onClick());
 expect(api).toHaveBeenCalledWith('/image-cache/pull','POST',{key:'remote-key'});
 expect(renderer.root.findByProps({role:'alert'}).children.join('')).toContain('1 个失败');expect(renderer.root.findByProps({type:'checkbox'}).props.checked).toBe(true);
});
it('a failed image operation is visible and actions become available again',async()=>{
 await mount();await expand();
 api.mockRejectedValueOnce(new Error('fixture registry unavailable'));
 await openMenu();await act(async()=>findButton('拉取最新').props.onClick());
 expect(renderer.root.findByProps({role:'alert'}).children.join('')).toContain('fixture registry unavailable');
 expect(findButton('拉取最新').props.disabled).toBe(false);
});
