/** Platform ZCode integration. The native TUI owns model selection and login. */
import {resolveCommand} from '../../adapters/cli/registry.js';
import type {CliAdapter,PtyHandle} from '../../adapters/cli/types.js';
import {delay} from '../../utils/timing.js';
import {BOTMUX_SHELL_HINTS} from '../../adapters/cli/shared-hints.js';
export function createZcodeAdapter(pathOverride?:string):CliAdapter{
  let binary:string|undefined;
  return {
    id:'zcode',
    get resolvedBin(){return binary??=resolveCommand(pathOverride??'zcode');},
    authPaths:['~/.zcode'],
    // ZCode allocates its own native session identifier; Botmux's UUID is not
    // a valid --resume id. Persistent tmux retains live sessions across reloads.
    buildArgs(){return ['tui'];},
    async writeInput(pty:PtyHandle,content:string){
      if(pty.sendText&&pty.sendSpecialKeys){
        pty.sendText('\x1b[200~'+content+'\x1b[201~');await delay(200);pty.sendSpecialKeys('Enter');
      }else{pty.write('\x1b[200~'+content+'\x1b[201~');await delay(200);pty.write('\r');}
    },
    altScreen:true,
    systemHints:[...BOTMUX_SHELL_HINTS],
    defaultPassthroughCommands:['/model','/login','/logout','/help','/clear'],
  };
}
