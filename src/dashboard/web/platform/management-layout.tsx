import {useEffect,useState,type ReactNode} from 'react';

type Section={id:string;label:string;description:string;icon:string};
export const AGENT_SECTIONS:readonly Section[]=[
  {id:'instances',label:'Agent 实例',description:'管理与部署 Worker',icon:'instances'},
  {id:'local',label:'本地 Agent',description:'本地 CLI 与全局配置',icon:'local'},
  {id:'bots',label:'Bot 管理',description:'管理飞书机器人',icon:'bots'},
  {id:'logins',label:'登录工作台',description:'浏览器配置与授权会话',icon:'login'},
  {id:'catalog',label:'支持的 Agent',description:'镜像与认证能力',icon:'catalog'},
];
export const CONFIGURATION_SECTIONS:readonly Section[]=[
  {id:'models',label:'模型连接',description:'模型服务与 API Key',icon:'models'},
  {id:'proxies',label:'Proxy',description:'网络代理配置',icon:'proxy'},
  {id:'credentials',label:'CLI 凭证',description:'管理 CLI 访问凭证',icon:'key'},
  {id:'workspaces',label:'工作区设置',description:'默认路径与挂载设置',icon:'workspace'},
];
function SectionIcon({kind}:{kind:string}){
  const paths:Record<string,ReactNode>={
    instances:<><rect x="2" y="2" width="16" height="6" rx="2"/><rect x="2" y="12" width="16" height="6" rx="2"/><path d="M6 5h.01M6 15h.01M10 5h4M10 15h4"/></>,
    local:<><rect x="2" y="3" width="16" height="12" rx="2"/><path d="M7 18h6M10 15v3M5 7l3 2-3 2M11 11h4"/></>,
    bots:<><rect x="3" y="6" width="14" height="11" rx="3"/><path d="M10 6V3M1 10v3M19 10v3M7 11h.01M13 11h.01M7 14h6"/></>,
    login:<><path d="M4 15h12M6 15v-5a4 4 0 0 1 8 0v5M8 18h4M10 2v1"/></>,
    catalog:<><path d="M8 2h4l1 3 3 1 2 3-2 3-1 3-3 1-2 2-3-2-3-1-1-3-1-3 2-3 3-1z"/><circle cx="10" cy="10" r="3"/></>,
    models:<><ellipse cx="10" cy="4" rx="7" ry="3"/><path d="M3 4v6c0 4 14 4 14 0V4M3 10v6c0 4 14 4 14 0v-6"/></>,
    proxy:<><circle cx="10" cy="4" r="2.5"/><circle cx="4" cy="15" r="2.5"/><circle cx="16" cy="15" r="2.5"/><path d="M10 7v3M4 12v-2h12v2"/></>,
    key:<><circle cx="7" cy="7" r="4"/><path d="m10 10 7 7M13 13l2-2M15 15l2-2"/></>,
    workspace:<><path d="M2 7V5a2 2 0 0 1 2-2h4l2 3h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7z"/><path d="M6 11h8M6 14h5"/></>,
  };
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}
export function managementSection(sections:readonly Section[],fallback:string,hash=typeof window==='undefined'?'':window.location.hash){
  const value=new URLSearchParams(hash.split('?')[1]||'').get('section');
  return sections.some(item=>item.id===value)?value!:fallback;
}
export function useManagementSection(sections:readonly Section[],fallback:string){
  const [section,setSection]=useState(()=>managementSection(sections,fallback));
  useEffect(()=>{if(typeof window==='undefined')return;const update=()=>setSection(managementSection(sections,fallback));window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);},[sections,fallback]);
  return section;
}
export function ManagementLayout({title,description,route,sections,section,children}:{title:string;description:string;route:string;sections:readonly Section[];section:string;children:ReactNode}){
  const current=sections.find(item=>item.id===section)!;
  return <section className="page pm-page pm-management">
    <header className="pm-management-heading"><p className="pm-breadcrumb">管理 <span>/</span> {title} <span>/</span> {current.label}</p><h1>{title}</h1><p>{description}</p></header>
    <div className="pm-management-layout"><nav className="pm-section-nav" aria-label={`${title}分类`}>{sections.map(item=><a key={item.id} href={`${route}?section=${item.id}`} aria-current={section===item.id?'page':undefined}><SectionIcon kind={item.icon}/><span><strong>{item.label}</strong><small>{item.description}</small></span></a>)}</nav>
      <div className="pm-management-panel" key={section} aria-label={current.label}>{children}</div>
    </div>
  </section>;
}
