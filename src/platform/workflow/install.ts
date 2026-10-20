/** Only native Control images opt into managed persistence. Regular upstream
 * installations and Worker images keep their original file implementation. */
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {configureJournalBackend} from '../../workflows/v3/journal-backend.js';
import {createPlatformJournalResolver} from './remote-journal.js';
import {configureExecutionBackend} from '../../workflows/v3/execution-backend.js';
import {createRemoteExecutionBackend} from './remote-executor.js';
import {join,basename,resolve} from 'node:path';
let control=false;try{control=readFileSync('/etc/botmux-platform-role','utf8').trim()==='control';}catch{}
if(control){
  configureJournalBackend(createPlatformJournalResolver({home:homedir(),active:true}));
  configureExecutionBackend(runDir=>{
    const home=homedir();
    // Selection precedes runStarted registration. Credentials are resolved
    // lazily at acquire, after the original runtime freezes its run artifacts
    // and commits runStarted through the journal backend.
    if(resolve(runDir)!==join(home,'.botmux/v3-runs',basename(runDir)))throw Error('managed_execution_identity_unavailable');
    return createRemoteExecutionBackend({home,runDir});
  });
}
