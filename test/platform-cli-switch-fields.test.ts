import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {CliSwitchFields} from '../src/dashboard/web/platform/cli-switch-fields.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;

const options=[{id:'claude',name:'Claude Code'},{id:'codex',name:'Codex'},{id:'gemini',name:'Gemini',disabled:true}];
const renderers:TestRenderer.ReactTestRenderer[]=[];
afterEach(()=>{for(const r of renderers.splice(0))act(()=>r.unmount());});
function render(props:Partial<React.ComponentProps<typeof CliSwitchFields>>={}){
 const all={value:'claude',onChange:vi.fn(),options,confirmed:false,onConfirm:vi.fn(),busy:false,hint:'hint text',...props};
 let r!:TestRenderer.ReactTestRenderer;act(()=>{r=TestRenderer.create(React.createElement('form',null,React.createElement(CliSwitchFields,all)));});renderers.push(r);
 return {r,props:all,select:()=>r.root.findByType('select'),checkbox:()=>r.root.findByProps({type:'checkbox'})};
}

describe('CliSwitchFields',()=>{
 it('renders one option per CLI with the selected value and per-option disabled state',()=>{
  const {select}=render({value:'codex'});
  expect(select().props.value).toBe('codex');
  const rendered=select().findAllByType('option');
  expect(rendered.map(o=>o.props.value)).toEqual(['claude','codex','gemini']);
  expect(rendered.map(o=>o.children.join(''))).toEqual(['Claude Code','Codex','Gemini']);
  expect(rendered.map(o=>!!o.props.disabled)).toEqual([false,false,true]);
  expect(select().props.required).toBe(true);
 });
 it('shows a disabled empty placeholder only when nothing is selected',()=>{
  const empty=render({value:''});
  const first=empty.select().findAllByType('option')[0];
  expect(first.props.value).toBe('');expect(first.props.disabled).toBe(true);
  expect(empty.select().findAllByType('option')).toHaveLength(options.length+1);
  const loading=render({value:'',loading:true});
  // The loading placeholder is distinguishable from the "pick one" placeholder.
  expect(loading.select().findAllByType('option')[0].children.join('')).not.toBe(first.children.join(''));
  expect(render({value:'claude'}).select().findAllByType('option').some(o=>o.props.value==='')).toBe(false);
 });
 it('shows the loading placeholder even when the current CLI is already known',()=>{
  const {select}=render({value:'claude',options:[],loading:true});
  const rendered=select().findAllByType('option');
  // The select value must match a rendered option, and that option is the loading one.
  expect(rendered.filter(o=>o.props.value===select().props.value)).toHaveLength(1);
  expect(rendered[0].props.disabled).toBe(true);
  expect(rendered[0].children.join('')).toBe(render({value:'',loading:true}).select().findAllByType('option')[0].children.join(''));
 });
 it('reports selection and confirmation changes to the parent',()=>{
  const {select,checkbox,props}=render();
  act(()=>select().props.onChange({target:{value:'codex'}}));
  expect(props.onChange).toHaveBeenCalledWith('codex');
  act(()=>checkbox().props.onChange({target:{checked:true}}));
  expect(props.onConfirm).toHaveBeenLastCalledWith(true);
  act(()=>checkbox().props.onChange({target:{checked:false}}));
  expect(props.onConfirm).toHaveBeenLastCalledWith(false);
 });
 it('reflects the confirmed prop and requires the confirmation checkbox',()=>{
  expect(render({confirmed:true}).checkbox().props.checked).toBe(true);
  const unconfirmed=render({confirmed:false}).checkbox();
  expect(unconfirmed.props.checked).toBe(false);expect(unconfirmed.props.required).toBe(true);
 });
 it('locks both controls while busy, but only the CLI picker while loading',()=>{
  const busy=render({busy:true});
  expect(busy.select().props.disabled).toBe(true);expect(busy.checkbox().props.disabled).toBe(true);
  const loading=render({loading:true});
  expect(loading.select().props.disabled).toBe(true);expect(loading.checkbox().props.disabled).toBe(false);
  const idle=render();
  expect(idle.select().props.disabled).toBe(false);expect(idle.checkbox().props.disabled).toBe(false);
 });
 it('renders the caller-supplied hint',()=>{
  const {r}=render({hint:'custom caller hint'});
  expect(r.root.findAll(node=>node.props['data-tip']==='custom caller hint')).toHaveLength(1);
 });
});
