import type { ReactNode } from 'react';
import { ui } from '../ui.js';

/** Managed deployments consolidate login in Bot management. Unmanaged native
 * deployments retain their original contextual QR/retry behavior. */
export function FeishuLoginEntry({action,onClick,hidden,className='bd-feishu-login',children}:{
  action:string;onClick:()=>void;hidden?:boolean;className?:string;children:ReactNode;
}) {
  return ui.platformManaged
    ? <a href="#/platform-bots" className={className} data-action={action} hidden={hidden}>前往 Bot 管理刷新登录态</a>
    : <button type="button" className={className} data-action={action} hidden={hidden} onClick={onClick}>{children}</button>;
}
