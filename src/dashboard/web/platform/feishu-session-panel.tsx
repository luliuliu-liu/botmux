import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FeishuLoginModal } from '../bot-defaults-page.js';
import type { FeishuSessionStatus as Session } from '../../../platform/management/feishu-session.js';

const messages={
  ready:'飞书 Web 登录态有效，可用于机器人创建、配置与发布。',
  missing:'服务器缺少飞书 Web 登录态，请扫码登录。',
  expired:'飞书 Web 登录态已过期或不可用，请扫码刷新。',
  unknown:'暂时无法确认飞书 Web 登录态，请检查网络后刷新或重新扫码。',
};
const statusLabels={ready:'已登录飞书',missing:'未登录',expired:'登录已过期',unknown:'状态待确认'};
function SessionIcon({kind}:{kind:'chevron'|'refresh'|'qr'|'shield'}){
  return <svg className="pm-session-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind==='chevron'?<path d="m4 6 4 4 4-4"/>:kind==='refresh'?<><path d="M13.1 6.55A5.35 5.35 0 1 0 13 10.1"/><path d="M13.15 2.95v3.7H9.45"/></>:kind==='shield'?<><path d="M8 1.5 13 3.5v4c0 3-2.7 5.7-5 7-2.3-1.3-5-4-5-7v-4z"/><path d="m5.7 7.8 1.6 1.6 3.2-3.2"/></>:<><rect x="2" y="2" width="4" height="4" rx=".5"/><rect x="10" y="2" width="4" height="4" rx=".5"/><rect x="2" y="10" width="4" height="4" rx=".5"/><path d="M10 10h1v2h3M10 14h1M14 10v1M14 14h-1"/></>}
  </svg>;
}
export function FeishuSessionPanel(){
  const [session,setSession]=useState<Session|null>(null),[checking,setChecking]=useState(false),[loginOpen,setLoginOpen]=useState(false);
  const [expanded,setExpanded]=useState(false);
  const detailId=useId();
  const mounted=useRef(false),generation=useRef(0);
  const refresh=useCallback(async(force=false)=>{
    const request=++generation.current;setChecking(true);
    try{
      const response=await fetch(`/api/platform/feishu-session${force?'?refresh=1':''}`);
      if(!response.ok)throw new Error('status_unavailable');
      const result=await response.json();
      if(!result.session||!Object.hasOwn(messages,result.session.status))throw new Error('invalid_status');
      if(mounted.current&&request===generation.current)setSession(result.session);
    }catch{if(mounted.current&&request===generation.current)setSession({status:'unknown',checkedAt:Date.now()});}
    finally{if(mounted.current&&request===generation.current)setChecking(false);}
  },[]);
  useEffect(()=>{
    mounted.current=true;void refresh();
    const timer=window.setInterval(()=>void refresh(),30000);
    const onFocus=()=>void refresh();window.addEventListener('focus',onFocus);
    return()=>{mounted.current=false;generation.current++;window.clearInterval(timer);window.removeEventListener('focus',onFocus);};
  },[refresh]);
  useEffect(()=>{
    // Failed authentication needs an actionable entry; a healthy account stays
    // compact. Repeated polls do not override the user's disclosure choice.
    if(session&&session.status!=='ready')setExpanded(true);
  },[session?.status]);
  const close=useCallback(()=>setLoginOpen(false),[]);
  const success=useCallback(()=>{setLoginOpen(false);setSession(null);setExpanded(false);void refresh(true);},[refresh]);
  const identity=session?.status==='ready'?session.identity:undefined;
  const name=identity?.userName||'飞书 Web 登录';
  const status=checking?'checking':session?.status||'checking';
  return <section className="pm-feishu-session" aria-label="飞书 Web 登录态" data-status={status}>
    <div className="pm-session-summary">
      <span className="pm-session-avatar" aria-hidden="true">{identity?.userName?Array.from(identity.userName.trim())[0]:'F'}<span/></span>
      <div className="pm-session-person" aria-label="当前飞书账号"><strong>{name}</strong>{identity?.tenantName?<span className="pm-session-company">{identity.tenantName}</span>:null}</div>
      <span className="pm-session-badge" role="status"><span/>{checking?'检查中…':session?statusLabels[session.status]:'检查中…'}</span>
      <button type="button" className="pm-session-disclosure" data-action="feishu-session-toggle" aria-expanded={expanded} aria-controls={detailId} onClick={()=>setExpanded(value=>!value)}><span>{expanded?'收起详情':'展开'}</span><SessionIcon kind="chevron"/></button>
    </div>
    <div id={detailId} className="pm-session-details" hidden={!expanded}>
      <dl className="pm-feishu-account">
        {identity?.email?<div><dt>账号邮箱</dt><dd>{identity.email}</dd></div>:null}
        <div><dt>登录状态</dt><dd className={session&&session.status!=='ready'?'hint-warn':''}>{session?messages[session.status]:'正在检查服务器登录态…'}</dd></div>
      </dl>
      {session?.status==='ready'&&!identity?<p className="hint">账号信息暂不可用，请点击“检查状态”重新获取。</p>:null}
      <div className="pm-session-footer"><span className="pm-session-privacy"><SessionIcon kind="shield"/>凭证仅保存在本机 Gateway，不下发到 Agent</span>
        <div className="pm-actions"><button type="button" className="pm-session-action" data-action="feishu-session-refresh" disabled={checking||loginOpen} onClick={()=>void refresh(true)}><SessionIcon kind="refresh"/>{checking?'检查中…':'检查状态'}</button><button type="button" className="pm-session-action pm-session-login" data-action="feishu-session-login" onClick={()=>setLoginOpen(true)}><SessionIcon kind="qr"/>{session?.status==='ready'?'刷新登录态':'扫码登录飞书'}</button></div>
      </div>
    </div>
    {loginOpen?<FeishuLoginModal onClose={close} onSuccess={success}/>:null}
  </section>;
}
