import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureJournalBackend} from '../src/workflows/v3/journal-backend.js';
import {projectRun,projectRunAsync} from '../src/workflows/v3/ops-projection.js';
import type {StoredEvent} from '../src/workflows/v3/event-contract.js';

const directories:string[]=[];
afterEach(()=>{configureJournalBackend(undefined);for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'projection-no-mirror-'));directories.push(base);
 const runDir=join(base,'remote-run');mkdirSync(runDir);
 writeFileSync(join(runDir,'dag.json'),JSON.stringify({schemaVersion:2,runId:'remote-run',nodes:[{id:'work',type:'goal',goal:'work',depends:[],inputs:[]}]}));
 const events:StoredEvent[]=[{type:'runStarted',runId:'remote-run',ts:1},{type:'runSucceeded',ts:2}];
 return {runDir,events};
}
it('projects committed remote events even when the local mirror is absent',()=>{
 const {runDir,events}=fixture();
 configureJournalBackend(()=>({read:()=>events,withMutationSync:()=>{throw Error('read-only projection');}}));
 expect(existsSync(join(runDir,'journal.ndjson'))).toBe(false);
 expect(projectRun('remote-run',runDir,{now:()=>123})).toMatchObject({runStatus:'succeeded',generatedAt:123});
});
it('async projection reads the remote backend without a synchronous pre-probe',async()=>{
 const {runDir,events}=fixture();
 configureJournalBackend(()=>({read:()=>{throw Error('synchronous remote read forbidden');},readAsync:async()=>events,withMutationSync:()=>{throw Error('read-only projection');}}));
 expect(await projectRunAsync('remote-run',runDir,{now:()=>456})).toMatchObject({runStatus:'succeeded',generatedAt:456});
});
