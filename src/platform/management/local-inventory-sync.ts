import { platformManagementEnabled, platformRequest } from './dashboard-api.js';
import { withLocalInventoryLock } from './local-inventory-lock.js';
import {localBotManagedDigest,localInventoryFromBots} from './local-bot-bind.js';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {readBotsJsonOrEmpty,mutateBotsJsonAtomic} from '../../setup/bots-store.js';
import {withFileLock} from '../../utils/file-lock.js';

/** Inventory claims only. Native Workers own their Feishu connections. */
export class PlatformLocalInventory {
  constructor(private readonly localBots:()=>Array<{larkAppId:string;name?:string;displayName?:string;runtimeRunning?:boolean;runtimeGeneration?:string|null}>,
    private readonly stopBot:(appId:string)=>Promise<{ok:boolean}>,
    private readonly isStopped:(appId:string)=>Promise<boolean>) {}
  private polling=false;
  private timer:ReturnType<typeof setInterval>|undefined;
  private quarantine=new Map<string,string>();
  start(){if(!platformManagementEnabled())return;void this.poll();this.timer=setInterval(()=>void this.poll(),5000);this.timer.unref();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  private async poll(){
    if(this.polling)return;this.polling=true;
    try {
      const path=join(homedir(),'.botmux','bots.json');
      await withLocalInventoryLock(async()=>{
        const bots=localInventoryFromBots(this.localBots());
        const claim=await platformRequest('/local-claims','POST',{bots});
        if(claim.status!==200){console.warn('[platform] local inventory synchronization unconfirmed');return;}
        for(const decision of claim.data.bots||[]){
          if(!['stop','resync'].includes(decision.action)){this.quarantine.delete(decision.appId);continue;}
          const before=readBotsJsonOrEmpty(path).find(bot=>bot.larkAppId===decision.appId);
          if(!before)continue;
          const observed=bots.find(bot=>bot.appId===decision.appId);
          const fence=JSON.stringify([decision.action,decision.decisionRevision,observed?.digest,observed?.runtimeGeneration]);
          // Require the same decision on two separate inventory cycles. This
          // leaves onboarding's persist→adopt window intact and rejects stale
          // decisions after a legitimate bind or process generation change.
          if(this.quarantine.get(decision.appId)!==fence){this.quarantine.set(decision.appId,fence);continue;}
          this.quarantine.delete(decision.appId);
          if(!await this.stopBot(decision.appId).then(result=>result.ok).catch(()=>false)){console.warn('[platform] database-owned Bot could not be stopped');continue;}
          await withFileLock(join(homedir(),'.botmux','pm2-fleet-mutation'),async()=>{
            if(!await this.isStopped(decision.appId)){console.warn('[platform] database-owned Bot restarted before quarantine');return;}
            // A resync retains the exact roster record for an explicit
            // database-owned restore. A pool/Worker-owned Bot is quarantined.
            if(decision.action==='stop')mutateBotsJsonAtomic(path,currentBots=>currentBots.filter(bot=>
              bot.larkAppId!==decision.appId||localBotManagedDigest(bot)!==localBotManagedDigest(before)));
          });
        }
      });
    }catch{
      // Native local communication remains independent of a platform outage.
      console.warn('[platform] local inventory synchronization unavailable; will retry');
    }finally{this.polling=false;}
  }
}
