import { createHash } from 'node:crypto';
import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { sdkDomain } from '../../im/lark/lark-hosts.js';
import { platformManagementEnabled, platformRequest } from './dashboard-api.js';

interface Target {containerId:string;appId:string;appSecret:string;brand:'feishu'|'lark';bindingGeneration:string;revision:number;
  owner:{allowedUsers:string[];ownerOpenId?:string}}
const silent={debug(){},info(){},warn(){},error(){},trace(){}};

/** Container transport is deliberately separate from the native local fleet.
 * No remote failure falls through to spawning a CLI in the gateway. */
export class PlatformRemoteFleet {
  constructor(private readonly localBots:()=>Array<{larkAppId:string;name?:string;displayName?:string}>) {}
  private entries=new Map<string,{ws:WSClient;signature:string;active:boolean}>();
  private polling=false;
  private timer:ReturnType<typeof setInterval>|undefined;
  start(){if(!platformManagementEnabled())return;void this.poll();this.timer=setInterval(()=>void this.poll(),5000);this.timer.unref();}
  stop(){if(this.timer)clearInterval(this.timer);for(const entry of this.entries.values()){entry.active=false;entry.ws.close({force:true});}this.entries.clear();}
  private async poll(){
    if(this.polling)return;this.polling=true;
    try {
      const bots=this.localBots().map(bot=>({appId:bot.larkAppId,displayName:bot.displayName||bot.name||bot.larkAppId}));
      const claim=await platformRequest('/local-claims','POST',{gatewayId:process.env.BOTMUX_PLATFORM_GATEWAY_ID||'local-gateway',bots});
      if(claim.status!==200)throw new Error('local_inventory_unconfirmed');
      const response=await platformRequest('/dispatch-targets');
      if(response.status!==200)throw new Error('dispatch_unavailable');
      const targets=response.data.targets as Target[];
      const wanted=new Set(targets.map(t=>t.appId));
      for(const [id,entry] of this.entries)if(!wanted.has(id)){entry.active=false;entry.ws.close({force:true});this.entries.delete(id);}
      for(const target of targets){
        const signature=`${target.containerId}/${target.bindingGeneration}/${target.revision}`;
        const previous=this.entries.get(target.appId);
        if(previous?.signature===signature)continue;
        if(previous){previous.active=false;previous.ws.close({force:true});this.entries.delete(target.appId);}
        await this.attach(target,signature);
      }
    }catch{
      // Without authoritative routing data, stop accepting messages. Native
      // local Botmux remains unaffected by a platform outage.
      for(const entry of this.entries.values()){entry.active=false;entry.ws.close({force:true});}this.entries.clear();
    }finally{this.polling=false;}
  }
  private async attach(target:Target,signature:string){
    const client=new Client({appId:target.appId,appSecret:target.appSecret,domain:sdkDomain(target.brand),logger:silent});
    const owners=new Set<string>();
    if(target.owner.ownerOpenId)owners.add(target.owner.ownerOpenId);
    for(const entry of target.owner.allowedUsers){
      if(entry.startsWith('ou_'))owners.add(entry); // persisted only after target-app validation in native onboarding.
      else if(entry.startsWith('on_')){
        const result=await client.contact.v3.user.get({path:{user_id:entry},params:{user_id_type:'union_id'}});
        if(result.code===0&&result.data?.user?.open_id)owners.add(result.data.user.open_id);
      }else{
        const result=await client.contact.v3.user.batchGetId({params:{user_id_type:'open_id'},data:{
          ...(entry.includes('@')?{emails:[entry]}:{mobiles:[entry.replace(/[\s-]/g,'')]}),include_resigned:false}});
        if(result.code===0)for(const user of result.data?.user_list||[])if(user.user_id)owners.add(user.user_id);
      }
    }
    if(!owners.size)throw new Error('owner_unresolved');
    const botInfo:any=await client.request({method:'GET',url:'/open-apis/bot/v3/info/'});
    const botOpenId=botInfo?.bot?.open_id||botInfo?.data?.bot?.open_id;
    if(!botOpenId)throw new Error('bot_identity_unresolved');
    const ws=new WSClient({appId:target.appId,appSecret:target.appSecret,domain:sdkDomain(target.brand),logger:silent});
    const entry={ws,signature,active:true};
    this.entries.set(target.appId,entry);
    let queue=Promise.resolve();let queued=0;
    const eventDispatcher=new EventDispatcher({logger:silent}).register({
      'im.message.receive_v1':async(event:any)=>{
        const message=event.message,sender=event.sender;
        if(!entry.active||sender?.sender_type!=='user'||!owners.has(sender.sender_id?.open_id)||message?.message_type!=='text')return;
        if(message.chat_type!=='p2p'&&!message.mentions?.some((m:any)=>m.id?.open_id===botOpenId))return;
        let prompt:string;try{prompt=JSON.parse(message.content).text.replace(/@_user_\d+/g,'').trim();}catch{return;}
        if(!prompt||queued>=10)return;
        queued++;
        queue=queue.then(async()=>{
          if(!entry.active)return;
          try {
            const result=await platformRequest(`/dispatch/${target.containerId}/prompt`,'POST',{
              appId:target.appId,bindingGeneration:target.bindingGeneration,messageId:message.message_id,
              sessionId:`${message.chat_id}/${message.root_id||message.thread_id||'main'}/${sender.sender_id.open_id}`,prompt,
            });
            if(!entry.active)return;
            const text=result.status===200?result.data.text:`沙箱 Agent 未完成执行：${result.data.message||'请检查 OpenSandbox 管理页面'}`;
            await client.im.v1.message.reply({path:{message_id:message.message_id},data:{msg_type:'text',
              content:JSON.stringify({text:String(text).slice(0,12000)}),
              uuid:createHash('sha256').update(`${target.appId}/${message.message_id}/${target.bindingGeneration}`).digest('hex').slice(0,32)}});
          }catch{console.warn('[platform] remote message delivery unconfirmed');}
        }).finally(()=>{queued--;});
      },
    });
    void ws.start({eventDispatcher}).catch(()=>{entry.active=false;this.entries.delete(target.appId);ws.close({force:true});});
  }
}
