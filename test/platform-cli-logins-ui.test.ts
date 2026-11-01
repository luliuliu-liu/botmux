import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const api=vi.hoisted(()=>({platformApi:vi.fn()}));
// Stub the shared management module: platformApi is the network seam; Modal is a
// passthrough that exposes its busy prop so the dialog's lock state is observable.
vi.mock('../src/dashboard/web/platform/management-page.js',async()=>{
 const React=await import('react');
 return {platformApi:api.platformApi,Modal:({title,busy,onClose,children}:any)=>React.createElement('section',{'data-modal':title,'data-busy':!!busy},
  React.createElement('button',{type:'button','aria-label':'modal-close',disabled:busy,onClick:onClose}),children)};
});
import {CliLoginDialog} from '../src/dashboard/web/platform/cli-logins.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;

const profiles=[
 {profileId:'gp-1',displayName:'Work',githubAccount:'octo',registrationState:'registered'},
 {profileId:'gp-2',displayName:'Pending',githubAccount:'pend',registrationState:'pending'},
];
const credentials=[
 {credentialId:'dk-1',displayName:'Registry',kind:'docker',endpoint:'registry.example.com'},
 {credentialId:'ak-1',displayName:'API',kind:'api-key',endpoint:'https://api.example.com'},
];
let state:{logins:any[];capabilities:any};
let postResult:(()=>Promise<any>)|null;
beforeEach(()=>{
 state={logins:[],capabilities:{github:true,docker:true}};postResult=null;
 api.platformApi.mockReset();
 api.platformApi.mockImplementation(async(path:string,method='GET',body?:any)=>{
  if(method==='POST'){if(postResult)return postResult();state.logins=[...state.logins.filter(l=>!path.endsWith('/'+l.cli)),{cli:path.split('/').pop(),desiredId:body.id,revision:body.revision+1,synced:true,verification:'verified'}];return {ok:true};}
  if(path==='/github-git-profiles')return {profiles};
  if(path==='/credentials')return {credentials};
  if(path.startsWith('/cli-logins/'))return {logins:state.logins,capabilities:state.capabilities};
  throw new Error('unexpected '+path);
 });
});
const renderers:TestRenderer.ReactTestRenderer[]=[];
afterEach(()=>{for(const r of renderers.splice(0))act(()=>r.unmount());});
async function mount(target='agent-1',onClose=vi.fn()){let r!:TestRenderer.ReactTestRenderer;await act(async()=>{r=TestRenderer.create(React.createElement(CliLoginDialog,{target,onClose}));});renderers.push(r);return {r,onClose};}
const sections=(r:TestRenderer.ReactTestRenderer)=>r.root.findAll(n=>n.type==='div'&&n.props.className==='pm-info-note');
const section=(r:TestRenderer.ReactTestRenderer,index:number)=>sections(r)[index];
const loginButton=(node:TestRenderer.ReactTestInstance)=>node.findByType('button');
const modal=(r:TestRenderer.ReactTestRenderer)=>r.root.find(n=>n.type==='section'&&'data-modal' in n.props);
const posts=()=>api.platformApi.mock.calls.filter(([,method])=>method==='POST');
const alerts=(r:TestRenderer.ReactTestRenderer)=>r.root.findAll(n=>n.type==='p'&&n.props.role==='alert').map(n=>n.children.join(''));

describe('CliLoginDialog',()=>{
 it('ignores a slow load for a previous target or a closed dialog',async()=>{
  let release:(()=>void)|undefined;const gate=new Promise<void>(done=>{release=done;});
  const base=api.platformApi.getMockImplementation()!;
  api.platformApi.mockImplementation(async(path:string,...rest:any[])=>{if(path==='/cli-logins/old'){await gate;return {logins:[],capabilities:{github:false,docker:true}};}return base(path,...rest);});
  let r!:TestRenderer.ReactTestRenderer;
  await act(async()=>{r=TestRenderer.create(React.createElement(CliLoginDialog,{target:'old',onClose:vi.fn()}));});renderers.push(r);
  await act(async()=>{r.update(React.createElement(CliLoginDialog,{target:'new',onClose:vi.fn()}));});
  expect(sections(r)).toHaveLength(2);
  await act(async()=>{release!();await gate;});
  expect(sections(r)).toHaveLength(2);
 });
 it('loads profiles, credentials and the target agent login state',async()=>{
  await mount('control');
  const paths=api.platformApi.mock.calls.map(([path])=>path);
  expect(paths).toEqual(expect.arrayContaining(['/github-git-profiles','/credentials','/cli-logins/control']));
  expect(api.platformApi.mock.calls.every(([,method])=>method===undefined||method==='GET')).toBe(true);
 });
 it('shows a section per advertised capability and none before capabilities are known',async()=>{
  expect(sections((await mount()).r)).toHaveLength(2);
  state.capabilities={github:false,docker:true};
  const docker=(await mount()).r;
  expect(sections(docker)).toHaveLength(1);
  expect(section(docker,0).findByType('select').findAllByType('option').map(o=>o.props.value)).toEqual(['','dk-1']);
  state.capabilities=undefined;
  const unknown=(await mount()).r;
  expect(sections(unknown)).toHaveLength(0);
  // An explanatory notice replaces the sections.
  expect(unknown.root.findAll(n=>n.type==='p').length).toBeGreaterThan(0);expect(unknown.root.findAll(n=>typeof n.props['data-tip']==='string').length).toBeGreaterThan(0);
 });
 it('offers only registered GitHub profiles and only Docker credentials',async()=>{
  const {r}=await mount();
  const github=section(r,0).findByType('select').findAllByType('option').map(o=>o.props.value);
  const docker=section(r,1).findByType('select').findAllByType('option').map(o=>o.props.value);
  expect(github).toEqual(['','gp-1']);
  expect(docker).toEqual(['','dk-1']);
  const label=section(r,0).findAllByType('option')[1].children.join('');
  expect(label).toContain('Work');expect(label).toContain('octo');
 });
 it('disables login until a configuration is chosen, then posts it with revision 0 for a new login',async()=>{
  const {r}=await mount('agent-7');
  expect(loginButton(section(r,0)).props.disabled).toBe(true);
  await act(async()=>section(r,0).findByType('select').props.onChange({target:{value:'gp-1'}}));
  expect(section(r,0).findByType('select').props.value).toBe('gp-1');
  expect(loginButton(section(r,0)).props.disabled).toBe(false);
  await act(async()=>loginButton(section(r,0)).props.onClick());
  expect(posts()).toEqual([['/cli-logins/agent-7/github','POST',{id:'gp-1',revision:0}]]);
  // The dialog reloads the login state after a successful login.
  expect(section(r,0).findByType('small').children.join('')).not.toBe('');
  expect(alerts(r)).toEqual([]);
 });
 it('preselects the stored login and sends its revision for optimistic concurrency',async()=>{
  state.logins=[{cli:'docker',desiredId:'dk-1',revision:5,synced:false,verification:'pending'}];
  const {r}=await mount();
  expect(section(r,1).findByType('select').props.value).toBe('dk-1');
  expect(loginButton(section(r,1)).props.disabled).toBe(false);
  await act(async()=>loginButton(section(r,1)).props.onClick());
  expect(posts()).toEqual([['/cli-logins/agent-1/docker','POST',{id:'dk-1',revision:5}]]);
 });
 it('describes synced/verification state differently per login record',async()=>{
  state.logins=[{cli:'github',desiredId:'gp-1',revision:1,synced:true,verification:'verified'},{cli:'docker',desiredId:'dk-1',revision:1,synced:false,verification:'failed'}];
  const {r}=await mount();
  const github=section(r,0).findByType('small').children.join(''),docker=section(r,1).findByType('small').children.join('');
  expect(github).not.toBe(docker);
  state.logins=[];
  const none=section((await mount()).r,0).findByType('small').children.join('');
  expect([github,docker]).not.toContain(none);
 });
 it('shows a per-CLI last error from the agent',async()=>{
  state.logins=[{cli:'github',desiredId:'gp-1',revision:1,synced:false,verification:'failed',lastError:'gh auth status failed'}];
  const {r}=await mount();
  expect(section(r,0).findAll(n=>n.type==='p'&&n.props.role==='alert').map(n=>n.children.join(''))).toEqual(['gh auth status failed']);
  expect(section(r,1).findAll(n=>n.type==='p'&&n.props.role==='alert')).toHaveLength(0);
 });
 it('locks the dialog while a login is in flight and unlocks afterwards',async()=>{
  let release!:(value:any)=>void;postResult=()=>new Promise(resolve=>release=resolve);
  const {r}=await mount();
  await act(async()=>section(r,0).findByType('select').props.onChange({target:{value:'gp-1'}}));
  await act(async()=>loginButton(section(r,0)).props.onClick());
  expect(modal(r).props['data-busy']).toBe(true);
  expect(sections(r).map(s=>loginButton(s).props.disabled)).toEqual([true,true]);
  const close=r.root.findAll(n=>n.type==='footer')[0].findByType('button');
  expect(close.props.disabled).toBe(true);
  await act(async()=>release({ok:true}));
  expect(modal(r).props['data-busy']).toBe(false);
  expect(close.props.disabled).toBe(false);
 });
 it('shows the server error after a failed login and refreshes the state',async()=>{
  postResult=async()=>{throw new Error('docker login rejected');};
  const {r}=await mount();
  await act(async()=>section(r,1).findByType('select').props.onChange({target:{value:'dk-1'}}));
  const before=api.platformApi.mock.calls.filter(([path])=>path==='/cli-logins/agent-1').length;
  await act(async()=>loginButton(section(r,1)).props.onClick());
  expect(alerts(r).some(text=>text.includes('docker login rejected'))).toBe(true);
  expect(api.platformApi.mock.calls.filter(([path])=>path==='/cli-logins/agent-1').length).toBeGreaterThan(before);
  expect(loginButton(section(r,1)).props.disabled).toBe(false);
 });
 it('clears a previous error when retrying',async()=>{
  let fail=true;postResult=async()=>{if(fail)throw new Error('first failure');return {ok:true};};
  const {r}=await mount();
  await act(async()=>section(r,0).findByType('select').props.onChange({target:{value:'gp-1'}}));
  await act(async()=>loginButton(section(r,0)).props.onClick());
  expect(alerts(r).some(t=>t.includes('first failure'))).toBe(true);
  fail=false;
  await act(async()=>loginButton(section(r,0)).props.onClick());
  expect(alerts(r).some(t=>t.includes('first failure'))).toBe(false);
 });
 it('shows a load error when the initial fetch fails',async()=>{
  api.platformApi.mockImplementation(async(path:string)=>{if(path==='/credentials')throw new Error('credentials unavailable');return path==='/github-git-profiles'?{profiles}:{logins:[],capabilities:{github:true,docker:true}};});
  const {r}=await mount();
  expect(alerts(r).some(t=>t.includes('credentials unavailable'))).toBe(true);
 });
 it('reloads when the target changes and closes via the footer button',async()=>{
  const onClose=vi.fn();
  const {r}=await mount('agent-1',onClose);
  await act(async()=>r.update(React.createElement(CliLoginDialog,{target:'agent-2',onClose})));
  expect(api.platformApi.mock.calls.map(([path])=>path)).toContain('/cli-logins/agent-2');
  act(()=>r.root.findAll(n=>n.type==='footer')[0].findByType('button').props.onClick());
  expect(onClose).toHaveBeenCalledTimes(1);
 });
});
