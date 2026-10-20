import { platformManagementEnabled, platformRequest } from './dashboard-api.js';
import { withLocalInventoryLock } from './local-inventory-lock.js';

/** Inventory claims only. Native Workers own their Feishu connections. */
export class PlatformLocalInventory {
  constructor(private readonly localBots:()=>Array<{larkAppId:string;name?:string;displayName?:string}>) {}
  private polling=false;
  private timer:ReturnType<typeof setInterval>|undefined;
  start(){if(!platformManagementEnabled())return;void this.poll();this.timer=setInterval(()=>void this.poll(),5000);this.timer.unref();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  private async poll(){
    if(this.polling)return;this.polling=true;
    try {
      const claim=await withLocalInventoryLock(()=>{
        const bots=this.localBots().map(bot=>({appId:bot.larkAppId,displayName:bot.displayName||bot.name||bot.larkAppId}));
        return platformRequest('/local-claims','POST',{gatewayId:process.env.BOTMUX_PLATFORM_GATEWAY_ID||'local-gateway',bots});
      });
      if(claim.status!==200)console.warn('[platform] local inventory synchronization unconfirmed');
    }catch{
      // Native local communication remains independent of a platform outage.
      console.warn('[platform] local inventory synchronization unavailable; will retry');
    }finally{this.polling=false;}
  }
}
