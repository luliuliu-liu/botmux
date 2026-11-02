import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {launchSmokeBrowser} from './smoke-browser.mjs';

const root=fileURLToPath(new URL('..',import.meta.url)),folder=await mkdtemp(join(tmpdir(),'platform-ui-'));
const output=process.env.PLATFORM_UI_SCREENSHOTS?resolve(process.env.PLATFORM_UI_SCREENSHOTS):null;
let browser,server;
try{
 await build({absWorkingDir:root,entryPoints:['test/fixtures/platform-acceptance.tsx'],outfile:join(folder,'app.js'),bundle:true,format:'esm',platform:'browser',jsx:'automatic',external:['/assets/*'],logLevel:'warning',
  plugins:[{name:'dashboard-css-alias',setup(api){api.onResolve({filter:/^\.\/platform-management\.css$/},()=>({path:join(root,'src/dashboard/web/platform/management.css')}));}}]});
 server=createServer(async(req,res)=>{
  try{const path=new URL(req.url,'http://localhost').pathname;
   if(path==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><main id="root"></main><script type="module" src="/app.js"></script></body></html>');return;}
   if(!['/app.js','/app.css'].includes(path)){res.writeHead(404);res.end();return;}
   res.setHeader('content-type',extname(path)==='.css'?'text/css':'application/javascript');res.end(await readFile(join(folder,path.slice(1))));
  }catch{res.writeHead(500);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await launchSmokeBrowser();
 const page=await browser.newPage();
 const origin=`http://127.0.0.1:${server.address().port}`;
 await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 if(output)await mkdir(output,{recursive:true});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const screen=async name=>{if(output)await page.screenshot({path:join(output,name+'.png'),fullPage:false});};
 async function navigate(route){await page.evaluate(r=>{window.platformSmoke.clearCache();location.hash='#/'+r;},route);await page.locator('.pm-management-panel').waitFor();}
 async function noBlank(){await page.locator('.pm-management-heading').waitFor();const header=await page.locator('.pm-management-heading').boundingBox(),layout=await page.locator('.pm-management-layout').boundingBox();assert(layout.y-(header.y+header.height)<60,'unexpected blank gap below management header');}
 const dialog=()=>page.locator('dialog'),save=()=>dialog().getByRole('button',{name:'保存并继续',exact:true});
 const closeDialog=async()=>{await dialog().getByRole('button',{name:'关闭',exact:true}).first().click();await dialog().waitFor({state:'hidden'});};
 const poolAction=async name=>{const trigger=page.getByRole('button',{name:'工作区池 的操作',exact:true});await trigger.scrollIntoViewIfNeeded();await page.waitForTimeout(100);await trigger.click();await page.getByRole('menuitem',{name,exact:true}).click();};
 const mcpAction=async(row,name)=>{await row.locator('button[aria-haspopup=menu]').click();await page.getByRole('menuitem',{name,exact:true}).click();};
 const memberAction=async(name,action)=>{const row=poolRow(name);await row.locator('button[aria-haspopup=menu]').click();await page.getByRole('menuitem',{name:action==='编辑'?'修改配置':action,exact:true}).click();};
 const poolRow=name=>page.locator('tbody tr').filter({has:page.getByText(name,{exact:true})});
 const poolWrites=async()=>page.evaluate(()=>window.platformSmoke.requests.filter(row=>row.method!=='GET'&&(row.path.startsWith('/agent-pools')||row.path.startsWith('/workflow-resources'))));
 async function exercisePools(width){
  // Reload the CURRENT source fixture, never attach to the user's deployment.
  await page.goto(origin+'/#/platform-agents?section=pool');await page.reload();await page.getByText('Pool coder',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.platformSmoke.requests.filter(row=>row.path==='/agent-pools').length),1,'initial pool list loads once');
  assert.equal(await page.evaluate(()=>window.platformSmoke.requests.filter(row=>row.path==='/agent-pools/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa').length),1,'initial default detail loads once');
  await page.getByRole('button',{name:'工作区池 的操作',exact:true}).click();assert.equal(await page.getByRole('menuitem',{name:'新建工作区池',exact:true}).count(),0);await page.keyboard.press('Escape');
  assert(await page.getByText('0 / 4 个任务',{exact:true}).count()>0);assert.equal(await page.getByText('共享 workspace：fixture-workspace',{exact:true}).count(),0);
  const resolve=()=>page.getByRole('button',{name:'选择 / 补建 Agent',exact:true});
  // Close a delayed B response, then ensure it cannot corrupt an A edit.
  await page.evaluate(()=>{window.platformSmoke.holdDetailId='cccccccc-cccc-cccc-cccc-cccccccccccc';});
  await resolve().click();await dialog().getByRole('status').first().waitFor();await dialog().getByLabel('处理方式',{exact:true}).selectOption('existing');
  assert.equal(await save().isDisabled(),true);assert.equal(await dialog().locator('select[name=memberId] option').count(),0);
  await closeDialog();await memberAction('Pool coder','编辑');
  await page.evaluate(()=>{window.platformSmoke.holdDetailId='';window.platformSmoke.releaseDetails();});
  assert.equal(await dialog().locator('input[name=displayName]').inputValue(),'Pool coder');assert((await dialog().getByText('共享 workspace：fixture-workspace',{exact:true}).count())===1);
  await closeDialog();
  // Target detail failure remains in the dialog and has a real retry button.
  await page.evaluate(()=>{window.platformSmoke.failNextPoolDetail=true;});await resolve().click();await dialog().getByRole('alert').waitFor();assert.equal(await save().isDisabled(),true);
  await dialog().getByRole('button',{name:'重试加载',exact:true}).click();await dialog().getByText('共享 workspace：/fixture-review-workspace',{exact:true}).waitFor();
  await dialog().getByLabel('处理方式',{exact:true}).selectOption('existing');
  assert.deepEqual(await dialog().locator('select[name=memberId] option').allInnerTexts(),['Pool reviewer · Implement and test code']);await screen('agent-pool-target-b-'+width);
  assert.equal(await page.getByLabel('Agent 池',{exact:true}).inputValue(),'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');await closeDialog();
  // Cross-tab model change is visible on explicit refresh, not just cache TTL.
  await page.evaluate(()=>{window.platformSmoke.data['/models']={models:[]};});await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.waitForFunction(()=>window.platformSmoke.requests.filter(row=>row.path==='/models').length===2);
  await poolAction('新建池成员');await dialog().getByRole('link',{name:'模型连接配置',exact:true}).waitFor();assert.equal(await save().isDisabled(),true);await screen('agent-pool-empty-models-'+width);await closeDialog();
  await resolve().click();await dialog().getByText('共享 workspace：/fixture-review-workspace',{exact:true}).waitFor();assert.equal(await save().isDisabled(),true);
  await dialog().getByLabel('处理方式',{exact:true}).selectOption('existing');assert.equal(await save().isEnabled(),true);await closeDialog();
  // Editing a fixed member remains available without enabled model profiles.
  await memberAction('Pool coder','编辑');await dialog().locator('input[name=displayName]').fill('Edited coder');await dialog().locator('textarea[name=description]').fill('Edited description');
  assert.equal(await dialog().locator('input[name=confirmRestart]').count(),0);assert.equal(await save().isEnabled(),true);
  await save().click();await dialog().waitFor({state:'hidden'});await page.getByText('Edited coder',{exact:true}).waitFor();
  let request=(await poolWrites()).at(-1);assert.equal(request.method,'PUT');assert(!request.path.endsWith('/rebuild'));
  // Resource/mount changes require confirmation; ordinary edits did not.
  await memberAction('Edited coder','编辑');const beforeRebuild=(await poolWrites()).length;
  await dialog().locator('input[name=displayName]').fill('Rebuilt coder');await dialog().locator('input[name=cpu]').fill('6');
  assert.equal(await save().isDisabled(),true);await dialog().locator('form').evaluate(form=>form.requestSubmit());assert.equal((await poolWrites()).length,beforeRebuild,'unconfirmed rebuild must send no mutation');await dialog().getByRole('alert').waitFor();await screen('agent-pool-rebuild-unconfirmed-'+width);
  await dialog().locator('input[name=mountGlobalReadOnly]').check();await dialog().locator('input[name=confirmRestart]').check();await save().click();await dialog().waitFor({state:'hidden'});await page.getByText('Rebuilt coder',{exact:true}).waitFor();
  request=(await poolWrites()).at(-1);assert.equal(request.method,'POST');assert(request.path.endsWith('/rebuild'));assert.equal(request.body.displayName,'Rebuilt coder');assert.equal(request.body.cpu,6);assert.equal(request.body.mountGlobalReadOnly,true);assert.equal(request.body.confirmRestart,true);
  // Restore profiles, then exercise a delayed failure and synchronous reentry.
  await page.evaluate(()=>{window.platformSmoke.data['/models']={models:window.platformSmoke.models};});await page.getByRole('button',{name:'刷新',exact:true}).click();
  await poolAction('新建池成员');await dialog().locator('select[name=modelChoice] option').first().waitFor({state:'attached'});
  await dialog().locator('input[name=displayName]').fill('Smoke pool worker');await dialog().locator('textarea[name=description]').fill('Review and test code');
  const beforeCreate=(await poolWrites()).length;
  await page.evaluate(()=>{window.platformSmoke.failNextPoolAction=true;window.platformSmoke.holdNextPoolAction=true;});
  await dialog().locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
  await dialog().getByRole('button',{name:'处理中…',exact:true}).waitFor();assert.equal((await poolWrites()).length,beforeCreate+1);assert.equal(await dialog().getByRole('button',{name:'关闭',exact:true}).isDisabled(),true);assert.equal(await resolve().isDisabled(),true);
  await page.evaluate(()=>window.platformSmoke.releasePoolAction());await dialog().getByRole('alert').waitFor();
  assert.equal(await dialog().locator('input[name=displayName]').inputValue(),'Smoke pool worker');assert.equal(await dialog().locator('textarea[name=description]').inputValue(),'Review and test code');assert.equal(await save().isEnabled(),true);await screen('agent-pool-create-rejected-'+width);
  await save().click();await dialog().waitFor({state:'hidden'});await page.getByText('Smoke pool worker',{exact:true}).waitFor();
  const attempts=(await poolWrites()).slice(beforeCreate);assert.equal(attempts.length,2);assert.equal(attempts[0].body.requestId,attempts[1].body.requestId);assert.equal(attempts[1].body.cpu,2);assert.equal(attempts[1].body.memoryMiB,4096);assert.equal(attempts[1].body.mountGlobalReadOnly,false);
  // Dynamic profiles must yield an empty model ID despite stale stored IDs.
  await page.evaluate(()=>{window.platformSmoke.data['/models']={models:[{...window.platformSmoke.models[1],modelId:'stale',modelIds:['stale']}]};});await page.getByRole('button',{name:'刷新',exact:true}).click();await poolAction('新建池成员');
  await dialog().locator('select[name=agentType]').selectOption('claude-code');assert.deepEqual(await dialog().locator('select[name=modelChoice] option').evaluateAll(options=>options.map(option=>JSON.parse(option.value))),[['vercel-fixture','']]);
  await dialog().locator('input[name=displayName]').fill('Dynamic worker');await dialog().locator('textarea[name=description]').fill('Dynamic model fixture');await save().click();await dialog().waitFor({state:'hidden'});assert.equal((await poolWrites()).at(-1).body.modelId,'');
  await page.evaluate(()=>{window.platformSmoke.data['/models']={models:window.platformSmoke.models};});await page.getByRole('button',{name:'刷新',exact:true}).click();
  // Opening enroll refreshes stale list caches and excludes ANY pool marker.
  await page.evaluate(()=>{const rows=window.platformSmoke.data['/containers'].containers;rows.push({...rows[1],containerId:'fresh-eligible',displayName:'Fresh eligible'});});
  await poolAction('纳入已有 Agent');await dialog().locator('select[name=containerId] option').first().waitFor({state:'attached'});
  assert.deepEqual(await dialog().locator('select[name=containerId] option').evaluateAll(options=>options.map(option=>option.value)),['fixture-worker','fresh-eligible']);
  await dialog().locator('select[name=containerId]').selectOption('fresh-eligible');await dialog().locator('textarea[name=description]').fill('Enrolled fixture');await save().click();await dialog().waitFor({state:'hidden'});await page.getByText('Fresh eligible',{exact:true}).waitFor();assert.equal((await poolWrites()).at(-1).body.containerId,'fresh-eligible');
  // Pool and remove dialogs retain inline errors rather than hiding them behind Modal.
  await memberAction('Smoke pool worker','移出');await page.evaluate(()=>{window.platformSmoke.failNextPoolAction=true;});await dialog().getByRole('button',{name:'确认移出',exact:true}).click();await dialog().getByRole('alert').waitFor();await dialog().getByRole('button',{name:'确认移出',exact:true}).click();await dialog().waitFor({state:'hidden'});assert.equal(await page.getByText('Smoke pool worker',{exact:true}).count(),0);
  // Historical pending retry must not report success without a confirmed member.
  await page.evaluate(()=>{window.platformSmoke.unconfirmedNextPoolAction=true;});await memberAction('Pending coder','重试配置');await page.getByRole('alert').waitFor();assert.equal(await poolRow('Pending coder').locator('button[aria-haspopup=menu]').isDisabled(),false);
  await memberAction('Pending coder','重试配置');await poolRow('Pending coder').locator('button[aria-haspopup=menu]').waitFor();await page.waitForFunction(()=>{const row=[...document.querySelectorAll('tbody tr')].find(row=>row.textContent.includes('Pending coder'));return row&&!row.querySelector('button').disabled;});
  await page.evaluate(()=>{const row=window.platformSmoke.data['/agent-pools/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'].members.find(row=>row.displayName==='Pending coder');row.configurationPending=true;row.quarantined=true;});await page.getByRole('button',{name:'刷新',exact:true}).click();await memberAction('Pending coder','撤销待确认配置');
  const beforeCancel=(await poolWrites()).length;await page.evaluate(()=>{window.platformSmoke.holdNextPoolAction=true;window.platformSmoke.unconfirmedNextPoolAction=true;});await dialog().locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});await dialog().getByRole('button',{name:'处理中…',exact:true}).waitFor();assert.equal((await poolWrites()).length,beforeCancel+1);assert.equal(await dialog().getByRole('button',{name:'关闭',exact:true}).isDisabled(),true);
  await page.evaluate(()=>window.platformSmoke.releasePoolAction());await dialog().getByRole('alert').waitFor();assert.equal(await poolRow('Pending coder').locator('button[aria-haspopup=menu]').isDisabled(),false);await screen('agent-pool-cancel-unconfirmed-'+width);
  await dialog().getByRole('button',{name:'确认撤销',exact:true}).click();await dialog().waitFor({state:'hidden'});assert.equal((await poolWrites()).at(-1).body.revision,4);
  // Finally resolve B with its own member and hold the request to verify busy gates.
  await resolve().click();await dialog().getByText('共享 workspace：/fixture-review-workspace',{exact:true}).waitFor();await dialog().getByLabel('处理方式',{exact:true}).selectOption('existing');await page.evaluate(()=>{window.platformSmoke.holdNextPoolAction=true;});await save().click();await dialog().getByRole('button',{name:'处理中…',exact:true}).waitFor();assert.equal(await resolve().isDisabled(),true);
  await page.evaluate(()=>window.platformSmoke.releasePoolAction());await dialog().waitFor({state:'hidden'});const resolved=(await poolWrites()).at(-1);assert.equal(resolved.path,'/workflow-resources/fixture-review-run/ffffffff-ffff-ffff-ffff-ffffffffffff/resolve');assert.deepEqual(resolved.body,{memberId:'dddddddd-dddd-dddd-dddd-dddddddddddd'});
  await poolAction('删除工作区池');await dialog().getByRole('button',{name:'确认删除池',exact:true}).click();await dialog().getByRole('alert').waitFor();await dialog().getByRole('button',{name:'取消',exact:true}).click();
  await screen('agent-pool-'+width);assert.deepEqual(await page.evaluate(()=>window.platformSmoke.unknown),[],'all pool CRUD/actions need explicit fixture handlers');
 }
 for(const width of [1440,1000]){
  await page.setViewportSize({width,height:900});
  // Each viewport starts with fresh fixture revisions and login receipts.
  await page.goto(origin);await page.locator('.pm-management-panel').waitFor();await page.evaluate(()=>{const c=window.platformSmoke.data['/containers'].containers.find(c=>c.containerId==='fixture-dev');c.poolId=null;c.poolMemberId=null;window.platformSmoke.clearCache();});
  await navigate('platform-agents?section=instances');await page.getByText('Dev acceptance',{exact:true}).waitFor();await noBlank();
  assert.equal(await page.locator('.pm-cli-row').count(),0);
  assert.equal(await page.locator('.pm-agent-table tbody tr').first().locator('td').count(),4);
  assert.equal(await page.locator('.pm-agent-table tbody tr').first().locator('td').first().getAttribute('colspan'),'2');
  await page.getByRole('button',{name:/展开 CLI/}).click();await page.waitForFunction(()=>document.querySelectorAll('.pm-cli-row').length===4);assert.equal(await page.locator('.pm-cli-row').count(),4);
  await screen('agents-expanded-'+width);
  // The instance row must show a readable image tag, never the raw digest.
  assert(await page.locator('.pm-agent-table').getByText('dev-agent:fixture').count()>0,'instance row should show the image tag');
  assert.equal(await page.locator('.pm-agent-table').getByText('sha256:1111').count(),0,'instance row must not show raw image digests');
  await page.getByRole('button',{name:'Dev acceptance 的操作',exact:true}).click();
  assert.equal(await page.getByRole('menuitem',{name:'修改模型 / 配置',exact:true}).count(),0);
  await page.getByRole('menuitem',{name:'登录 CLI',exact:true}).click();
  await page.locator('dialog').getByText('gh / Git',{exact:true}).waitFor();assert.equal(await page.locator('dialog').getByText('Docker CLI',{exact:true}).count(),1);
  const instanceGithub=page.locator('dialog .pm-info-note').filter({hasText:'gh / Git'});await instanceGithub.locator('select').selectOption('github-fixture');await instanceGithub.getByRole('button',{name:'登录',exact:true}).click();await instanceGithub.getByText('已应用 · 登录时已验证').waitFor();
  let loginRequest=await page.evaluate(()=>window.platformSmoke.requests.filter(r=>r.method==='POST'&&r.path==='/cli-logins/fixture-dev/github').at(-1));
  assert.deepEqual(loginRequest.body,{id:'github-fixture',revision:0});
  await page.evaluate(()=>{window.platformSmoke.failNextCliLogin=true;});
  await instanceGithub.getByRole('button',{name:'登录',exact:true}).click();
  await instanceGithub.getByText('待同步 · 认证未确认',{exact:true}).waitFor();
  await instanceGithub.getByRole('alert').getByText('Fixture login rejected',{exact:true}).waitFor();
  assert.equal(await instanceGithub.getByRole('button',{name:'登录',exact:true}).isEnabled(),true,'failed login must allow retry');
  await instanceGithub.getByRole('button',{name:'登录',exact:true}).click();
  await instanceGithub.getByText('已应用 · 登录时已验证').waitFor();
  loginRequest=await page.evaluate(()=>window.platformSmoke.requests.filter(r=>r.method==='POST'&&r.path==='/cli-logins/fixture-dev/github').at(-1));
  assert.deepEqual(loginRequest.body,{id:'github-fixture',revision:2},'retry must use the refreshed revision');
  await screen('instance-cli-login-'+width);await page.locator('dialog header button').click();
  await page.getByRole('button',{name:'Worker acceptance 的操作',exact:true}).click();await page.getByRole('menuitem',{name:'登录 CLI',exact:true}).click();await page.locator('dialog').getByText('gh / Git',{exact:true}).waitFor();assert.equal(await page.locator('dialog').getByText('Docker CLI',{exact:true}).count(),0);await page.locator('dialog header button').click();
  await page.getByRole('button',{name:'Dev acceptance 的操作',exact:true}).click();
  await page.evaluate(()=>{const c=window.platformSmoke.data['/containers'].containers.find(c=>c.containerId==='fixture-dev');c.poolId=null;c.poolMemberId=null;window.platformSmoke.clearCache();});
  await page.getByRole('menuitem',{name:'镜像升级 / 回滚'}).click();
  const check=page.locator('.pm-check input[type=checkbox]'),text=page.locator('.pm-check span');
  const a=await check.boundingBox(),b=await text.boundingBox();assert(a.x+a.width<=b.x+2&&Math.abs(a.y+a.height/2-b.y-b.height/2)<14,'confirmation checkbox and text must be adjacent on one line');
  await screen('upgrade-checkbox-'+width);await page.locator('dialog header button').click();
  await page.getByRole('button',{name:'Dev acceptance 的操作',exact:true}).click();
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForTimeout(250);await page.getByRole('button',{name:'Dev acceptance 的操作',exact:true}).click();
  assert.equal(await page.getByRole('menuitem',{name:'MCP 管理',exact:true}).count(),0);assert.equal(await page.getByRole('menuitem',{name:'同步配置',exact:true}).count(),0);await page.getByRole('menuitem',{name:'修改配置',exact:true}).click();
  const instanceCli=dialog().getByLabel('配置 Agent',{exact:true});await instanceCli.waitFor();assert.equal(await instanceCli.locator('option').count(),4);assert.equal(await instanceCli.inputValue(),'pi');await instanceCli.selectOption('claude-code');await screen('unified-dev-config-'+width);await dialog().getByRole('button',{name:'保存并同步',exact:true}).click();await dialog().waitFor({state:'hidden'});
  const activation=await page.evaluate(()=>window.platformSmoke.requests.find(r=>r.method==='POST'&&r.path.endsWith('/clis/claude-code/activate')));assert.equal(activation.body.revision,1);
  await page.getByRole('button',{name:'Dev acceptance · Claude Code 的操作',exact:true}).click();
  assert.equal(await page.getByRole('menuitem',{name:'设为当前使用'}).count(),0,'CLI rows no longer carry the switch action');
  await page.getByRole('menuitem',{name:'修改模型'}).click();
  const claudeSelect=page.locator('select[aria-label="登录方式 / 模型"]');
  assert((await claudeSelect.locator('option').filter({hasText:'Claude 订阅登录'}).count())>0,'Claude Code Vercel option must exist');
  assert.equal(await claudeSelect.locator('optgroup[disabled]').count(),0,'Claude Code model groups must be selectable');
  await page.locator('dialog header button').click();
  await page.getByRole('button',{name:'Dev acceptance · ZCode 的操作',exact:true}).click();
  assert((await page.getByRole('menuitem',{name:'原生 OAuth 登录'}).count())>0,'ZCode CLI row must offer native login');
  await page.getByRole('menuitem',{name:'修改模型'}).click();
  const zcodeSelect=page.locator('select[aria-label="登录方式 / 模型"]');
  assert((await zcodeSelect.locator('option').filter({hasText:'BigModel 账号 OAuth 登录'}).count())>0,'ZCode account login option must exist');
  assert((await zcodeSelect.locator('option').filter({hasText:'BigModel Coding Plan API Key'}).count())>0,'ZCode API key option must describe the Coding Plan');
  assert.equal(await zcodeSelect.locator('optgroup[disabled]').count(),0,'ZCode model groups must be selectable');
  await page.locator('dialog header button').click();
  await navigate('platform-configuration?section=models');
  await page.getByRole('button',{name:'添加模型连接'}).click();
  await page.locator('dialog select[name=protocol]').selectOption('anthropic-messages');
  const advanced=page.locator('dialog details').filter({has:page.getByText('高级：Pi / Codex 逐模型能力（Claude 无需填写）',{exact:true})}).first();
  assert.equal(await advanced.evaluate(element=>element.open),false,'Claude model capabilities are optional');
  assert.equal(await page.locator('dialog input[name=provider]').isVisible(),false,'Claude does not require a visible Pi provider');
  assert.equal(await page.locator('dialog input[name=provider]').getAttribute('required'),null);
  assert((await page.locator('dialog [data-tip*="API Key（Bearer Token）"]').count())===1);
  await page.locator('dialog textarea[name=modelIds]').fill('main\nfast\nlarge\nagent');
  for(const [label,value] of [['Claude 默认主模型','large'],['Claude Haiku 模型','fast'],['Claude Sonnet 模型','large'],['Claude 子 Agent 模型','agent']])await page.getByLabel(label,{exact:true}).selectOption(value);
  assert.equal(await page.getByLabel('Claude Opus 模型',{exact:true}).inputValue(),'');
  await page.locator('dialog select[name=protocol]').selectOption('zcode-coding-plan');
  assert.equal(await page.locator('dialog textarea[name=modelIds]').count(),0,'dynamic protocol must hide static model fields');
  await page.locator('dialog select[name=protocol]').selectOption('anthropic-messages');
  assert.equal(await page.locator('dialog textarea[name=modelIds]').inputValue(),'main\nfast\nlarge\nagent');
  assert.equal(await page.getByLabel('Claude 默认主模型',{exact:true}).inputValue(),'large');
  assert.equal(await page.getByLabel('Claude Haiku 模型',{exact:true}).inputValue(),'fast');
  assert.equal(await page.getByLabel('Claude 子 Agent 模型',{exact:true}).inputValue(),'agent');
  await screen('claude-model-form-'+width);await page.locator('dialog header button').click();
  for(const section of ['proxies','credentials','workspaces']){await navigate('platform-configuration?section='+section);await noBlank();await screen(section+'-'+width);}
  await navigate('platform-configuration?section=credentials');await noBlank();
  // Only Docker and GitHub credentials exist; the GitHub / Git profile is
  // created through the same credential form, never as a separate block.
  assert.equal(await page.getByText('GitHub / Git 配置',{exact:true}).count(),0,'no standalone GitHub / Git section');
  await page.getByRole('button',{name:/新建凭证/}).click();
  const kindSelect=page.locator('select[name=kind]');
  await kindSelect.waitFor();
  assert.deepEqual(await kindSelect.locator('option').allInnerTexts(),['Docker Registry','GitHub'],'credential kinds are Docker and GitHub only');
  await kindSelect.selectOption('github');
  await page.locator('input[name=gitName]').waitFor();
  assert((await page.locator('dialog input[name=secret][type=password]').count())===1,'github form takes the classic token');
  await page.locator('dialog header button').click();
  await navigate('platform-agents?section=local');await page.getByRole('button',{name:/Dev Agent 运行环境 的操作/}).waitFor();
  const claudeRow=page.locator('.pm-local-cli-table tbody tr').filter({has:page.getByText('Claude Code',{exact:true})});
  await claudeRow.getByText('已配置 API Key',{exact:true}).waitFor();
  assert.equal(await claudeRow.getByText('已配置 API Key',{exact:true}).count(),1,'Claude API Key must be shown as configured');
  const codexRow=page.locator('.pm-local-cli-table tbody tr').filter({has:page.getByText('Codex',{exact:true})});
  assert.equal(await codexRow.getByText('已保存登录凭据',{exact:true}).count(),1,'OAuth status must describe login credentials');
  assert.equal(await page.locator('.pm-local-cli-table tbody button:not([aria-haspopup="menu"])').count(),0);
  await page.getByRole('button',{name:'ZCode 的操作',exact:true}).click();
  assert((await page.getByRole('menuitem',{name:'原生 OAuth 登录',exact:true}).count())>0,'local ZCode row must offer login');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Dev Agent 运行环境 的操作',exact:true}).click();
  assert.equal(await page.getByRole('menuitem',{name:'修改 Proxy',exact:true}).count(),0);await page.getByRole('menuitem',{name:'修改配置',exact:true}).click();await dialog().getByLabel('配置 Agent',{exact:true}).waitFor();assert.equal(await dialog().getByLabel('配置 Agent',{exact:true}).locator('option').count(),4);await dialog().getByLabel('配置 Agent',{exact:true}).selectOption('claude-code');await screen('unified-control-config-'+width);await dialog().getByRole('button',{name:'保存并同步',exact:true}).click();await dialog().waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Dev Agent 运行环境 的操作',exact:true}).click();
  await page.getByRole('menuitem',{name:'登录 CLI',exact:true}).click();await page.locator('dialog').getByText('gh / Git',{exact:true}).waitFor();assert.equal(await page.locator('dialog').getByText('Docker CLI',{exact:true}).count(),1);await screen('local-cli-login-'+width);await page.locator('dialog header button').click();
  await page.getByRole('button',{name:'ZCode 的操作',exact:true}).click();
  await page.getByRole('menuitem',{name:'原生 OAuth 登录',exact:true}).click();
  // Workbench stays available; no standalone native-login-page link until a
  // session is waiting, and even then it is one choice of two.
  assert((await page.locator('dialog [data-tip*="统一登录工作台"]').count())>0,'workbench login stays available');
  await page.locator('dialog select[aria-label=登录方式]').selectOption('local');
  assert.equal(await page.locator('dialog [role=alert]').filter({hasText:'请先在 Agent 管理 → 登录工作台新建浏览器配置。'}).count(),0);
  assert.equal(await page.locator('dialog').getByRole('button',{name:'发起原生登录'}).isEnabled(),true);
  await page.locator('dialog header button').click();
  await screen('local-'+width);
  await navigate('platform-agents?section=logins');
  await page.waitForSelector('.pm-login-workbench select');
  const loginModes=await page.evaluate(()=>[...document.querySelectorAll('select[aria-label="登录方式"] option')].map(o=>o.value));
  console.log('LOGINMODES ok');
  assert(loginModes.length===2&&loginModes.includes('local')&&loginModes.includes('workbench'),'login workbench offers workbench and local browser modes');
  assert((await page.evaluate(()=>[...document.querySelectorAll('.pm-login-workbench select')].filter(s=>!s.getAttribute('aria-label')).length))===1,'workbench mode keeps the browser profile selector');
  await page.evaluate(()=>{const select=document.querySelector('select[aria-label="登录方式"]');select.value='local';select.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForTimeout(200);
  assert((await page.locator('[data-tip*="本地浏览器"]').count())>0,'local mode explains itself without a browser profile');console.log('LOCALMODE ok');
  assert((await page.evaluate(()=>[...document.querySelectorAll('.pm-login-workbench select')].filter(s=>!s.getAttribute('aria-label')).length))===0,'local mode hides the browser profile selector');
  await navigate('platform-agents?section=catalog');await page.locator('.pm-image-toggle').first().click();await page.locator('.pm-image-reference input').waitFor();
  const aligned=await page.locator('.pm-image-reference').filter({has:page.locator('input')}).evaluate(el=>{const input=el.querySelector('input').getBoundingClientRect(),content=el.querySelector('div').getBoundingClientRect();return input.right<=content.left+2&&Math.abs(input.top-content.top)<8;});assert(aligned,'image selection must align with the reference');
  const size=await page.locator('.pm-image-size').first().evaluate(el=>getComputedStyle(el).display);assert.equal(size,'flex');
  const trigger=page.getByRole('button',{name:'镜像 的操作',exact:true}).last();await trigger.scrollIntoViewIfNeeded();await trigger.click();
  const menu=page.getByRole('menu');await menu.waitFor();const bounds=await menu.boundingBox();assert(bounds.y>=0&&bounds.y+bounds.height<=900,'image menu must remain in the viewport');
  await screen('catalog-menu-'+width);await page.locator('h1').click();assert.equal(await page.getByRole('menu').count(),0);
  await exercisePools(width);
  assert.deepEqual(await page.evaluate(()=>window.platformSmoke.unknown),[],'all UI API requests must have an explicit fixture');
 }
 // MCP CRUD, compatibility, pending retry, deselection and creation through production UI.
 await page.goto(origin+'/#/platform-configuration?section=mcps');await page.getByRole('button',{name:'新建 MCP',exact:true}).click();
 await dialog().getByLabel('名称',{exact:true}).fill('stdio-fixture');await dialog().locator('select').first().selectOption('stdio');await dialog().getByLabel('可执行命令',{exact:true}).fill('node');await dialog().getByLabel('环境变量 JSON',{exact:true}).fill('{"TOKEN":"fixture-secret"}');await dialog().getByText('脱敏原生配置预览',{exact:true}).click();await dialog().getByRole('button',{name:'预览原生配置',exact:true}).click();assert(!(await dialog().locator('pre').innerText()).includes('fixture-secret'));await dialog().getByRole('button',{name:'保存 MCP',exact:true}).click();await dialog().waitFor({state:'hidden'});
 const mcpRow=page.locator('tbody tr').filter({hasText:'stdio-fixture'});await mcpAction(mcpRow,'编辑');assert.deepEqual(JSON.parse(await dialog().getByLabel('环境变量 JSON',{exact:true}).inputValue()),{TOKEN:''});await dialog().getByLabel('显示名称',{exact:true}).fill('Edited MCP');await dialog().getByRole('button',{name:'保存 MCP',exact:true}).click();await dialog().waitFor({state:'hidden'});await page.locator('tbody tr').filter({hasText:'Edited MCP'}).waitFor();
 await page.getByRole('button',{name:'导入 JSON',exact:true}).click();await dialog().getByLabel('MCP JSON',{exact:true}).fill('{"mcpServers":{"imported":{"command":"node","args":["fixture.js"]}}}');await dialog().getByRole('button',{name:'预览配置',exact:true}).click();await dialog().getByRole('button',{name:'确认导入 1 项',exact:true}).click();await dialog().waitFor({state:'hidden'});
 const importedRow=page.locator('tbody tr').filter({has:page.getByText('imported',{exact:true})});page.once('dialog',d=>d.accept());await mcpAction(importedRow,'删除');await importedRow.waitFor({state:'hidden'});
 // API Key is private while Header templates remain editable and public.
 await page.getByRole('button',{name:'新建 MCP',exact:true}).click();await dialog().getByLabel('名称',{exact:true}).fill('header-fixture');await dialog().getByLabel('服务 URL',{exact:true}).fill('https://fixture.invalid/mcp');
 assert.equal(await dialog().getByLabel('认证方式',{exact:true}).locator('option[value=bearer]').count(),0);
 assert.equal(await dialog().locator('p.hint').count(),0);const specificHelp=dialog().locator('.pm-help[data-tip*="Header JSON 使用"]');await specificHelp.hover();await page.locator('.icon-tip').waitFor({state:'visible'});assert((await page.locator('.icon-tip').innerText()).includes('${MCP_API_KEY}'));
 await dialog().getByLabel('MCP API Key',{exact:true}).fill('private-header-fixture');await dialog().getByLabel('HTTP Headers JSON',{exact:true}).fill('{"Authorization":"Bearer ${MCP_API_KEY}","X-API-Key":"${MCP_API_KEY}"}');await dialog().getByRole('button',{name:'保存 MCP',exact:true}).click();await dialog().waitFor({state:'hidden'});
 const headerRow=()=>page.locator('tbody tr').filter({hasText:'header-fixture'});
 await mcpAction(headerRow(),'编辑');assert.deepEqual(JSON.parse(await dialog().getByLabel('HTTP Headers JSON',{exact:true}).inputValue()),{Authorization:'Bearer ${MCP_API_KEY}','X-API-Key':'${MCP_API_KEY}'});assert.equal(await dialog().getByLabel('MCP API Key',{exact:true}).inputValue(),'');
 await dialog().getByRole('button',{name:'保存 MCP',exact:true}).click();await dialog().waitFor({state:'hidden'});
 let headerWrite=await page.evaluate(()=>window.platformSmoke.requests.filter(r=>r.method==='PUT'&&r.path.startsWith('/mcp-servers/')).at(-1));assert.equal(headerWrite.body.configuration.headers.Authorization,'Bearer ${MCP_API_KEY}');assert.equal(headerWrite.body.configuration.apiKey,'');
 await mcpAction(headerRow(),'编辑');await dialog().getByLabel('HTTP Headers JSON',{exact:true}).fill('{"Authorization":"Token ${MCP_API_KEY}"}');await dialog().getByLabel('MCP API Key',{exact:true}).fill('replacement-header-fixture');await dialog().getByRole('button',{name:'保存 MCP',exact:true}).click();await dialog().waitFor({state:'hidden'});
 await mcpAction(headerRow(),'编辑');assert.equal(JSON.parse(await dialog().getByLabel('HTTP Headers JSON',{exact:true}).inputValue()).Authorization,'Token ${MCP_API_KEY}');await dialog().locator('summary').filter({hasText:'显式清空已保存的密钥'}).click();await dialog().getByLabel('apiKey',{exact:true}).check();await dialog().getByRole('button',{name:'保存 MCP',exact:true}).click();await dialog().getByRole('alert').waitFor();
 await dialog().getByLabel('HTTP Headers JSON',{exact:true}).fill('{}');await dialog().getByRole('button',{name:'保存 MCP',exact:true}).click();await dialog().waitFor({state:'hidden'});
 await mcpAction(headerRow(),'编辑');assert.equal(await dialog().getByLabel('MCP API Key',{exact:true}).inputValue(),'');await dialog().getByRole('button',{name:'取消',exact:true}).click();await dialog().waitFor({state:'hidden'});
 for(const [section,menuName,target] of [['local','Dev Agent 运行环境 的操作','control'],['instances','Dev acceptance 的操作','fixture-dev'],['instances','Worker acceptance 的操作','fixture-worker']]){
  console.log('Configuration target '+target);await navigate('platform-agents?section='+section);await page.getByRole('button',{name:menuName,exact:true}).click();await page.getByRole('menuitem',{name:'修改配置',exact:true}).click();await dialog().getByLabel('配置 Agent',{exact:true}).waitFor();
  const docs=dialog().getByLabel(/Shared docs/),events=dialog().getByLabel(/Claude events/);assert.equal(await docs.isChecked(),false);
  if(target==='fixture-worker')assert.equal(await events.isDisabled(),true);else{assert((await dialog().getByText('应用到 Claude Code',{exact:true}).count())===1);await events.check();}
  await docs.check();await page.evaluate(()=>{window.platformSmoke.failNextMcp=true;});await dialog().getByRole('button',{name:'保存并同步',exact:true}).click();await dialog().getByRole('alert').waitFor();const first=await page.evaluate(t=>window.platformSmoke.requests.filter(r=>r.path==='/mcp-targets/'+t&&r.method==='POST').at(-1),target);await closeDialog();
  await page.getByRole('button',{name:menuName,exact:true}).click();await page.getByRole('menuitem',{name:'修改配置',exact:true}).click();await dialog().getByText(/上次 MCP 同步未确认/).waitFor();assert.equal(await docs.isDisabled(),true);await dialog().getByRole('button',{name:'保存并同步',exact:true}).click();await dialog().waitFor({state:'hidden'});await page.getByRole('button',{name:menuName,exact:true}).click();await page.getByRole('menuitem',{name:'修改配置',exact:true}).click();await dialog().getByLabel('配置 Agent',{exact:true}).waitFor();const second=await page.evaluate(t=>window.platformSmoke.requests.filter(r=>r.path==='/mcp-targets/'+t&&r.method==='POST').at(-1),target);assert.equal(first.body.requestId,second.body.requestId);
  assert.equal(await dialog().getByText('同步状态',{exact:true}).count(),0);await dialog().getByLabel(/Shared docs/).uncheck();if(target!=='fixture-worker')await dialog().getByLabel(/Claude events/).uncheck();await dialog().getByRole('button',{name:'保存并同步',exact:true}).click();await dialog().waitFor({state:'hidden'});assert.deepEqual((await page.evaluate(t=>window.platformSmoke.requests.filter(r=>r.path==='/mcp-targets/'+t&&r.method==='POST').at(-1),target)).body.serverIds,[]);
 }
 await navigate('platform-agents?section=instances');await page.getByRole('button',{name:'创建 Agent',exact:true}).click();await dialog().locator('input[name=displayName]').fill('MCP creator');await dialog().locator('select[name=image]').selectOption('sha256:'+'1'.repeat(64));await dialog().locator('select[name=modelSelection]').selectOption(JSON.stringify(['fixture','fixture-one']));await dialog().getByLabel(/Shared docs/).check();await dialog().getByRole('button',{name:'创建 Agent',exact:true}).click();await dialog().waitFor({state:'hidden'});assert.equal((await page.evaluate(()=>window.platformSmoke.requests.filter(r=>r.path==='/containers'&&r.method==='POST').at(-1))).body.mcpServerIds.length,1);
 await navigate('platform-agents?section=pool');await poolAction('新建池成员');await dialog().getByLabel('名称',{exact:true}).fill('MCP pool worker');await dialog().getByLabel('身份 / 能力描述',{exact:true}).fill('Read docs');await dialog().getByLabel(/Shared docs/).check();await save().click();await dialog().waitFor({state:'hidden'});assert.equal((await poolWrites()).at(-1).body.mcpServerIds.length,1);
 await poolRow('MCP pool worker').locator('button[aria-haspopup=menu]').click();assert.equal(await page.getByRole('menuitem',{name:'MCP 管理',exact:true}).count(),0);await page.keyboard.press('Escape');assert.deepEqual(await page.evaluate(()=>window.platformSmoke.unknown),[]);
 await page.goto(origin+'/?mounts=1#/platform-configuration?section=workspaces');await page.locator('h3').filter({hasText:'命名全局只读挂载'}).waitFor();
 assert.equal(await page.locator('input[aria-label=挂载名]').count(),0);await page.getByRole('button',{name:'新增挂载',exact:true}).click();await dialog().getByLabel('挂载名',{exact:true}).fill('repos');await screen('create-named-mount');await page.getByLabel('宿主路径',{exact:true}).fill('/fixture-repos');await dialog().getByRole('button',{name:'保存挂载',exact:true}).click();await dialog().waitFor({state:'hidden'});await page.getByText('/host/repos',{exact:true}).waitFor();
 assert.equal(await page.getByText('Control 工作区与只读挂载',{exact:true}).count(),0);assert.equal(await page.locator('input[name=globalReadOnlyHostPath]').count(),0);
 await page.goto(origin+'/?mounts=1#/platform-agents?section=pool');await poolAction('新建池成员');
 const poolDialog=page.locator('dialog');await poolDialog.getByLabel('名称',{exact:true}).fill('Named mount reader');await poolDialog.getByLabel('身份 / 能力描述',{exact:true}).fill('Read repositories');await poolDialog.getByLabel('repos · /host/repos',{exact:true}).check();await poolDialog.getByRole('button',{name:'保存并继续',exact:true}).click();
 await page.getByText('Named mount reader',{exact:true}).waitFor();const chosen=await page.evaluate(()=>window.platformSmoke.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/members')).at(-1));assert.equal(chosen.body.hostMountIds.length,1);assert.equal(chosen.body.mountGlobalReadOnly,false);
 await page.goto(origin+'/?mounts=1#/platform-configuration?section=credentials');await page.getByRole('heading').filter({hasText:'CLI 凭证'}).waitFor();assert.equal(await page.getByText('Control 飞书报告发布身份',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'保存发布配置',exact:true}).count(),0);
 const long='LongFixture-'+('x'.repeat(500));
 await page.evaluate(t=>{const state=window.platformSmoke;state.data['/mcp-servers'].servers[0].configuration.description=t;state.data['/mcp-servers'].servers[0].configuration.url='https://fixture.invalid/'+t;state.data['/models'].models[0].displayName=t;state.data['/models'].models[0].provider=t;state.data['/credentials'].credentials[0].displayName=t;state.data['/credentials'].credentials[0].endpoint=t;state.data['/proxies'].proxies[0].displayName=t;state.data['/proxies'].proxies[0].configuration.url='http://fixture.invalid/'+t;},long);
 for(const width of [1440,1000]){await page.setViewportSize({width,height:900});for(const section of ['mcps','models','credentials','proxies']){console.log('Long text layout '+section+' '+width);await page.evaluate(s=>{window.platformSmoke.clearCache();location.hash='#/platform-configuration?section='+s;},section);await page.locator('.pm-management-panel').waitFor();const text=page.locator('.pm-ellipsis').filter({hasText:long}).first();await text.waitFor();assert.equal(await text.getAttribute('title'),section==='mcps'?'docs · '+long:long);assert(await text.evaluate(e=>e.scrollWidth>e.clientWidth),'long '+section+' text should be truncated');await page.mouse.move(1,1);await text.hover();const tip=page.locator('.icon-tip');await tip.waitFor({state:'visible'});assert((await tip.innerText()).includes(long));assert(await page.locator('.pm-management-panel').evaluate(e=>e.scrollWidth<=e.clientWidth+2),section+' must not overflow its panel');}}
 for(const width of [1440,1000,700]){await page.setViewportSize({width,height:900});for(const [route,section] of [['platform-configuration','models'],['platform-configuration','mcps'],['platform-configuration','proxies'],['platform-configuration','credentials'],['platform-agents','instances'],['platform-agents','pool'],['platform-agents','catalog'],['platform-agents','local'],['platform-agents','bots'],['platform-agents','logins'],['platform-configuration','workspaces']]){
  await page.evaluate(v=>{location.hash='#/'+v[0]+'?section='+v[1];},[route,section]);await page.locator('.pm-management-panel').waitFor();await page.waitForTimeout(100);
  const helpLayout=await page.locator('h1 .pm-help,h2 .pm-help,h3 .pm-help').evaluateAll(icons=>icons.map(i=>{const h=i.closest('h1,h2,h3'),a=i.getBoundingClientRect(),b=h.getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2);}));assert(helpLayout.every(d=>d<=4),section+' title help should be centered');
  const cells=await page.locator('.pm-table-wrap > table > tbody > tr > td:last-child').evaluateAll(cells=>cells.filter(c=>c.querySelector('button')).map(c=>{const r=c.getBoundingClientRect();return {fits:c.scrollWidth<=c.clientWidth+1,buttons:[...c.querySelectorAll('button')].map(b=>{const q=b.getBoundingClientRect();return q.left>=r.left-1&&q.right<=r.right+1;})};}));assert(cells.every(c=>c.fits&&c.buttons.every(Boolean)),section+' '+width+' action cells must not clip');
  const trigger=page.locator('.pm-table-wrap button[aria-haspopup=menu]').first();if(await trigger.count()){await trigger.scrollIntoViewIfNeeded();await page.waitForTimeout(100);await trigger.click();await page.getByRole('menu').waitFor();const r=await page.getByRole('menu').boundingBox();assert(r.x>=0&&r.x+r.width<=width&&r.y>=0&&r.y+r.height<=900,section+' menu must fit viewport');await page.keyboard.press('Escape');}
 }}
 // Unlike loopback, private-network HTTP is an insecure browser context.
 // Fulfill only our source fixture here: no requests touch a real deployment.
 const httpPage=await browser.newPage(),httpOrigin='http://platform-http-smoke.invalid';
 httpPage.on('pageerror',error=>errors.push(error.message));
 await httpPage.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==httpOrigin){await route.abort();return;}
  const response=await route.fetch({url:origin+url.pathname+url.search});await route.fulfill({response});
 });
 await httpPage.goto(httpOrigin+'/#/platform-agents?section=local');
 assert.deepEqual(await httpPage.evaluate(()=>({secure:window.isSecureContext,uuid:typeof crypto.randomUUID,bytes:typeof crypto.getRandomValues})),{secure:false,uuid:'undefined',bytes:'function'});
 for(const [section,menuName,target] of [['local','Dev Agent 运行环境 的操作','control'],['instances','Dev acceptance 的操作','fixture-dev'],['instances','Worker acceptance 的操作','fixture-worker']]){
  await httpPage.evaluate(s=>{window.platformSmoke.clearCache();location.hash='#/platform-agents?section='+s;},section);
  await httpPage.getByRole('button',{name:menuName,exact:true}).click();await httpPage.getByRole('menuitem',{name:'修改配置',exact:true}).click();
  const httpDialog=httpPage.locator('dialog');await httpDialog.getByLabel('配置 Agent',{exact:true}).waitFor();
  await httpDialog.getByLabel(/Shared docs/).check();await httpPage.evaluate(()=>{window.platformSmoke.failNextMcp=true;});
  await httpDialog.getByRole('button',{name:'保存并同步',exact:true}).click();await httpDialog.getByRole('alert').waitFor();
  const first=await httpPage.evaluate(t=>window.platformSmoke.requests.filter(r=>r.path==='/mcp-targets/'+t&&r.method==='POST').at(-1),target);
  assert.match(first.body.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await httpDialog.getByRole('button',{name:'保存并同步',exact:true}).click();await httpDialog.waitFor({state:'hidden'});
  const second=await httpPage.evaluate(t=>window.platformSmoke.requests.filter(r=>r.path==='/mcp-targets/'+t&&r.method==='POST').at(-1),target);
  assert.equal(first.body.requestId,second.body.requestId,'HTTP retry keeps its idempotency key');
  await httpPage.locator('.pm-management-heading').waitFor();
 }
 assert.deepEqual(await httpPage.evaluate(()=>window.platformSmoke.unknown),[]);await httpPage.close();
 assert.deepEqual(await page.evaluate(()=>window.platformSmoke.unknown),[]);assert.deepEqual(errors,[]);console.log('Platform UI smoke passed: review title-help alignment, consolidated configuration and CLI selection, member menus, mount dialog, MCP catalog/import/masked preview, Control/Dev/Worker scopes, pending retries/deselection and Agent/pool creation; existing 1440/1000 layouts, pool/login, mounts and report regressions; insecure HTTP configuration dialogs and stable retry keys.');
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
