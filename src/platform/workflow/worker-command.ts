/** Transport-neutral payload. HTTP today; a future NATS adapter must preserve
 * these IDs, receipts and close-proof semantics, not implement a scheduler. */
import {lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {createEphemeralPool} from '../../workflows/v3/ephemeral-pool.js';
import {GOAL_ENV} from '../../workflows/v3/contract.js';
import {readAndValidateManifest} from '../../workflows/v3/manifest.js';
import {nativeModelEnvironment,type NativeConfiguration} from '../management/native-worker-config.js';
import {readContainerAgentEnvironment} from '../management/container-agent-files.mjs';

import {validateWorkerCommand,sha256,type WorkerCommand} from './worker-protocol.js';
export function claudeHeadlessArgs(config:NativeConfiguration):string[]{
  return ['--print',...(config.model.modelId?['--model',config.model.modelId]:[]),'--dangerously-skip-permissions'];
}
export function hydrateWorkerConfiguration(home:string,stored:NativeConfiguration):NativeConfiguration{
  const global=readContainerAgentEnvironment(home,stored.agentType)??{};
  const apiKey=stored.agentType==='pi'?global.PI_MODEL_API_KEY
    :stored.agentType==='codex'?global.PLATFORM_MODEL_API_KEY
    :stored.agentType==='zcode'?global.ZCODE_CODING_PLAN_API_KEY
    :stored.agentType==='dsh'?global.DEEPSEEK_API_KEY
    :global.ANTHROPIC_API_KEY;
  let appSecret='';
  if(stored.binding){
    const bots=JSON.parse(readFileSync(join(home,'.botmux','bots.json'),'utf8')) as Array<{larkAppId?:string;larkAppSecret?:string}>;
    const bot=Array.isArray(bots)?bots.find(item=>item?.larkAppId===stored.binding?.appId):undefined;
    if(!bot?.larkAppSecret)throw new Error('worker_binding_secret_missing');
    appSecret=bot.larkAppSecret;
  }
  return {...stored,model:{...stored.model,apiKey:apiKey??''},
    binding:stored.binding?{...stored.binding,appSecret}:null};
}
async function runClaudeHeadless(config:NativeConfiguration,goalPath:string,goalEnv:Record<string,string>,home:string,signal:AbortSignal,timeoutMs:number){
  if(signal.aborted)return{status:'cancelled' as const,stdout:'',stderr:''};
  const env={...process.env,...goalEnv,...nativeModelEnvironment(home,config.agentType,config.model),
    HOME:home,DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',OTEL_SDK_DISABLED:'true'};
  const prompt=`Read ${goalPath}. Read the input list at $${GOAL_ENV.INPUTS_PATH}. Write all products under $${GOAL_ENV.OUTPUT_DIR} and the required manifest at $${GOAL_ENV.MANIFEST_PATH}. Complete the task, then stop.`;
  const args=claudeHeadlessArgs(config);
  const child=spawn('claude',args,
    {cwd:'/workspace',env,detached:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',cancelled=false;
  const bounded=(value:string,chunk:unknown)=>(value+String(chunk)).slice(-32768);
  child.stdout.on('data',chunk=>stdout=bounded(stdout,chunk));
  child.stderr.on('data',chunk=>stderr=bounded(stderr,chunk));
  child.stdin.on('error',()=>{});
  child.stdin.end(prompt);
  let hard:ReturnType<typeof setTimeout>|undefined;
  const killGroup=()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}};
  const stop=()=>{
    cancelled=true;try{process.kill(-child.pid!,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}
    hard??=setTimeout(killGroup,5000);
  };
  signal.addEventListener('abort',stop,{once:true});
  const timeout=setTimeout(stop,timeoutMs);
  try{
    const code=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done);});
    // The leader closing does not prove its background descendants stopped.
    killGroup();
    return{status:cancelled?'cancelled' as const:code===0?'ok' as const:'fail' as const,stdout,stderr};
  }finally{clearTimeout(timeout);clearTimeout(hard);signal.removeEventListener('abort',stop);}
}
export async function executeWorkerCommand(command:WorkerCommand,signal:AbortSignal,onSession:(value:unknown)=>void,home=homedir()){
  validateWorkerCommand(command);
  const config=hydrateWorkerConfiguration(home,JSON.parse(readFileSync(join(home,'agent/native-runtime.json'),'utf8')) as NativeConfiguration);
  const dir=join(home,'agent/jobs',command.jobId,'attempt'),work=join(dir,'work');mkdirSync(work,{recursive:true,mode:0o700});
  if(lstatSync(dir).isSymbolicLink()||lstatSync(work).isSymbolicLink())throw new Error('unsafe_worker_job_directory');
  const inputs=command.inputs.map((item,index)=>{const path=join(dir,`input-${index}`);writeFileSync(path,Buffer.from(item.data,'base64'),{flag:'wx',mode:0o600});const{data,sha256,...metadata}=item;return{...metadata,path};});
  const goal=join(dir,'goal.txt'),inputsPath=join(dir,'inputs.json'),manifest=join(dir,'manifest.json');
  writeFileSync(goal,command.goal,{flag:'wx',mode:0o600});writeFileSync(inputsPath,JSON.stringify({inputs,omitted:command.omitted||[]}),{flag:'wx',mode:0o600});
  const env={
    [GOAL_ENV.GOAL_PATH]:goal,[GOAL_ENV.INPUTS_PATH]:inputsPath,[GOAL_ENV.OUTPUT_DIR]:work,[GOAL_ENV.MANIFEST_PATH]:manifest,[GOAL_ENV.ATTEMPT_DIR]:dir,[GOAL_ENV.V3_MARKER]:'1',
    BOTMUX_WORKFLOW:'1',BOTMUX_WORKFLOW_RUN_ID:command.runId,BOTMUX_WORKFLOW_NODE_ID:command.node.id,
    // Ephemeral workers share the container's native Agent configuration, but
    // their Botmux session/task metadata stays scoped to this data root.
    SESSION_DATA_DIR:join(home,'.botmux','data'),
  };
  const headless=config.agentType==='claude-code'
    ?await runClaudeHeadless(config,goal,env,home,signal,command.timeoutMs)
    :undefined;
  const result=headless??await createEphemeralPool({resolveLarkAppSecret:()=>config.binding?.appSecret||'workflow-only-no-im-identity'}).runNode({
      runId:command.runId,attemptId:command.attemptId,node:command.node,
      botSnapshot:{larkAppId:config.binding?.appId||'platform-workflow',cliId:config.agentType,workingDir:'/workspace',model:config.agentType==='pi'?`${config.model.provider}/${config.model.modelId}`:config.model.modelId,
        ...(config.agentType==='codex'?{codexAuthSync:'shared' as const}:{})},
      runDir:join(home,'agent/jobs',command.jobId),attemptDir:dir,inputsPath,outputDir:work,env,
      workerEnv:nativeModelEnvironment(home,config.agentType,config.model),timeoutMs:command.timeoutMs,cancelSignal:signal,
      onSessionReady:info=>onSession({sessionId:info.sessionId,webPort:info.webPort,viewToken:info.viewToken}),
    });
  let product,productError;
  try{
    const parsed=await readAndValidateManifest(manifest,work);let bytes=0;
    const files=parsed.files.map(file=>{
      const path=resolve(work,file.path),rel=relative(work,path);
      if(!rel||isAbsolute(rel)||rel.startsWith('..')||file.kind==='directory'||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw new Error('unsupported_remote_artifact');
      let parent=work;for(const part of rel.split(sep).slice(0,-1)){parent=join(parent,part);if(lstatSync(parent).isSymbolicLink())throw Error('unsupported_remote_artifact');}
      const buffer=readFileSync(path);bytes+=buffer.length;if(bytes>4*1024*1024)throw new Error('remote_artifacts_too_large');
      return{path:file.path,data:buffer.toString('base64'),sha256:sha256(buffer)};
    });
    product={manifest:parsed,files};
  }catch(error){productError=error instanceof Error?`${error.name}: ${error.message}`.slice(0,2048):'manifest_collection_failed';}
  let ask;
  try{const path=join(dir,'ask.json'),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error();ask=JSON.parse(readFileSync(path,'utf8'));}catch{}
  const log=(name:string)=>{try{return readFileSync(join(dir,name),'utf8').slice(-32768);}catch{return '';}};
  return{schema:'botmux-worker-result-v1',status:result.status,closed:true,...product,...(productError?{productError}:{}),...(ask?{ask}:{}),
    stdout:headless?.stdout??log('stdout.log'),stderr:headless?.stderr??log('stderr.log')};
}
