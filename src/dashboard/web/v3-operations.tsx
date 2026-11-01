import {useEffect,useState} from 'react';
export function WorkflowOperations({runId}:{runId:string}){
 type View={runId:string;ops?:any;files:any[];operationsError:string;artifactsError:string};
 const [view,setView]=useState<View>({runId,files:[],operationsError:'',artifactsError:''});
 const current=view.runId===runId?view:{runId,files:[],operationsError:'',artifactsError:''};
 const {ops,files}=current,error=[current.operationsError,current.artifactsError].filter(Boolean).join(' · ');
 useEffect(()=>{
  let live=true,busy=false;
  setView({runId,files:[],operationsError:'',artifactsError:''});
  const load=async()=>{
   if(busy)return;busy=true;
   const loadPart=async(part:'operations'|'artifacts')=>{
    try{
     const response=await fetch('/api/v3/runs/'+encodeURIComponent(runId)+'/'+part);
     if(!response.ok)throw Error(String(response.status));
     const value=await response.json();if(!live)return;
     setView(previous=>previous.runId!==runId?previous:part==='operations'?{...previous,ops:value,operationsError:''}:{...previous,files:value.files??[],artifactsError:''});
    }catch{
     if(live)setView(previous=>previous.runId!==runId?previous:part==='operations'?{...previous,ops:undefined,operationsError:'运行详情暂不可用'}:{...previous,files:[],artifactsError:'产物列表暂不可用'});
    }
   };
   try{await Promise.all([loadPart('operations'),loadPart('artifacts')]);}finally{busy=false;}
  };
  void load();const timer=setInterval(()=>void load(),5000);
  return()=>{live=false;clearInterval(timer);};
 },[runId]);
 if(!ops&&!error)return null;
 return <section className="panel"><h2>执行与交付记录</h2>{error?<p>{error}</p>:null}{ops?<><p>计算：{ops.runStatus} · 文档交付：{ops.reportDelivery?.status??'尚无记录'}</p>{ops.reportDelivery?.documentUrl?<a href={ops.reportDelivery.documentUrl}>飞书文档</a>:null}<p>{ops.reportDelivery?.status==='not_applicable'?'本次没有可发布的最终报告':ops.nextAction}</p><table><thead><tr><th>Attempt</th><th>成员 / CLI / 模型</th><th>槽位 / 排队</th><th>状态</th></tr></thead><tbody>{ops.jobs.map((j:any)=><tr key={j.jobId}><td>{j.attemptId}</td><td>{j.runtime?.displayName??'等待选择'} · {j.runtime?.agentType??''} · {j.runtime?.modelId??''}</td><td>{j.runtime?.slot??'—'} / {j.runtime?.queueMs==null?'未知':j.runtime.queueMs+'ms'}</td><td>{j.state} {j.lastError??''}</td></tr>)}</tbody></table>{files.length?<ul>{files.map(f=><li key={f.key}><a href={f.url}>{f.nodeId} · {f.path}</a> · {f.bytes} bytes</li>)}</ul>:null}<details><summary>审批与来源</summary><pre>{JSON.stringify({approvals:ops.authoringApprovals,lineage:ops.lineage},null,2)}</pre></details></>:null}</section>;
}
