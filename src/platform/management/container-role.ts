import {readFileSync} from 'node:fs';
/** Dev capability can serve either role. Worker-only images stay immutable. */
export function containerRole(path='/etc/botmux-platform-role'):'control'|'worker'|undefined{
 try{const image=readFileSync(path,'utf8').trim();if(image==='dev')return process.env.BOTMUX_AGENT_ROLE==='control'?'control':'worker';return image==='control'||image==='worker'?image:undefined;}catch{return undefined;}
}
