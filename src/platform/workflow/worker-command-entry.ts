import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {executeWorkerCommand} from './worker-command.js';
import {validateWorkerCommand,type WorkerCommand} from './worker-protocol.js';

export type WorkerCommandEntryFailure={
  schema:'botmux-worker-result-v1';
  status:'fail';
  closed:true;
  productError:'worker_command_input_read_failed'|'invalid_worker_command_json'|'invalid_worker_command'|'worker_command_initialization_failed';
};

const closedFailure=(productError:WorkerCommandEntryFailure['productError']):WorkerCommandEntryFailure=>({
  schema:'botmux-worker-result-v1',status:'fail',closed:true,productError,
});

export type WorkerCommandEntryOptions={
  signal:AbortSignal;
  onSession:(value:unknown)=>void;
  home?:string;
  execute?:typeof executeWorkerCommand;
};

/** Fail closed only while no CLI, PTY or ephemeral session may have started. */
export async function executeWorkerCommandInput(raw:string,options:WorkerCommandEntryOptions):Promise<unknown>{
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{return closedFailure('invalid_worker_command_json');}
  let command:WorkerCommand;
  try{command=validateWorkerCommand(parsed as WorkerCommand);}catch{return closedFailure('invalid_worker_command');}
  let executionMayHaveStarted=false;
  try{
    return await (options.execute??executeWorkerCommand)(command,options.signal,options.onSession,options.home??homedir(),{
      onExecutionMayStart:()=>{executionMayHaveStarted=true;},
    });
  }catch(error){
    if(executionMayHaveStarted)throw error;
    return closedFailure('worker_command_initialization_failed');
  }
}

export async function runWorkerCommandStdio(options:Omit<WorkerCommandEntryOptions,'signal'|'onSession'>&{
  signal?:AbortSignal;
  onSession?:(value:unknown)=>void;
  readInput?:()=>string;
  writeOutput?:(value:string)=>void;
}={}):Promise<void>{
  const writeOutput=options.writeOutput??(value=>console.log(value));
  let raw:string;
  try{raw=(options.readInput??(()=>readFileSync(0,'utf8')))();}
  catch{writeOutput(JSON.stringify(closedFailure('worker_command_input_read_failed')));return;}
  const result=await executeWorkerCommandInput(raw,{
    signal:options.signal??new AbortController().signal,
    onSession:options.onSession??(()=>{}),
    ...(options.home?{home:options.home}:{}),
    ...(options.execute?{execute:options.execute}:{}),
  });
  writeOutput(JSON.stringify(result));
}
