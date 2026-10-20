import {useEffect,useRef,useState,type FormEvent} from 'react';
type App={appId:string;displayName:string;description?:string;registered:boolean;usage?:string};
type AccountApps={confirmationToken:string;identity:{userName:string;tenantName:string;email?:string};apps:App[];limited?:boolean};
export function PlatformBotImport({api,onClose,onDone}:{api:(path:string,method?:string,body?:unknown)=>Promise<any>;onClose:()=>void;onDone:(message:string)=>void}){
  const dialog=useRef<HTMLDialogElement>(null),mounted=useRef(false),submitting=useRef(false),generation=useRef(0);
  const [data,setData]=useState<AccountApps|null>(null),[selected,setSelected]=useState(''),[query,setQuery]=useState(''),[owner,setOwner]=useState('');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const load=async()=>{
    const version=++generation.current;setLoading(true);setData(null);setSelected('');setError('');
    try{const value=await api('/feishu-apps');if(mounted.current&&version===generation.current){setData(value);setOwner(value.identity.email||'');}}
    catch(error){if(mounted.current&&version===generation.current)setError(error instanceof Error?error.message:String(error));}
    finally{if(mounted.current&&version===generation.current)setLoading(false);}
  };
  useEffect(()=>{mounted.current=true;dialog.current?.showModal();void load();return()=>{mounted.current=false;generation.current++;};},[]);
  const submit=async(event:FormEvent)=>{
    event.preventDefault();if(submitting.current||!selected||!data||!owner.trim())return;
    submitting.current=true;setBusy(true);setError('');
    try{
      const result=await api('/bots/import','POST',{appId:selected,confirmationToken:data.confirmationToken,owner:owner.trim()});
      if(result.imported!==true)throw new Error('入池未确认，请刷新机器人列表；不要新建重复应用。');
      if(mounted.current)onDone(`机器人「${result.displayName}」已加入空闲池，未启动或绑定 Agent。`);
    }catch(error){if(mounted.current){setError(`${error instanceof Error?error.message:String(error)} 如需重试，请先刷新应用列表。`);setSelected('');}}
    finally{submitting.current=false;if(mounted.current)setBusy(false);}
  };
  const needle=query.trim().toLowerCase(),apps=data?.apps.filter(app=>`${app.displayName} ${app.appId}`.toLowerCase().includes(needle))??[];
  return <dialog ref={dialog} className="pm-dialog pm-import-dialog" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <header><h2>导入已有飞书机器人</h2><button type="button" aria-label="关闭" disabled={busy} onClick={onClose}>×</button></header>
    <form onSubmit={submit}>
      <div className="pm-onboarding-session">{data?<><strong>{data.identity.userName} · {data.identity.tenantName}</strong><p className="hint">从此账号可管理的应用中选择，复用现有登录态，无需新建。</p></>:<p>{loading?'正在读取当前飞书账号的应用…':'请先在 Bot 管理中扫码登录飞书，再刷新此列表。'}</p>}<button type="button" disabled={busy||loading} onClick={()=>void load()}>刷新应用列表</button></div>
      {data?<><label>搜索应用<input aria-label="搜索已有应用" placeholder="应用名称或 App ID" value={query} disabled={busy} onChange={e=>setQuery(e.target.value)}/></label>
        <div className="pm-import-list" role="group" aria-label="当前账号的已有应用">{apps.map(app=><label key={app.appId} className="pm-import-choice" data-registered={app.registered}>
          <input type="radio" name="existingAppId" value={app.appId} checked={selected===app.appId} disabled={busy||app.registered} onChange={()=>setSelected(app.appId)}/>
          <span><strong>{app.displayName}</strong><small>{app.appId}</small>{app.description?<small className="pm-import-description" title={app.description}>{app.description}</small>:null}</span>
          {app.registered?<span className="pm-state">{app.usage==='sandbox'?'已绑定 Agent':app.usage==='local'?'本地已使用':'已纳管'}</span>:null}
        </label>)}{!apps.length?<p className="empty">{data.apps.length?'未找到匹配的应用':'此账号下暂无可导入的应用'}</p>:null}</div>
        {data.limited?<p className="hint-warn">当前只展示前 1000 个应用。</p>:null}
        <label>机器人所有者<input name="existingBotOwner" required value={owner} disabled={busy} placeholder="企业邮箱、手机号或 union_id" onChange={e=>setOwner(e.target.value)}/></label>
        <p className="hint">只导入已启用且已发布的机器人。App Secret 仅由服务器读取并加密保存；不重置密钥、不修改应用权限、不发布版本。导入后进入空闲池，可在 Agent 管理中绑定。</p>
      </>:null}
      {error?<p className="hint-warn" role="alert">{error}</p>:null}
      <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||loading||!selected||!owner.trim()}>{busy?'导入中…':'导入空闲池'}</button></footer>
    </form>
  </dialog>;
}
