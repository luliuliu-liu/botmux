import type {RawParamInput} from '../shared/params.js';

/** 参数类型随草稿持久化，避免CLI的JSON值在恢复启动时变成字符串。 */
export function templateRawParams(params:Record<string,string>,jsonParamNames:string[]=[]):Record<string,RawParamInput> {
 if(!Array.isArray(jsonParamNames)||jsonParamNames.length>128
   ||jsonParamNames.some(name=>typeof name!=='string'||!Object.hasOwn(params,name))
   ||new Set(jsonParamNames).size!==jsonParamNames.length)throw Error('invalid_template_json_params');
 const jsonNames=new Set(jsonParamNames);
 const raw=Object.create(null) as Record<string,RawParamInput>;
 for(const [name,value] of Object.entries(params)){
  if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)||['__proto__','prototype','constructor'].includes(name)
    ||typeof value!=='string'||value.length>16000)throw Error('invalid_template_params');
  raw[name]=jsonNames.has(name)?{kind:'json',value:JSON.parse(value)}:{kind:'string',value};
 }
 return raw;
}
