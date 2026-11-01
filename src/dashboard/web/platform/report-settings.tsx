import {ConfigHelp} from './compact-controls.js';
import {useState} from 'react';
import {platformApi} from './management-page.js';
export function ReportSettings({initial}:{initial:any}){
 const [value,setValue]=useState<any>(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 if(!value)return null;
 return <details className="pm-disclosure"><summary>Control 飞书报告发布身份</summary><ConfigHelp>用户授权由 Workflow 机器人发送链接。凭据只保留在 Control，任务不持发布权限。</ConfigHelp><label>发布应用 ID<input value={value.appId} disabled={busy} onChange={e=>setValue({...value,appId:e.target.value})}/></label><label>固定用户 open_id（可在授权后绑定）<input value={value.userOpenId} disabled={busy} onChange={e=>setValue({...value,userOpenId:e.target.value})}/></label><label>报告文件夹链接或 token<input value={value.folderToken} disabled={busy} onChange={e=>setValue({...value,folderToken:e.target.value})}/></label><button disabled={busy||!value.appId} onClick={async()=>{setBusy(true);setError('');try{setValue(await platformApi('/report-settings','PUT',value));}catch(e){setError(String(e));}finally{setBusy(false);}}}>保存发布配置</button>{error?<p role="alert">{error}</p>:null}</details>;
}
