import { Children,cloneElement,isValidElement,useEffect, useId, useRef, useState, type ReactNode, type InputHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';

export function Parameter({children,help}:{children:ReactNode;help:string}){
  return <span className="pm-parameter">{children}<span className="pm-help" tabIndex={0} aria-label={help} data-tip={help}>?</span></span>;
}
function explanationText(children:ReactNode):string{
 let text='';Children.forEach(children,child=>{if(typeof child==='string'||typeof child==='number')text+=child;else if(isValidElement<{children?:ReactNode;text?:string}>(child))text+=child.props.text??explanationText(child.props.children);});return text;
}
/** Configuration help is available on hover or keyboard focus, never a large
 * paragraph competing with fields. Errors and live status use their own UI. */
export function ConfigHelp({children,label=''}:{children:ReactNode;label?:string}){
 return <span className="pm-config-help"><Parameter help={explanationText(children)}>{label}</Parameter></span>;
}
export function collectModalHelp(children:ReactNode){
 const tips:string[]=[];
 const visit=(nodes:ReactNode,attached=false):ReactNode=>Children.map(nodes,node=>{
  if(!isValidElement<{children?:ReactNode;label?:string}>(node))return node;
  if(node.type===ConfigHelp&&!attached){tips.push(explanationText(node.props.children));return null;}
  if(node.props.children!==undefined)return cloneElement(node,{children:visit(node.props.children,attached||typeof node.type==='string'&&/^h[1-6]$/.test(node.type))});
  return node;
 });
 return {content:visit(children),help:[...new Set(tips.filter(Boolean))].join('\n\n')};
}
export function CompactText({text,className=''}:{text:string;className?:string}){
  return <span className={`pm-ellipsis ${className}`} data-tip={text} title={text} tabIndex={0}>{text}</span>;
}
/** Native Botmux toggle markup, with named/uncontrolled form inputs supported. */
export function PlatformSwitch({title,description,...input}:{title:ReactNode;description?:ReactNode}&Omit<InputHTMLAttributes<HTMLInputElement>,'title'|'type'>){
  return <label className="toggle-row pm-toggle"><input {...input} type="checkbox"/><span className="switch" aria-hidden="true"/><span className="toggle-tx"><strong>{title}</strong>{description?<ConfigHelp>{description}</ConfigHelp>:null}</span></label>;
}
type Action={label:string;disabled?:boolean;danger?:boolean;run:()=>void};
/** Portal escapes the table's horizontal scroll clipping; native core stays unchanged. */
export function AgentActions({name,actions,disabled}:{name:string;actions:Action[];disabled?:boolean}){
  const id=useId(),trigger=useRef<HTMLButtonElement>(null),popup=useRef<HTMLDivElement>(null);
  const [position,setPosition]=useState<{top:number;left:number}|null>(null);
  const close=()=>{setPosition(null);trigger.current?.focus({preventScroll:true});};
  useEffect(()=>{
    if(!position||typeof document==='undefined')return;
    const buttons=()=>Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')||[]);
    buttons()[0]?.focus({preventScroll:true});
    const outside=(e:PointerEvent)=>{if(!popup.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))setPosition(null);};
    const keyboard=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.preventDefault();close();}
      if(e.key==='Tab'){setPosition(null);}
      if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
        e.preventDefault();const items=buttons(),index=items.indexOf(document.activeElement as HTMLButtonElement);
        const next=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
      }
    };
    const dismiss=()=>setPosition(null);
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',keyboard);
    window.addEventListener('resize',dismiss);window.addEventListener('scroll',dismiss,true);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',keyboard);window.removeEventListener('resize',dismiss);window.removeEventListener('scroll',dismiss,true);};
  },[position]);
  const menu=position?<div ref={popup} id={id} role="menu" aria-label={`${name} 的操作`} className={`pm-action-popover${trigger.current?.closest('.pm-management')?' pm-light-popover':''}`} style={position}>{actions.map(action=><button key={action.label} type="button" role="menuitem" disabled={action.disabled} className={action.danger?'pm-danger':''} onClick={()=>{close();action.run();}}>{action.label}</button>)}</div>:null;
  return <><button ref={trigger} type="button" className="pm-more" aria-label={`${name} 的操作`} aria-haspopup="menu" aria-expanded={!!position} aria-controls={position?id:undefined} disabled={disabled} onClick={()=>{
    if(position){close();return;}const r=trigger.current?.getBoundingClientRect();
    const height=actions.length*38+16;setPosition({left:r?Math.max(8,Math.min(r.right-184,window.innerWidth-192)):0,top:r?Math.max(8,r.bottom+height>window.innerHeight?r.top-height:r.bottom+6):0});
  }}>⋯</button>{menu&&(typeof document==='undefined'?menu:createPortal(menu,document.body))}</>;
}
