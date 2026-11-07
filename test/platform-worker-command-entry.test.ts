import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSyncTsEvalWithRepoImports} from './helpers/ts-runner.js';

const repo=resolve(import.meta.dirname,'..');
const validCommand={schema:'botmux-worker-command-v1',jobId:'11111111-1111-4111-8111-111111111111',runId:'run-a',attemptId:'attempt-a',
  node:{id:'goal-a',type:'goal',goal:'work',depends:[],inputs:[],humanGate:null},goal:'work',inputs:[],timeoutMs:1000};
const entryImport=`import {runWorkerCommandStdio} from './src/platform/workflow/worker-command-entry.js';`;
function runEntry(input:string,body='await runWorkerCommandStdio();',home?:string){
  return spawnSyncTsEvalWithRepoImports(`${entryImport}\n${body}`,{
    cwd:repo,input,encoding:'utf8',env:{...process.env,...(home?{HOME:home}:{})},
  });
}
function outputOf(result:ReturnType<typeof runEntry>){
  expect(result.status).toBe(0);
  return JSON.parse(String(result.stdout).trim());
}

describe('platform worker command stdio entry',()=>{
  it('returns a fixed closed failure when stdin cannot be read',()=>{
    const body=`await runWorkerCommandStdio({readInput:()=>{throw new Error('private-read-detail');}});`;
    expect(outputOf(runEntry('',body))).toEqual({
      schema:'botmux-worker-result-v1',status:'fail',closed:true,productError:'worker_command_input_read_failed',
    });
  });

  it('returns a fixed closed failure for malformed JSON without reflecting input',()=>{
    const secret='private-json-secret';
    const result=outputOf(runEntry(`{"goal":"${secret}"`));
    expect(result).toEqual({schema:'botmux-worker-result-v1',status:'fail',closed:true,productError:'invalid_worker_command_json'});
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('returns a fixed closed failure for protocol validation errors without reflecting input',()=>{
    const secret='private-command-secret';
    const result=outputOf(runEntry(JSON.stringify({...validCommand,secret})));
    expect(result).toEqual({schema:'botmux-worker-result-v1',status:'fail',closed:true,productError:'invalid_worker_command'});
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('returns a fixed closed failure when native configuration initialization fails',()=>{
    const home=mkdtempSync(join(tmpdir(),'worker-entry-home-'));
    try{
      expect(outputOf(runEntry(JSON.stringify(validCommand),undefined,home))).toEqual({
        schema:'botmux-worker-result-v1',status:'fail',closed:true,productError:'worker_command_initialization_failed',
      });
    }finally{rmSync(home,{recursive:true,force:true});}
  });

  it('passes a normal execution result through unchanged',()=>{
    const expected={schema:'botmux-worker-result-v1',status:'ok',closed:true,product:{value:1}};
    const body=`await runWorkerCommandStdio({execute:async()=>(${JSON.stringify(expected)})});`;
    expect(outputOf(runEntry(JSON.stringify(validCommand),body))).toEqual(expected);
  });

  it('does not write a closed result when execution may have started before failure',()=>{
    const body=`await runWorkerCommandStdio({execute:async(command,signal,onSession,home,phase)=>{phase.onExecutionMayStart?.();throw new Error('late_execution_failure');}});`;
    const result=runEntry(JSON.stringify(validCommand),body);
    expect(result.status).not.toBe(0);
    expect(String(result.stdout)).toBe('');
    expect(String(result.stderr)).toContain('late_execution_failure');
    expect(String(result.stderr)).not.toContain('"closed":true');
  });
});
