import {randomUUID} from 'node:crypto';
import {closeSync,constants,fchmodSync,fstatSync,fsyncSync,linkSync,openSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {WorkerCommand} from './worker-protocol.js';
import type {NativeConfiguration} from '../management/native-worker-config.js';

/** Diagnostic data only. Never persist goals, inputs, environment or secrets. */
export function prepareJobMetadata(context:{work:string;shared:string;tools:string;home:string},command:WorkerCommand,config:NativeConfiguration){
 const attempt=command.attemptId.match(/^(.*)\/attempts\/(\d{3,})$/);
 const attemptDir=join(context.home,'agent/jobs',command.jobId,'attempt');
 const metadata={schema:'botmux-job-context-v1',runId:command.runId,jobId:command.jobId,nodeId:command.node.id,
  attemptId:command.attemptId,instanceId:attempt?.[1]??null,attemptNumber:attempt?Number(attempt[2]):null,
  agentType:config.agentType,modelId:config.model.modelId,runtimeGeneration:config.generation,
  workDir:context.work,sharedDir:context.shared,toolsDir:context.tools,
  state:{attemptDir,goalPath:join(attemptDir,'goal.txt'),inputsPath:join(attemptDir,'inputs.json'),outputDir:join(attemptDir,'work'),
   manifestPath:join(attemptDir,'manifest.json'),ptyLogPath:join(attemptDir,'pty.log')}};
 const path=join(context.work,'job.json'),temporary=join(context.work,'.job-'+randomUUID()+'.tmp');
 const verifyExisting=()=>{
  const fd=openSync(path,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW));
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>16384||JSON.stringify(JSON.parse(readFileSync(fd,'utf8')))!==JSON.stringify(metadata))throw Error('job_metadata_conflict');
   fchmodSync(fd,0o444);
  }finally{closeSync(fd);}
 };
 let fd:number|undefined;
 try{
  fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o400);
  writeFileSync(fd,JSON.stringify(metadata,null,2)+'\n');fchmodSync(fd,0o444);fsyncSync(fd);closeSync(fd);fd=undefined;
  try{linkSync(temporary,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;verifyExisting();}
 }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 return path;
}
