import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {synchronizePiNativeConfiguration as sync,piNativeConfigurationDigest as digest} from '../src/platform/management/pi-native-config.mjs';
const homes:string[]=[];
afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
function fixture(){
  const home=mkdtempSync(join(tmpdir(),'pi-native-'));homes.push(home);
  const agent=join(home,'.pi','agent');mkdirSync(agent,{recursive:true});
  const read=(name:string)=>JSON.parse(readFileSync(join(agent,name+'.json'),'utf8'));
  const write=(name:string,value:unknown)=>writeFileSync(join(agent,name+'.json'),JSON.stringify(value),{mode:0o600});
  const model={provider:'team',baseUrl:'https://example.invalid/v1',modelId:'two',modelIds:['one','two'],apiKey:'!literal$key',protocol:'openai-completions'};
  return {home,agent,read,write,model};
}
describe('Pi native authentication and defaults',()=>{
  it('merges native credentials/defaults and keeps unrelated OAuth, providers and preferences',async()=>{
    const f=fixture(),oauth={type:'oauth',refresh:'keep-refresh',access:'keep-access',expires:100};
    f.write('auth',{other:oauth});f.write('models',{providers:{other:{baseUrl:'https://other.invalid'}}});
    f.write('settings',{theme:'dark',lastChangelogVersion:'0.85.1',defaultModel:'old',nested:{keep:true}});
    await sync(f.home,f.model);
    expect(f.read('auth')).toEqual({other:oauth,team:{type:'api_key',key:'$PI_MODEL_API_KEY'}});
    expect(f.read('settings')).toMatchObject({theme:'dark',nested:{keep:true},defaultProvider:'team',defaultModel:'two'});
    expect(f.read('models').providers.other).toEqual({baseUrl:'https://other.invalid'});
    expect(f.read('models').providers.team.models.map((m:any)=>m.id)).toEqual(['one','two']);
    for(const name of ['auth','models','settings'])expect(statSync(join(f.agent,name+'.json')).mode&0o777).toBe(0o600);
    expect(readFileSync(join(f.home,'.botmux/platform/pi-native-owner.json'),'utf8')).not.toContain('!literal$key');
  });
  it('rotates keys and selected model; unrelated changes do not trigger managed drift',async()=>{
    const f=fixture();await sync(f.home,f.model);const original=digest(f.home,f.model);
    f.write('settings',{...f.read('settings'),theme:'changed'});
    f.write('auth',{...f.read('auth'),other:{type:'oauth',access:'refreshed'}});
    expect(digest(f.home,f.model)).toBe(original);
    expect((await sync(f.home,f.model,{allowWrite:false})).changed).toBe(false);
    f.write('settings',{...f.read('settings'),defaultModel:'manual'});
    expect(digest(f.home,f.model)).not.toBe(original);
    await expect(sync(f.home,f.model,{allowWrite:false})).rejects.toThrow('busy');
    await sync(f.home,{...f.model,apiKey:'rotated',modelId:'one'});
    expect(f.read('auth').team).toEqual({type:'api_key',key:'$PI_MODEL_API_KEY'});expect(f.read('settings').defaultModel).toBe('one');
  });
  it('retires only unchanged platform-owned entries on provider changes',async()=>{
    const f=fixture();await sync(f.home,f.model);await sync(f.home,{...f.model,provider:'second'});
    expect(f.read('auth').team).toBeUndefined();expect(f.read('models').providers.team).toBeUndefined();
    const changed={type:'oauth',access:'user-login'};f.write('auth',{...f.read('auth'),second:changed});
    await sync(f.home,{...f.model,provider:'third'});expect(f.read('auth').second).toEqual(changed);
  });
  it('fails closed on malformed files, symlinks or an active native lock without overwriting',async()=>{
    const f=fixture();f.write('auth',{other:{type:'oauth',access:'keep'}});
    writeFileSync(join(f.agent,'settings.json'),'not json');
    await expect(sync(f.home,f.model)).rejects.toThrow('invalid_pi_native_json');expect(f.read('auth').team).toBeUndefined();
    rmSync(join(f.agent,'settings.json'));symlinkSync(join(f.agent,'auth.json'),join(f.agent,'settings.json'));
    await expect(sync(f.home,f.model)).rejects.toThrow('unsafe_pi_native_file');expect(f.read('auth').team).toBeUndefined();
    rmSync(join(f.agent,'settings.json'));mkdirSync(join(f.agent,'auth.json.lock'));
    await expect(sync(f.home,f.model,{lockTimeoutMs:10})).rejects.toThrow('pi_native_lock_busy');
    expect(statSync(join(f.agent,'auth.json.lock')).isDirectory()).toBe(true);expect(f.read('auth').team).toBeUndefined();
  });
});
