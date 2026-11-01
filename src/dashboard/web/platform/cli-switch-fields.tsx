import {ConfigHelp} from './compact-controls.js';
type CliOption={id:string;name:string;disabled?:boolean};

/** Common picker used by local Bots and Dev Agent instances. */
export function CliSwitchFields({value,onChange,options,confirmed,onConfirm,busy,hint,loading=false}:{
 value:string;onChange:(value:string)=>void;options:CliOption[];confirmed:boolean;onConfirm:(value:boolean)=>void;busy:boolean;hint:string;loading?:boolean;
}){
 return <>
  <label>CLI<select aria-label="CLI" value={value} onChange={e=>onChange(e.target.value)} disabled={busy||loading} required>
   {!value||loading?<option value={loading?value:''} disabled>{loading?'正在读取 CLI 列表…':'请选择 CLI'}</option>:null}
   {options.map(option=><option key={option.id} value={option.id} disabled={option.disabled}>{option.name}</option>)}
  </select></label>
  <ConfigHelp>{hint}</ConfigHelp>
  <label className="pm-check"><input type="checkbox" required checked={confirmed} onChange={e=>onConfirm(e.target.checked)} disabled={busy}/><span>确认切换 CLI 并关闭旧 CLI 的空闲会话</span></label>
 </>;
}
