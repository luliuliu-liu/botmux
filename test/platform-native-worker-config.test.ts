import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeWorkerConfigurator,nativeModelEnvironment,type NativeConfiguration} from '../src/platform/management/native-worker-config.js';
import {readContainerAgentEnvironment} from '../src/platform/management/container-agent-files.mjs';
import {dshModelPatchPath,readDshPlatformModel} from '../src/platform/management/dsh-model-patch.js';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){
  const home=mkdtempSync(join(tmpdir(),'native-worker-'));dirs.push(home);mkdirSync(join(home,'.botmux'),{mode:0o700});
  writeFileSync(join(home,'.botmux','bots.json'),'[]',{mode:0o600});
  const state={busy:false,failStart:false,rows:[] as Array<{appId:string;alive:boolean;status:string}>,stops:[] as string[]};
  const apply=createNativeWorkerConfigurator({home,busy:async()=>state.busy,fleet:()=>({supervisorAlive:true,rows:state.rows}),
    stop:async appId=>{state.stops.push(appId);state.rows=state.rows.filter(row=>row.appId!==appId);return {ok:true};},
    start:async appId=>{if(state.failStart)return {ok:false};state.rows.push({appId,alive:true,status:'online'});return {ok:true};}});
  const configuration:NativeConfiguration={generation:'runtime-1',revision:1,agentType:'pi',model:{provider:'team',baseUrl:'https://model.example/v1',modelId:'one',apiKey:'model-private'},
    binding:{appId:'cli_first',generation:'binding-1',appSecret:'bot-private',displayName:'first',brand:'feishu',owner:{allowedUsers:['owner@example.com']}}};
  const bots=()=>JSON.parse(readFileSync(join(home,'.botmux','bots.json'),'utf8'));
  return {home,state,apply,configuration,bots};
}
describe('native worker authority',()=>{
  it('ZCode key connection rejects static models and arbitrary providers/endpoints',()=>{
    const model={provider:'zai',baseUrl:'https://api.z.ai',protocol:'zcode-coding-plan',authMethod:'api-key',apiKey:'fixture-key',modelId:'',modelIds:[]};
    expect(nativeModelEnvironment('/state','zcode',model)).toEqual({ZCODE_CODING_PLAN_API_KEY:'fixture-key'});
    for(const change of [{provider:'other'},{baseUrl:'https://evil.invalid'},{authMethod:'oauth'},{modelId:'fixed'},{modelIds:['fixed']},{apiKey:''}]){
      expect(()=>nativeModelEnvironment('/state','zcode',{...model,...change})).toThrow();
    }
  });
  it('dsh uses global native settings, API key env and keeps unrelated user settings',async()=>{
    const f=fixture();mkdirSync(join(f.home,'.dsh'));
    writeFileSync(join(f.home,'.dsh','settings.yaml'),'user-setting: keep\n');
    const config={...f.configuration,agentType:'dsh' as const,model:{...f.configuration.model,protocol:'anthropic-messages',baseUrl:'https://api.deepseek.com/anthropic'}};
    await f.apply(config);
    expect(readFileSync(join(f.home,'.dsh','settings.yaml'),'utf8')).toBe('user-setting: keep\n');
    const settings=Object.fromEntries(JSON.parse(readFileSync(dshModelPatchPath(f.home),'utf8')).filter((r:any)=>r.id).map((r:any)=>[r.id,r.config]));
    expect(settings['agent-default-model']).toEqual({provider:'deepseek-official',model:'one'});
    expect(settings['llm-deepseek'].baseURL).toBe(config.model.baseUrl);
    expect(f.bots()[0].env).toEqual({});
    expect(readContainerAgentEnvironment(f.home,'dsh')?.DEEPSEEK_API_KEY).toBe('model-private');
    await f.apply({...config,revision:2,binding:null});
    expect(f.bots()).toEqual([]);
    expect(readContainerAgentEnvironment(f.home,'dsh')?.DEEPSEEK_API_KEY).toBe('model-private');
  });
  it.each(['openai-completions','openai-responses','anthropic-messages'])('dsh registers custom API key models through the native %s plugin',async protocol=>{
    const f=fixture();mkdirSync(join(f.home,'.dsh'));
    writeFileSync(join(f.home,'.dsh','settings.yaml'),JSON.stringify({'llm-pi-ai':{providers:{custom:{api:'openai-completions'}}},'user-setting':'keep'}));
    const model={...f.configuration.model,protocol,modelIds:['one','two'],modelId:'two'};
    await f.apply({...f.configuration,agentType:'dsh',model});
    const original=JSON.parse(readFileSync(join(f.home,'.dsh','settings.yaml'),'utf8'));
    const settings=Object.fromEntries(JSON.parse(readFileSync(dshModelPatchPath(f.home),'utf8')).filter((r:any)=>r.id).map((r:any)=>[r.id,r.config]));
    expect(settings['agent-default-model']).toMatchObject({provider:'platform',model:'two'});
    expect(settings['llm-pi-ai'].providers.platform).toEqual({api:protocol,baseURL:model.baseUrl,apiKeyEnv:'PLATFORM_DSH_API_KEY',models:[{id:'one'},{id:'two'}]});
    expect(original['llm-pi-ai'].providers.custom).toBeDefined();expect(original['user-setting']).toBe('keep');
    expect(JSON.stringify(settings)).not.toContain('model-private');
    const patch=JSON.parse(readFileSync(dshModelPatchPath(f.home),'utf8'));
    expect(patch.find((row:any)=>row.id==='llm-pi-ai').config.providers.platform.api).toBe(protocol);
    expect(readDshPlatformModel(f.home)).toEqual({provider:'platform',model:'two'});
    expect(()=>nativeModelEnvironment(f.home,'dsh',{...model,authMethod:'oauth'})).toThrow();
  });
  it.each(['codex','claude-code'] as const)('supports %s OAuth native default without model pins or shared API credentials',async agentType=>{
    const f=fixture(),config={...f.configuration,agentType,model:{provider:agentType==='codex'?'openai':'anthropic',baseUrl:agentType==='codex'?'https://api.openai.com/v1':'https://api.anthropic.com',protocol:agentType==='codex'?'openai-responses':'anthropic-messages',authMethod:'oauth',modelId:'',modelIds:[],apiKey:''}};
    await f.apply(config);expect(f.bots()[0].model).toBeUndefined();expect(f.bots()[0].env).toEqual({});
    if(agentType==='codex'){
      const file=join(f.home,'.codex','config.toml');
      expect(readFileSync(file,'utf8')).not.toContain('model =');
      await f.apply({...config,revision:2,model:{...config.model,modelId:'chosen',modelIds:['chosen']}});
      expect(readFileSync(file,'utf8')).toContain('model = "chosen"');
      await f.apply({...config,revision:3});expect(readFileSync(file,'utf8')).not.toContain('model =');
    }
    expect(()=>nativeModelEnvironment(f.home,'pi',config.model)).toThrow();
  });
  it('registers all Pi models but keeps an explicit selected model in the bot and environment',async()=>{
    const f=fixture();await f.apply({...f.configuration,model:{...f.configuration.model,modelIds:['one','two'],modelId:'two'}});
    const registry=JSON.parse(readFileSync(join(f.home,'.pi','agent','models.json'),'utf8'));
    expect(registry.providers.team.models.map((m:any)=>m.id)).toEqual(['one','two']);
    expect(f.bots()[0]).toMatchObject({env:{}});
    expect(f.bots()[0].model).toBeUndefined();
    expect(readContainerAgentEnvironment(f.home,'pi')?.PI_MODEL_ID).toBe('two');
    expect(JSON.stringify(registry)).not.toContain('model-private');
    expect(JSON.parse(readFileSync(join(f.home,'.pi','agent','settings.json'),'utf8'))).toMatchObject({defaultProvider:'team',defaultModel:'two'});
    expect(JSON.parse(readFileSync(join(f.home,'.pi','agent','auth.json'),'utf8')).team).toEqual({type:'api_key',key:'$PI_MODEL_API_KEY'});
    expect(()=>nativeModelEnvironment(f.home,'pi',{...f.configuration.model,modelIds:['other']})).toThrow('invalid_models');
  });
  it('binds native Botmux and removes the credential only after stopping the exact bot',async()=>{
    const f=fixture();const ack=await f.apply(f.configuration);
    expect(ack.binding).toEqual({appId:'cli_first',generation:'binding-1'});expect(JSON.stringify(ack)).not.toContain('private');
    expect(f.bots()[0]).toMatchObject({cliId:'pi',larkAppSecret:'bot-private',env:{}});
    expect(readContainerAgentEnvironment(f.home,'pi')?.PI_MODEL_API_KEY).toBe('model-private');
    expect(f.bots()[0].model).toBeUndefined();
    await f.apply({...f.configuration,revision:2,binding:null});expect(f.state.stops).toEqual(['cli_first']);expect(f.bots()).toEqual([]);
    await expect(f.apply(f.configuration)).rejects.toThrow('stale');
  });
  it('retains a retryable configuration intent if native start fails halfway through replacement',async()=>{
    const f=fixture();await f.apply(f.configuration);f.state.failStart=true;
    const next={...f.configuration,revision:2,binding:{...f.configuration.binding!,appId:'cli_second',generation:'binding-2'}};
    await expect(f.apply(next)).rejects.toThrow('start_unconfirmed');
    f.state.failStart=false;expect((await f.apply(next)).binding?.appId).toBe('cli_second');
    expect(f.bots()).toHaveLength(1);expect(f.state.rows.filter(row=>row.alive).map(row=>row.appId)).toEqual(['cli_second']);
  });
  it('does not overwrite unmanaged local bots, busy work or a conflicting generation',async()=>{
    const f=fixture();f.state.busy=true;await expect(f.apply(f.configuration)).rejects.toThrow('busy');expect(f.bots()).toEqual([]);
    f.state.busy=false;await f.apply(f.configuration);
    await expect(f.apply({...f.configuration,generation:'another'})).rejects.toThrow('stale');
    writeFileSync(join(f.home,'.botmux','bots.json'),JSON.stringify([{larkAppId:'cli_unknown',larkAppSecret:'keep'}]));
    await expect(f.apply({...f.configuration,revision:2})).rejects.toThrow('unmanaged');expect(f.bots()[0].larkAppSecret).toBe('keep');
  });
  it('uses the container-global Codex home and never overwrites OAuth login files',async()=>{
    const f=fixture();mkdirSync(join(f.home,'.codex'));writeFileSync(join(f.home,'.codex','auth.json'),'private-oauth');
    writeFileSync(join(f.home,'.codex','config.toml'),'approval_policy = "never"\n[mcp_servers.user]\ncommand = "keep-me"\n',{mode:0o600});
    const config={...f.configuration,agentType:'codex' as const,model:{...f.configuration.model,protocol:'openai-responses'}};
    await f.apply(config);
    const apiConfig=readFileSync(join(f.home,'.codex','config.toml'),'utf8');
    expect(apiConfig).toContain('wire_api = "responses"');expect(apiConfig).toContain('[mcp_servers.user]');expect(apiConfig).toContain('command = "keep-me"');
    expect(f.bots()[0].codexAuthSync).toBe('shared');
    expect(f.bots()[0].env.PLATFORM_MODEL_API_KEY).toBeUndefined();
    expect(readContainerAgentEnvironment(f.home,'codex')?.PLATFORM_MODEL_API_KEY).toBe('model-private');
    await f.apply({...config,revision:2,model:{...config.model,authMethod:'oauth'}});
    expect(f.bots()[0].env).toEqual({});expect(readFileSync(join(f.home,'.codex','auth.json'),'utf8')).toBe('private-oauth');
    const native=readFileSync(join(f.home,'.codex','config.toml'),'utf8');
    expect(native).not.toContain('model_provider = "platform"');expect(native).toContain('cli_auth_credentials_store = "file"');
    expect(native).toContain('[mcp_servers.user]');expect(native).toContain('command = "keep-me"');
  });
  it('rejects protocol confusion and builds Claude API settings without putting the key in argv',()=>{
    const f=fixture();expect(()=>nativeModelEnvironment(f.home,'codex',f.configuration.model)).toThrow('responses');
    expect(nativeModelEnvironment(f.home,'claude-code',{...f.configuration.model,protocol:'anthropic-messages'})).toEqual({ANTHROPIC_BASE_URL:'https://model.example/v1',ANTHROPIC_API_KEY:'model-private',ANTHROPIC_MODEL:'one',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'});
  });
  it('acknowledges a verified retry without restarting or interrupting a busy agent',async()=>{
    const f=fixture();const ack=await f.apply(f.configuration);f.state.busy=true;
    expect(await f.apply(f.configuration)).toEqual(ack);expect(f.state.stops).toEqual([]);
    await expect(f.apply({...f.configuration,revision:2})).rejects.toThrow('busy');
    const roster=f.bots();roster[0].env.PI_MODEL_ID='manual-change';
    writeFileSync(join(f.home,'.botmux','bots.json'),JSON.stringify(roster));
    await expect(f.apply(f.configuration)).rejects.toThrow('busy');
    expect(f.bots()[0].env.PI_MODEL_ID).toBe('manual-change');
    f.state.busy=false;await f.apply(f.configuration);expect(f.bots()[0].env.PI_MODEL_ID).toBeUndefined();
    expect(readContainerAgentEnvironment(f.home,'pi')?.PI_MODEL_ID).toBe('one');
  });
  it('preserves native user settings and custom env during model synchronization',async()=>{
    const f=fixture();await f.apply(f.configuration);
    const bots=f.bots();bots[0].env.PROJECT_MODE='keep';bots[0].replyStyle='text';
    writeFileSync(join(f.home,'.botmux','bots.json'),JSON.stringify(bots));
    f.state.busy=true;await f.apply(f.configuration);expect(f.state.stops).toEqual([]);
    f.state.busy=false;await f.apply({...f.configuration,revision:2,model:{...f.configuration.model,modelId:'two'}});
    expect(f.bots()[0]).toMatchObject({replyStyle:'text',env:{PROJECT_MODE:'keep'}});
    expect(f.bots()[0].model).toBeUndefined();
    expect(readContainerAgentEnvironment(f.home,'pi')?.PI_MODEL_ID).toBe('two');
  });
  it.each(['pi','codex','claude-code'] as const)('keeps %s global settings and credentials across Bot replacement and detachment',async agentType=>{
    const f=fixture();const model=agentType==='pi'?f.configuration.model:{...f.configuration.model,protocol:agentType==='codex'?'openai-responses':'anthropic-messages'};
    const config={...f.configuration,agentType,model};await f.apply(config);
    const initial=readContainerAgentEnvironment(f.home,agentType);
    if(agentType==='codex')writeFileSync(join(f.home,'.codex','auth.json'),'keep-native-auth',{mode:0o600});
    await f.apply({...config,revision:2,binding:{...config.binding!,appId:'cli_replacement',generation:'binding-2'}});
    expect(readContainerAgentEnvironment(f.home,agentType)).toEqual(initial);
    await f.apply({...config,revision:3,binding:null});expect(f.bots()).toEqual([]);
    expect(readContainerAgentEnvironment(f.home,agentType)).toEqual(initial);
    if(agentType==='codex')expect(readFileSync(join(f.home,'.codex','auth.json'),'utf8')).toBe('keep-native-auth');
    await f.apply({...config,revision:4,binding:{...config.binding!,appId:'cli_rebound',generation:'binding-4'}});
    expect(readContainerAgentEnvironment(f.home,agentType)).toEqual(initial);expect(f.bots()[0].larkAppId).toBe('cli_rebound');
  });
});
