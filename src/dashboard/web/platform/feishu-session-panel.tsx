import { useCallback, useEffect, useRef, useState } from 'react';
import { FeishuLoginModal } from '../bot-defaults-page.js';

type Session={status:'ready'|'missing'|'expired'|'unknown';checkedAt:number};
const messages={
  ready:'飞书 Web 登录态有效，可用于机器人创建、配置与发布。',
  missing:'服务器缺少飞书 Web 登录态，请扫码登录。',
  expired:'飞书 Web 登录态已过期或不可用，请扫码刷新。',
  unknown:'暂时无法确认飞书 Web 登录态，请检查网络后刷新或重新扫码。',
};
export function FeishuSessionPanel(){
  const [session,setSession]=useState<Session|null>(null),[checking,setChecking]=useState(false),[loginOpen,setLoginOpen]=useState(false);
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
  const close=useCallback(()=>setLoginOpen(false),[]);
  const success=useCallback(()=>{setLoginOpen(false);void refresh(true);},[refresh]);
  return <section className="pm-feishu-session" aria-label="飞书 Web 登录态">
    <div><h2>飞书 Web 登录态</h2><p role="status" className={session&&session.status!=='ready'?'hint-warn':'hint'}>{session?messages[session.status]:'正在检查服务器登录态…'}</p><p className="hint">Gateway 共享登录态，不与单个 Bot 或 Agent 容器绑定；扫码凭证仅保存在 Gateway 的持久化状态目录。</p></div>
    <div className="pm-actions"><button type="button" disabled={checking||loginOpen} onClick={()=>void refresh(true)}>{checking?'检查中…':'刷新状态'}</button><button type="button" className="primary" onClick={()=>setLoginOpen(true)}>{session?.status==='ready'?'扫码刷新登录态':'扫码登录飞书'}</button></div>
    {loginOpen?<FeishuLoginModal onClose={close} onSuccess={success}/>:null}
  </section>;
}
