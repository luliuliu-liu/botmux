export type RequiredInputPath={mountName:string;path:string;kind:'file'|'directory'};
export function validateRequiredPaths(value:unknown):RequiredInputPath[]{
 if(value===undefined)return [];if(!Array.isArray(value)||value.length>32)throw Error('invalid_input_paths');
 return value.map(v=>{if(!v||typeof v.mountName!=='string'||!/^([a-z0-9][a-z0-9-]{0,63}|workspace)$/.test(v.mountName)||typeof v.path!=='string'||v.path.length>1024||/^(?:\/|\\|[A-Za-z]:)/.test(v.path)||v.path.includes('\0')||v.path.split(/[\\/]/).includes('..')||!['file','directory'].includes(v.kind)||Object.keys(v).some(k=>!['mountName','path','kind'].includes(k)))throw Error('invalid_input_path');return {mountName:v.mountName,path:v.path,kind:v.kind};});
}
