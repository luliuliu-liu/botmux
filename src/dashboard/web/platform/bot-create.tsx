import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BotOnboardingSnapshot as Job } from '../../bot-onboarding.js';

type Session={status:'ready';confirmationToken:string;identity:{userName:string;tenantName:string;email?:string}}|{status:'scan_required'|'unknown'};
type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;
export function PlatformBotCreate({api,onClose,onDone}:{api:Api;onClose:()=>void;onDone:(m:string)=>void}){
  const dialog=useRef<HTMLDialogElement>(null),mounted=useRef(true),submitting=useRef(false);
  const [job,setJob]=useState<Job|null>(null),[target,setTarget]=useState('pool'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [session,setSession]=useState<Session|null>(null),[mode,setMode]=useState<'checking'|'reuse'|'qr'|'unavailable'>('checking');
  const check=async()=>{
    setMode('checking');setSession(null);
    try{const result=await api('/onboarding/session');if(mounted.current){setSession(result.session);setMode(result.session.status==='ready'?'reuse':result.session.status==='scan_required'?'qr':'unavailable');}}
    catch{if(mounted.current){setMode('unavailable');setError('无法检查登录态，请重试，或明确选择扫码登录。');}}
  };
  useEffect(()=>{mounted.current=true;dialog.current?.showModal();void check();return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(!job||['completed','failed','needs_owner'].includes(job.status))return;
    let cancelled=false;const timer=setInterval(()=>{void api(`/onboarding/${target}/${job.id}`).then(data=>{if(!cancelled)setJob(data.job);}).catch(error=>{if(!cancelled)setError(error.message);});},1500);
    return()=>{cancelled=true;clearInterval(timer);};},[job?.id,job?.status,target]);
  const submit=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(submitting.current||!['reuse','qr'].includes(mode))return;
    const input=Object.fromEntries(new FormData(event.currentTarget));submitting.current=true;setBusy(true);setError('');
    try{const result=await api('/onboarding','POST',{name:input.name,target,sessionMode:mode,...(mode==='reuse'&&session?.status==='ready'?{confirmationToken:session.confirmationToken}:{})});if(mounted.current)setJob(result.job);}
    catch(error){if(mounted.current){setError(error instanceof Error?error.message:String(error));await check();}}
    finally{submitting.current=false;if(mounted.current)setBusy(false);}
  };
  return <dialog ref={dialog} className="pm-dialog" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}><header><h2>新建飞书机器人</h2><button type="button" disabled={busy} onClick={onClose} aria-label="关闭">×</button></header>
    {!job?<form onSubmit={submit}>
      <div className="pm-onboarding-session" aria-live="polite">
        {mode==='checking'?<p>正在检查当前飞书账号…</p>:mode==='reuse'&&session?.status==='ready'?<><strong>将使用 {session.identity.userName} · {session.identity.tenantName}</strong>{session.identity.email?<small>{session.identity.email}</small>:null}<p className="hint">复用当前登录态，无需重新扫码。</p><button type="button" disabled={busy} onClick={()=>setMode('qr')}>更换账号 / 扫码登录</button></>:<><p>{mode==='qr'?'将扫码登录后创建应用。':'暂时无法确认当前账号。'}</p>{session?.status==='ready'?<button type="button" disabled={busy} onClick={()=>setMode('reuse')}>使用当前账号</button>:<button type="button" disabled={busy} onClick={()=>void check()}>重新检查</button>}{mode==='unavailable'?<button type="button" disabled={busy} onClick={()=>setMode('qr')}>改用扫码登录</button>:null}</>}
      </div>
      <label>机器人名称<input name="name" required maxLength={64} disabled={busy}/></label><label>用途<select value={target} disabled={busy} onChange={event=>setTarget(event.target.value)}><option value="pool">加入空闲池，供 Agent 分配</option><option value="local">用于本地 Botmux</option></select></label>
      <p className="hint">按统一模板创建、配置并发布真实飞书应用；关闭进度窗口不会取消已提交的创建。</p>{error?<p role="alert" className="hint-warn">{error}</p>:null}
      <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||!['reuse','qr'].includes(mode)}>{busy?'提交中…':mode==='reuse'?'使用此账号创建':'创建并扫码登录'}</button></footer>
    </form>:<>
      <p>{job.permissionStatusMsg||job.message||job.status}</p>{job.status==='waiting_for_scan'&&job.qrDataUrl?<img className="pm-qr" src={job.qrDataUrl} alt="飞书创建授权二维码"/>:null}{job.status==='waiting_for_platform_scan'&&job.platformQrDataUrl?<img className="pm-qr" src={job.platformQrDataUrl} alt="飞书开放平台授权二维码"/>:null}
      {job.appId?<p>App ID：<code>{job.appId}</code></p>:null}
      {job.status==='needs_owner'?<form onSubmit={async event=>{event.preventDefault();if(submitting.current)return;submitting.current=true;setBusy(true);const entries=String(new FormData(event.currentTarget).get('owner')).split(/[\s,]+/).filter(Boolean);try{const result=await api(`/onboarding/${target}/${job.id}/owner`,'POST',{entries});setJob(result.job);setError('');}catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}}}><label>确认应用所有者<input name="owner" required defaultValue={job.suggestedOwner||''} placeholder="企业邮箱、手机号或此应用可验证的身份"/></label><button disabled={busy}>验证并完成</button></form>:null}
      {job.permission?<div aria-label="权限配置结果"><p>{job.permission.ok?'权限配置已完成':'权限配置未完全完成'}{job.permission.scopeCount!==undefined?` · ${job.permission.scopeCount} 项权限`:''}{job.permission.skippedScopeCount?` · 跳过 ${job.permission.skippedScopeCount} 项当前企业不支持的权限`:''}{job.permission.versionId?` · 发布版本 ${job.permission.versionId}`:''}</p>{[job.permission.scopeWarning,job.permission.redirectWarning||(job.permission.redirectConfigured===false?'OAuth redirect 白名单未配置成功，请到开放平台检查。':undefined),job.permission.message].filter(Boolean).map((text,index)=><p className="hint-warn" key={index}>{text}</p>)}</div>:null}
      {job.remainingSteps?.length?<ul>{job.remainingSteps.map(step=><li key={step.url}><a href={step.url} target="_blank" rel="noopener noreferrer">{step.title}</a></li>)}</ul>:null}
      {job.status==='completed'?<><p>{target==='pool'?'应用创建已完成。机器人入池后不会启动本地 Agent。':'本地机器人配置已创建，可在数字员工 → Bot 配置查看。'}</p>{job.liveStarted===false?<p role="alert" className="hint-warn">{target==='pool'?'入池未确认完成':'本地 Bot 未成功启动'}：{job.liveStartMessage||'请检查后台状态，不要重复创建应用'}</p>:null}{target==='pool'?<button disabled={busy} onClick={async()=>{if(submitting.current)return;submitting.current=true;setBusy(true);try{await api(`/onboarding/pool/${job.id}/register`,'POST',{});onDone('机器人已进入空闲池');}catch(error){setError(error instanceof Error?error.message:String(error));}finally{submitting.current=false;setBusy(false);}}}>确认入池并关闭</button>:<button onClick={()=>onDone(job.liveStarted===false?'本地配置已保存，但 Bot 启动失败，请检查':'本地机器人已创建')}>完成</button>}</>:null}
      {job.status==='failed'?<p className="hint-warn">{job.error}。{job.appId?'应用已创建，请保留 App ID，先排查权限配置；不要重复新建。':''}</p>:null}
      {error?<p role="alert" className="hint-warn">{error}</p>:null}<footer><button disabled={busy} onClick={onClose}>关闭</button></footer>
    </>}
  </dialog>;
}
