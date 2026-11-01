import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,lstatSync,readFileSync,unlinkSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,sep} from 'node:path';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import {platformRequest} from '../management/dashboard-api.js';
import {containerRole} from '../management/container-role.js';
import {replyMessage,sendMessage,uploadImage} from '../../im/lark/client.js';
export type LarkCommand=(args:string[],input:string,cwd:string)=>Promise<any>;
export function runLark(args:string[],input:string,cwd:string):Promise<any>{return new Promise((resolve,reject)=>{
 const env:NodeJS.ProcessEnv={HOME:homedir(),PATH:process.env.PATH,LARKSUITE_CLI_DATA_DIR:cwd,
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1',
  ...Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))};
 const child=spawn('lark-cli',args,{cwd,env,stdio:['pipe','pipe','pipe']});let out='',err='';
 child.stdout.on('data',b=>{out+=b;if(out.length>2*1024*1024)child.kill();});child.stderr.on('data',b=>{err+=b;if(err.length>65536)child.kill();});child.stdin.on('error',()=>{});child.stdin.end(input);
 const timer=setTimeout(()=>child.kill('SIGKILL'),args.includes('--device-code')?5000:60000);
 child.once('error',()=>{clearTimeout(timer);reject(Error('lark_cli_unavailable'));});child.once('close',code=>{clearTimeout(timer);
  if(code!==0){let type='';try{type=JSON.parse(err).error?.type??'';}catch{}reject(Error(type==='authorization'?'lark_authorization_required':'lark_command_unconfirmed'));return;}
  try{const value=JSON.parse(out);if(value.ok===false)throw Error();resolve(value.data??value);}catch{if(args[0]==='config'||args[1]==='qrcode')resolve({ok:true});else reject(Error('invalid_lark_response'));}
 });
});}
type API=(path:string,method?:string,body?:any)=>Promise<{status:number;data:any}>;
type Notify=(binding:any,text:string,key:string,image?:string)=>Promise<string>;
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const messageKey=(v:string)=>'report-'+digest(v).slice(0,40);
function authorizedUser(auth:any):boolean{const user=auth?.identities?.user;return auth?.verified===true&&typeof user?.openId==='string'&&(user.tokenStatus===undefined?['ready','logged_in','authorized','authenticated'].includes(user.status):user.tokenStatus==='valid');}
function privateDir(path:string){let current:string=sep;for(const part of path.split(sep).filter(Boolean)){current=join(current,part);if(!existsSync(current))mkdirSync(current,{mode:0o700});const s=lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('unsafe_report_state');}}
const save=(path:string,value:unknown)=>atomicWriteFileSync(path,JSON.stringify(value),{mode:0o600});
const read=(path:string)=>{if(!existsSync(path))return undefined;const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe_report_receipt');return JSON.parse(readFileSync(path,'utf8'));};
export async function publishReport(runId:string,{api=platformRequest,run=runLark,notify=notifyReport,home=homedir()}:{api?:API;run?:LarkCommand;notify?:Notify;home?:string}={}){
 const claim=await api(`/report-deliveries/${encodeURIComponent(runId)}/claim`,'POST',{});if(claim.status!==200||!claim.data.claimed)return;
 const {holder,row,profile}=claim.data;let stage='awaiting_configuration',documentId=row.documentId,documentUrl=row.documentUrl;const transition=async(status:string,value:any={})=>{
  const r=await api(`/report-deliveries/${encodeURIComponent(runId)}/transition`,'POST',{holder,status,...value});if(r.status!==200)throw Error('report_transition_unconfirmed');
  if(value.release&&value.lastError&&status!=='awaiting_login'&&binding.chatId){const directory=join(realpathSync(home),'.botmux/platform/report-notices');privateDir(directory);const path=join(directory,digest(runId+'/'+status+'/'+value.lastError)+'.json');if(!read(path)){const messageId=await notify(binding,'报告已保留。'+value.lastError,messageKey('report-notice/'+runId+'/'+status+'/'+value.lastError));save(path,{messageId});}}
 };
 const binding=row.chatBinding??{};
 try{
  if(['ambiguous_report','invalid_report'].includes(row.status)){await transition(row.status,{release:true,lastError:row.status==='invalid_report'?'报告不是有效 UTF-8，请检查产物':'最终报告不唯一，请明确汇总节点'});return;}
  if(!profile.appId||!profile.appSecret||profile.appId!==binding.larkAppId||!binding.ownerOpenId){
   await transition('awaiting_configuration',{release:true,lastError:'文档待交付：请配置匹配 Workflow 的固定发布应用'});return;
  }
  const root=join(realpathSync(home),'.botmux/platform/report-publisher',profile.appId);privateDir(root);
  const stamp=join(root,'application.json'),key=digest(profile.appSecret);if(read(stamp)?.key!==key){await run(['config','init','--app-id',profile.appId,'--app-secret-stdin','--brand',profile.brand||'feishu'],profile.appSecret,root);save(stamp,{key});}
  let auth:any;try{auth=await run(['auth','status','--json','--verify'],'',root);}catch{}
  let user=auth?.identities?.user;
  if(user?.tokenStatus==='needs_refresh'){try{if(profile.folderToken)await run(['drive','files','list','--as','user','--params',JSON.stringify({folder_token:profile.folderToken,page_size:1}),'--format','json'],'',root);auth=await run(['auth','status','--json','--verify'],'',root);user=auth?.identities?.user;}catch{}}
  const pendingPath=join(root,'authorization.json');let pending=read(pendingPath);
  if(!authorizedUser(auth)){
   if(pending?.expiresAt>Date.now()){try{await run(['auth','login','--device-code',pending.deviceCode,'--json'],'',root);auth=await run(['auth','status','--json','--verify'],'',root);user=auth.identities?.user;}catch{}}
   if(!authorizedUser(auth)){
    if(!pending||pending.expiresAt<=Date.now()){
     const issued=await run(['auth','login','--domain','docs','--domain','drive','--no-wait','--json'],'',root);
     const url=issued.verification_url??issued.verification_uri_complete,deviceCode=issued.device_code;
     if(typeof url!=='string'||!url.startsWith('https://')||typeof deviceCode!=='string')throw Error('invalid_authorization_response');
     pending={url,deviceCode,expiresAt:Date.now()+Math.min(1800,Number(issued.expires_in)||600)*1000};save(pendingPath,pending);
    }
    if(!pending.notified){const image=join(root,'authorization.png');await run(['auth','qrcode',pending.url,'--output','authorization.png'],'',root);
     await notify(binding,'报告已保留，文档待授权。请固定发布账号完成登录：\n'+pending.url,messageKey('authorization/'+profile.appId+'/'+pending.deviceCode),image);save(pendingPath,{...pending,notified:true});}
    await transition('awaiting_login',{release:true,lastError:'文档待交付：等待固定用户授权'});return;
   }
  }
  const expected=profile.userOpenId||binding.ownerOpenId;
  if(user?.openId!==expected){await run(['auth','logout','--json'],'',root);if(existsSync(pendingPath))unlinkSync(pendingPath);await transition('awaiting_login',{release:true,lastError:'登录身份与固定发布账号不符，请重新授权'});return;}
  if(!profile.userOpenId){const r=await api('/report-settings','PUT',{appId:profile.appId,userOpenId:expected,folderToken:profile.folderToken??'',revision:profile.revision,holder});if(r.status!==200)throw Error('report_identity_unconfirmed');}
  if(existsSync(pendingPath))unlinkSync(pendingPath);
  if(!profile.folderToken){await transition('awaiting_configuration',{release:true,lastError:'授权已完成，文档待交付：请配置报告文件夹'});return;}
  const receiptPath=join(root,digest(runId)+'.json');let receipt=read(receiptPath);
  if(receipt&&receipt.hash!==row.reportHash)throw Error('report_artifact_changed');
  documentId=row.documentId??receipt?.documentId;documentUrl=row.documentUrl??receipt?.documentUrl;
  if(!documentId){
   if(['creating','creation_unknown'].includes(row.status)){await transition('creation_unknown',{release:true,lastError:'文档创建结果待核对，禁止盲目重复创建'});return;}
   await transition('creating');
   try{const value=await run(['docs','+create','--as','user','--doc-format','markdown','--title',runId+' report','--parent-token',profile.folderToken,'--content','-'],row.reportText+'\n\n---\nWorkflow run: '+runId+'\nReport digest: '+row.reportHash,root);
    documentId=value.document?.document_id;documentUrl=value.document?.url;if(typeof documentId!=='string'||typeof documentUrl!=='string')throw Error('invalid_created_document');
    receipt={hash:row.reportHash,documentId,documentUrl};save(receiptPath,receipt);
   }catch{await transition('creation_unknown',{release:true,lastError:'创建结果待核对；本地报告仍保留'});return;}
  }
  if(!receipt){const content=await run(['docs','+fetch','--as','user','--doc',documentUrl],'',root);const text=JSON.stringify(content);if(!text.includes(runId)||!text.includes(row.reportHash)){await transition('creation_unknown',{release:true,lastError:'文档内容与作业摘要不匹配，请核对'});return;}receipt={hash:row.reportHash,documentId,documentUrl};save(receiptPath,receipt);}
  stage='permission_pending';await transition('permission_pending',{documentId,documentUrl});
  // View permission is part of the approved report-delivery contract. Never
  // grant edit/full_access or publish a public URL as a silent fallback.
  if(binding.ownerOpenId===expected)await run(['docs','+fetch','--as','user','--doc',documentUrl],'',root);
  else{
   await run(['drive','+member-add','--as','user','--token',documentId,'--type','docx','--member-type','openid','--member-id',binding.ownerOpenId,'--perm','view','--yes'],'',root);
   await transition('permission_pending',{documentId,documentUrl});
   const members=await run(['drive','+member-list','--as','user','--token',documentId,'--type','docx','--json'],'',root),list=members.items??members.members??members.data?.items??[];
   if(!list.some((m:any)=>(m.member_id??m.open_id)===binding.ownerOpenId))throw Error('report_reader_access_unconfirmed');
  }
  stage='notifying';await transition('notifying',{documentId,documentUrl});
  let messageId=row.messageId??receipt?.messageId;
  if(!messageId){messageId=await notify(binding,'Workflow 已完成。完整报告：\n'+documentUrl,messageKey('report-delivery/'+runId+'/'+row.reportHash));save(receiptPath,{...receipt,hash:row.reportHash,documentId,documentUrl,messageId});}
  await transition('succeeded',{documentId,documentUrl,messageId,release:true,lastError:null});
 }catch{await transition(stage,{...(documentId?{documentId,documentUrl}:{}),release:true,lastError:stage==='notifying'?'文档已保留，文档待交付：原话题回帖尚未确认':stage==='permission_pending'?'文档已保留，文档待交付：读者权限尚未确认':'文档待交付：配置、授权或远端操作尚未确认'}).catch(()=>{});}
}
async function notifyReport(binding:any,text:string,key:string,image?:string):Promise<string>{
 if(!binding.larkAppId||!binding.chatId)throw Error('report_message_destination_missing');
 if(image){const imageKey=await uploadImage(binding.larkAppId,image);const content=JSON.stringify({elements:[{tag:'div',text:{tag:'plain_text',content:text}},{tag:'img',img_key:imageKey,alt:{tag:'plain_text',content:'固定发布账号授权二维码'}}]});
  return binding.rootMessageId?replyMessage(binding.larkAppId,binding.rootMessageId,content,'interactive',true,key):sendMessage(binding.larkAppId,binding.chatId,content,'interactive',key);
 }
 return binding.rootMessageId?replyMessage(binding.larkAppId,binding.rootMessageId,text,'text',true,key):sendMessage(binding.larkAppId,binding.chatId,text,'text',key);
}
export function startReportPublisher(larkAppId?:string,{role=containerRole,api=platformRequest,publish=publishReport}:{role?:typeof containerRole;api?:API;publish?:(runId:string)=>Promise<unknown>}={}){if(role()!=='control'||!larkAppId)return ()=>{};let busy=false;const tick=async()=>{if(busy)return;busy=true;try{const configuration=await api('/report-settings');if(configuration.status===200&&configuration.data.appId===larkAppId){const p=configuration.data,path=join(realpathSync(homedir()),'.botmux/platform');privateDir(path);save(join(path,'report-publishing-context.json'),{appId:p.appId,userOpenId:p.userOpenId,folderToken:p.folderToken,revision:p.revision,larkCliDataDir:join(path,'report-publisher',p.appId)});}const r=await api('/report-deliveries?publisherAppId='+encodeURIComponent(larkAppId));if(r.status===200)for(const d of r.data.deliveries??[])if(d.status!=='creation_unknown'&&d.larkAppId===larkAppId)await publish(d.runId);}catch{/* No credentials or remote bodies enter logs. */}finally{busy=false;}};const timer=setInterval(()=>void tick(),10000);timer.unref();void tick();return ()=>clearInterval(timer);}
