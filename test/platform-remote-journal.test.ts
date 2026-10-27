import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureJournalBackend} from '../src/workflows/v3/journal-backend.js';
import {appendEvent,appendEventDurable,readJournal,journalExists,withJournalMutationSync} from '../src/workflows/v3/journal.js';
import {createPlatformJournalResolver} from '../src/platform/workflow/remote-journal.js';
import {PersistenceRequestError,type PersistenceRequest} from '../src/platform/workflow/sync-request.js';
import type {StoredEvent} from '../src/workflows/v3/event-contract.js';

const folders:string[]=[];
afterEach(()=>{configureJournalBackend(undefined);for(const path of folders.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(){
  const home=mkdtempSync(join(tmpdir(),'remote-journal-'));folders.push(home);
  const platform=join(home,'.botmux','platform'),directory=join(home,'.botmux','v3-runs','test'),path=join(directory,'journal.ndjson');
  mkdirSync(platform,{recursive:true});mkdirSync(directory,{recursive:true});
  writeFileSync(join(platform,'workflow-storage.json'),JSON.stringify({baseUrl:'http://control-plane:8787',token:'registry-private',expiresAt:1e12}));
  writeFileSync(join(directory,'dag.json'),JSON.stringify({runId:'test',nodes:[]}));
  writeFileSync(join(directory,'bots.snapshot.json'),'{}');writeFileSync(join(directory,'grill.state.json'),'{}');
  const state={events:[] as StoredEvent[],fence:0,holder:null as string|null,unavailable:false,loseAppend:false,loseRegister:false,revoked:false,registration:null as any,calls:[] as PersistenceRequest[]};
  const receipts=new Map<string,any>();
  const request=(input:PersistenceRequest)=>{
    state.calls.push(structuredClone(input));if(state.unavailable)throw new PersistenceRequestError(0,'storage_unreachable');
    const data=input.body as any;
    if(input.path==='/runs'){
      expect(input.token).toBe('registry-private');
      if(state.registration)expect(data).toEqual(state.registration);else state.registration=structuredClone(data);
      if(state.loseRegister){state.loseRegister=false;throw new PersistenceRequestError(0,'storage_unreachable');}
      return {version:state.events.length,token:'run-private',expiresAt:1e12};
    }
    if(input.path.endsWith('/session')){expect(input.token).toBe('registry-private');state.revoked=false;return {token:'run-fresh',expiresAt:1e12};}
    if(state.revoked)throw new PersistenceRequestError(401,'workflow_identity_required');
    if(input.path.endsWith('/acquire')){
      if(state.holder)throw new PersistenceRequestError(409,'journal_busy');
      state.holder=data.holder;return {holder:state.holder,fence:++state.fence,version:state.events.length,events:structuredClone(state.events)};
    }
    if(input.path.endsWith('/release')){state.holder=null;return {ok:true};}
    if(input.path.endsWith('/append')){
      if(receipts.has(data.operationId))return structuredClone(receipts.get(data.operationId));
      expect(data.holder).toBe(state.holder);expect(data.fence).toBe(state.fence);expect(data.version).toBe(state.events.length);
      const event={...data.events[0],ts:1000+state.events.length};state.events.push(event);
      const result={version:state.events.length,events:[event]};receipts.set(data.operationId,structuredClone(result));
      if(state.loseAppend){state.loseAppend=false;throw new PersistenceRequestError(0,'storage_unreachable');}
      return result;
    }
    return {version:state.events.length,events:structuredClone(state.events)};
  };
  const install=()=>configureJournalBackend(createPlatformJournalResolver({home,active:true,request,now:()=>1000,readCacheMs:0}));install();
  return {home,platform,directory,path,state,install};
}
it('routes the original native journal through API commits and preserves lazy mutation semantics',()=>{
  const f=fixture();expect(readJournal(f.path)).toEqual([]);expect(f.state.registration).not.toBeNull();
  appendEventDurable(f.path,{type:'runStarted',runId:'test'});
  withJournalMutationSync(f.path,mutation=>{expect(mutation.events).toHaveLength(1);mutation.append({type:'runSucceeded'});expect(mutation.events).toHaveLength(1);});
  expect(readJournal(f.path)).toEqual(f.state.events);expect(journalExists(f.path)).toBe(true);
  expect(readFileSync(f.path,'utf8')).not.toContain('private');expect(JSON.stringify(f.state.registration)).not.toContain('private');
  expect(statSync(join(f.directory,'journal.api.json')).mode&0o777).toBe(0o600);
  expect(()=>withJournalMutationSync(f.path,m=>{m.append({type:'runSucceeded'});return m.events;})).toThrow('before the first append');
});
it('retries the exact lost acknowledgement without replaying the native callback',()=>{
  const f=fixture();f.state.loseAppend=true;let calls=0;
  withJournalMutationSync(f.path,m=>{calls++;m.append({type:'runStarted',runId:'test'});});
  expect(calls).toBe(1);expect(f.state.events).toHaveLength(1);
  const attempts=f.state.calls.filter(call=>call.path.endsWith('/append'));expect(attempts).toHaveLength(2);expect(attempts[0]!.body).toEqual(attempts[1]!.body);
});
it('does not fall back to a local mirror when persistence is unavailable or credentials are lost',()=>{
  const f=fixture();appendEvent(f.path,{type:'runStarted',runId:'test'});const before=readFileSync(f.path,'utf8');
  f.state.unavailable=true;expect(()=>appendEvent(f.path,{type:'runSucceeded'})).toThrow('storage_unreachable');expect(readFileSync(f.path,'utf8')).toBe(before);
  f.state.unavailable=false;rmSync(join(f.directory,'journal.api.json'));rmSync(join(f.directory,'journal.api.pending.json'));
  expect(()=>appendEvent(f.path,{type:'runSucceeded'})).toThrow('descriptor_missing');expect(f.state.events).toHaveLength(1);
});
it('recovers a lost registration response without changing an immutable approval snapshot',()=>{
  const f=fixture();f.state.loseRegister=true;
  expect(()=>readJournal(f.path)).toThrow('storage_unreachable');expect(existsSync(f.path)).toBe(false);
  writeFileSync(join(f.directory,'grill.state.json'),JSON.stringify({status:'changed-after-timeout'}));
  expect(readJournal(f.path)).toEqual([]);expect(f.state.registration.authorizationSnapshot.artifacts['grill.state.json']).toBe('{}');
});
it('renews only the run-scoped capability after a key rotation and survives a missing mirror',()=>{
  const f=fixture();appendEvent(f.path,{type:'runStarted',runId:'test'});f.state.revoked=true;
  expect(readJournal(f.path)).toHaveLength(1);expect(f.state.calls.some(call=>call.path.endsWith('/session'))).toBe(true);
  rmSync(f.path);f.install();expect(journalExists(f.path)).toBe(true);expect(readJournal(f.path)).toEqual(f.state.events);
});
it('rejects file-only histories in managed mode',()=>{
  const f=fixture(),line=JSON.stringify({type:'runStarted',runId:'test',ts:1});writeFileSync(f.path,line+'\n');
  expect(()=>readJournal(f.path)).toThrow('descriptor_missing');
  expect(()=>readJournal(join(f.home,'outside','journal.ndjson'))).toThrow('path_not_allowed');
});
