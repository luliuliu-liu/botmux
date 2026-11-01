import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishReport,startReportPublisher} from '../src/platform/workflow/report-publisher.js';
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'report-publisher-')),row:any={status:'awaiting_configuration',reportHash:'hash',reportText:'# Report',chatBinding:{larkAppId:'cli_fixture',ownerOpenId:'ou_owner',chatId:'chat',rootMessageId:'topic'}};
 const profile={appId:'cli_fixture',appSecret:'private-test-secret',userOpenId:'ou_owner',folderToken:'folder',revision:1};
 const calls:any[]=[],notices:any[]=[];let creates=0,logged=true,failCreate=false,dropTransition=false;
 const api=async(path:string,_method='GET',body:any={})=>{if(path.endsWith('/claim'))return {status:200,data:{claimed:true,holder:'holder',row:{...row},profile}};
  if(dropTransition&&body.status==='permission_pending'){dropTransition=false;return {status:500,data:{}};}
  if(body.status)Object.assign(row,body);return {status:200,data:{}};};
 const run=async(args:string[],input:string,cwd:string)=>{calls.push({args,input,cwd});
  if(args[0]==='config')return {};
  if(args[1]==='status')return logged?{verified:true,identities:{user:{status:'ready',openId:'ou_owner'}}}:{verified:false};
  if(args[0]==='auth'&&args.includes('--no-wait'))return {verification_url:'https://auth.example/opaque?x=1',device_code:'test-device',expires_in:600};
  if(args[1]==='qrcode'){writeFileSync(join(cwd,'authorization.png'),'fixture-image');return {};}
  if(args[1]==='logout')return {};
  if(args.includes('--device-code'))throw Error('waiting');
  if(args[1]==='+create'){creates++;if(failCreate)throw Error('lost response');return {document:{document_id:'doc-id',url:'https://test.feishu.cn/docx/doc-id'}};}
  if(args[1]==='+fetch')return {content:'run-a run-b hash'};
  if(args[1]==='+member-add')return {};
  if(args[1]==='+member-list')return {items:[{member_id:'ou_owner'}]};throw Error('unexpected command');
 };
 const notify=async(...args:any[])=>{notices.push(args);return 'message-id';};
 return {home,row,profile,calls,notices,api,run,notify,creates:()=>creates,logged:(v:boolean)=>{logged=v;},failCreate:()=>{failCreate=true;},dropTransition:()=>{dropTransition=true;},cleanup:()=>rmSync(home,{recursive:true,force:true})};
}
it('publishes as the fixed user, checks access and reuses its durable document receipt',async()=>{
 const f=fixture();try{await publishReport('run-a',f);expect(f.row.status).toBe('succeeded');expect(f.creates()).toBe(1);expect(f.notices[0][2].length).toBeLessThanOrEqual(50);expect(f.notices[0][0]).toMatchObject({larkAppId:'cli_fixture',rootMessageId:'topic'});
  await publishReport('run-a',f);expect(f.creates()).toBe(1);expect(f.calls.find(c=>c.args[1]==='+create').args).toContain('user');expect(JSON.stringify(f.calls.map(c=>c.args))).not.toContain('private-test-secret');
 }finally{f.cleanup();}
});
it('holds unknown creation without retrying create, while a lost transition with local receipt is recoverable',async()=>{
 const f=fixture();try{f.failCreate();await publishReport('run-a',f);expect(f.row.status).toBe('creation_unknown');await publishReport('run-a',f);expect(f.creates()).toBe(1);}finally{f.cleanup();}
 const recovered=fixture();try{recovered.dropTransition();await publishReport('run-b',recovered);await publishReport('run-b',recovered);expect(recovered.row.status).toBe('succeeded');expect(recovered.creates()).toBe(1);}finally{recovered.cleanup();}
});
it('sends an opaque login link and QR once and keeps report waiting until authorization succeeds',async()=>{
 const f=fixture();try{f.logged(false);await publishReport('run-a',f);expect(f.row.status).toBe('awaiting_login');expect(f.notices[0][1]).toContain('https://auth.example/opaque?x=1');expect(f.notices[0][3]).toContain('authorization.png');expect(f.creates()).toBe(0);
  await publishReport('run-a',f);expect(f.notices).toHaveLength(1);f.logged(true);await publishReport('run-a',f);expect(f.row.status).toBe('succeeded');expect(f.creates()).toBe(1);
 }finally{f.cleanup();}
});
it('does not publish with a mismatched identity or without a configured report directory',async()=>{
 const f=fixture();try{f.profile.userOpenId='ou_other';await publishReport('run-a',f);expect(f.row.status).toBe('awaiting_login');expect(f.creates()).toBe(0);
  f.profile.userOpenId='ou_owner';f.profile.folderToken='';await publishReport('run-a',f);expect(f.row.status).toBe('awaiting_configuration');expect(f.creates()).toBe(0);
 }finally{f.cleanup();}
});

it('refreshes an expiring user token through a readonly request before considering login',async()=>{
 const f=fixture();let refreshed=false;const original=f.run;
 try{const run:any=async(args:string[],...rest:any[])=>{if(args[0]==='auth'&&args[1]==='status'&&!refreshed)return {verified:true,identities:{user:{openId:'ou_owner',tokenStatus:'needs_refresh'}}};if(args[0]==='drive'&&args[1]==='files'&&args[2]==='list'){refreshed=true;return {files:[]};}return original(args,...rest as [string,string]);};await publishReport('refresh-run',{...f,run});expect(refreshed).toBe(true);expect(f.row.status).toBe('succeeded');expect(f.calls.some(c=>c.args[0]==='auth'&&c.args[1]==='login')).toBe(false);}finally{f.cleanup();}
});
it('keeps a failed topic reply in notifying and resumes delivery without creating another document',async()=>{
 const f=fixture();let failure=true;const notify=async(...args:any[])=>{if(failure)throw Error('Bot not registered');return f.notify(...args);};
 try{await publishReport('run-a',{...f,notify});expect(f.row.status).toBe('notifying');expect(f.row.lastError).toContain('回帖');expect(f.row.documentId).toBe('doc-id');expect(f.creates()).toBe(1);
  failure=false;await publishReport('run-a',{...f,notify});expect(f.row.status).toBe('succeeded');expect(f.creates()).toBe(1);expect(f.row.messageId).toBe('message-id');
 }finally{f.cleanup();}
});
it('keeps genuine read-access failures in permission_pending with the existing document',async()=>{
 const f=fixture();const original=f.run;let fail=true;
 try{const run=async(...args:Parameters<typeof f.run>)=>{if(fail&&args[0][1]==='+fetch')throw Error('permission denied');return original(...args);};await publishReport('run-a',{...f,run});expect(f.row.status).toBe('permission_pending');expect(f.row.lastError).toContain('读者权限');expect(f.creates()).toBe(1);
  fail=false;await publishReport('run-a',{...f,run});expect(f.row.status).toBe('succeeded');expect(f.creates()).toBe(1);
 }finally{f.cleanup();}
});

it('starts only in an identified Control daemon and publishes only that workflow bot',async()=>{
 const api=vi.fn(async(path:string)=>path==='/report-settings'?{status:200,data:{}}:{status:200,data:{deliveries:[{runId:'mine',larkAppId:'cli_self',status:'permission_pending'},{runId:'other',larkAppId:'cli_other',status:'notifying'},{runId:'unknown',larkAppId:'cli_self',status:'creation_unknown'}]}});
 const publish=vi.fn(async()=>{});const inactive=startReportPublisher(undefined,{role:()=> 'control',api,publish});inactive();expect(api).not.toHaveBeenCalled();
 const worker=startReportPublisher('cli_self',{role:()=> 'worker',api,publish});worker();expect(api).not.toHaveBeenCalled();
 const stop=startReportPublisher('cli_self',{role:()=> 'control',api,publish});try{await vi.waitFor(()=>expect(publish).toHaveBeenCalledOnce());expect(publish).toHaveBeenCalledWith('mine');expect(api).toHaveBeenCalledWith('/report-deliveries?publisherAppId=cli_self');}finally{stop();}
});
