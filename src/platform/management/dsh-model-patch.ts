/** Platform-owned overlay, separate from native user profiles and settings migrations. */
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
export const dshModelPatchPath=(home:string)=>join(home,'.dsh','platform-model.patch.json');
export function readDshPlatformModel(home:string):{provider:string;model:string}|null{
  const file=dshModelPatchPath(home);if(!existsSync(file))return null;
  const rows=JSON.parse(readFileSync(file,'utf8'));
  if(!Array.isArray(rows))throw Error('invalid_dsh_platform_patch');
  const value=rows.find(row=>row.id==='agent-default-model')?.config;
  if(typeof value?.provider!=='string'||!value.provider||typeof value?.model!=='string'||!value.model)throw Error('invalid_dsh_platform_model');
  return {provider:value.provider,model:value.model};
}
