import { randomUUID } from 'node:crypto';
import type { BotOnboardingSessionStatus } from '../../dashboard/bot-onboarding.js';

/** Bind an administrator's displayed account confirmation without exposing
 * native user/tenant IDs. Native creation still rechecks this exact identity. */
export function createOnboardingSessionConfirmation(read:()=>Promise<BotOnboardingSessionStatus>,now=Date.now){
  const confirmations=new Map<string,{userId:string;tenantId:string;expiresAt:number}>();
  const prune=()=>{for(const [token,value] of confirmations)if(value.expiresAt<=now())confirmations.delete(token);};
  return {
    async inspect(){
      prune();const session=await read();
      if(session.status!=='ready')return {status:['invalid_session','missing_csrf'].includes(session.reason||'')?'scan_required' as const:'unknown' as const};
      const {userId,tenantId,userName,tenantName,email}=session.identity;
      if(!userId||!tenantId)return {status:'unknown' as const};
      if(confirmations.size>=100)confirmations.delete(confirmations.keys().next().value!);
      const confirmationToken=randomUUID();
      confirmations.set(confirmationToken,{userId,tenantId,expiresAt:now()+10*60_000});
      return {status:'ready' as const,confirmationToken,identity:{userName,tenantName,...(email?{email}:{})}};
    },
    async consume(token:unknown){
      prune();if(typeof token!=='string')return undefined;
      const expected=confirmations.get(token);confirmations.delete(token);
      if(!expected)return undefined;
      const current=await read();
      if(current.status!=='ready'||current.identity.userId!==expected.userId||current.identity.tenantId!==expected.tenantId)return undefined;
      return {userId:expected.userId,tenantId:expected.tenantId};
    },
  };
}
