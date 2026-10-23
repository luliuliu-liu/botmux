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
    expect(settings['llm-pi-ai'].providers.platform).toMatchObject({api:protocol,baseURL:model.baseUrl,apiKeyEnv:'PLATFORM_DSH_API_KEY'});
    expect(settings['llm-pi-ai'].providers.platform.models).toEqual([
      {id:'one',name:'one',reasoning:true,input:['text'],contextWindow:128000,maxTokens:8192},
      {id:'two',name:'two',reasoning:true,input:['text'],contextWindow:128000,maxTokens:8192},
    ]);
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
  it('uses shared Proxy for every Agent and Vercel headers without shared Anthropic credentials',async()=>{
    const f=fixture();mkdirSync(join(f.home,'.botmux','platform'),{recursive:true});
    const proxy=join(f.home,'.botmux','platform','proxy.json');writeFileSync(proxy,JSON.stringify({mode:'global',url:'http://proxy.example:7890',rules:[],defaultAction:'proxy'}));
    expect(nativeModelEnvironment(f.home,'codex',{...f.configuration.model,protocol:'openai-responses'})).toMatchObject({HTTP_PROXY:'http://127.0.0.1:3344'});
    const model={provider:'vercel',baseUrl:'https://ai-gateway.vercel.sh',protocol:'anthropic-messages',authMethod:'oauth',modelId:'',modelIds:[],apiKey:'fixture-vercel'};
    const env=nativeModelEnvironment(f.home,'claude-code',model);
    expect(env).toMatchObject({ANTHROPIC_BASE_URL:'https://ai-gateway.vercel.sh/claude-code',ANTHROPIC_CUSTOM_HEADERS:'x-ai-gateway-api-key: Bearer fixture-vercel',HTTPS_PROXY:'http://127.0.0.1:3344',DISABLE_UPDATES:'1',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:'1'});
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    writeFileSync(proxy,'null');expect(nativeModelEnvironment(f.home,'codex',{...f.configuration.model,protocol:'openai-responses'}).HTTP_PROXY).toBeUndefined();
  });
  it('keeps unmanaged Codex root settings when switching OAuth to an API-key model',async()=>{
    const f=fixture(),oauth={...f.configuration,agentType:'codex' as const,
      model:{provider:'openai',baseUrl:'https://api.openai.com/v1',protocol:'openai-responses',authMethod:'oauth',modelId:'',modelIds:[],apiKey:''}};
    await f.apply(oauth);
    const file=join(f.home,'.codex','config.toml');
    writeFileSync(file,readFileSync(file,'utf8').replace(
      '# botmux-platform-root:end',
      'model_reasoning_effort = "medium"\n# botmux-platform-root:end',
    ));
    const api={...oauth,revision:2,model:{...f.configuration.model,protocol:'openai-responses',authMethod:'api-key'}};
    await f.apply(api);
    const text=readFileSync(file,'utf8');
    expect(text).toContain('model_provider = "platform"');
    expect(text).toContain('model_reasoning_effort = "medium"');
    expect(text).not.toContain('cli_auth_credentials_store = "file"');
  });
  it('accepts a legacy OAuth ownership subset after Codex adds model and reasoning inside the marker',async()=>{
    const f=fixture(),oauth={...f.configuration,agentType:'codex' as const,
      model:{provider:'openai',baseUrl:'https://api.openai.com/v1',protocol:'openai-responses',authMethod:'oauth',modelId:'',modelIds:[],apiKey:''}};
    await f.apply(oauth);
    const file=join(f.home,'.codex','config.toml');
    writeFileSync(file,readFileSync(file,'utf8').replace(
      'cli_auth_credentials_store = "file"',
      'cli_auth_credentials_store = "file"\nmodel = "user-selected"\nmodel_reasoning_effort = "medium"',
    ));
    const api={...oauth,revision:2,model:{...f.configuration.model,protocol:'openai-responses',authMethod:'api-key'}};
    await f.apply(api);
    const text=readFileSync(file,'utf8');expect(text).toContain('model_reasoning_effort = "medium"');
    expect(text).toContain('model_provider = "platform"');expect(text).not.toContain('model = "user-selected"');
  });
  it('switches after native /model persists selections outside and inside the managed root',async()=>{
    const f=fixture(),oauth={...f.configuration,agentType:'codex' as const,
      model:{provider:'openai',baseUrl:'https://api.openai.com/v1',protocol:'openai-responses',authMethod:'oauth',modelId:'',modelIds:[],apiKey:''}};
    await f.apply(oauth);
    const file=join(f.home,'.codex','config.toml');
    writeFileSync(file,readFileSync(file,'utf8')+'model_reasoning_effort = "high"\nmodel = "gpt-native"\n[tui]\nscreen_reader_detection_done = true\n');
    const api={...oauth,revision:2,model:{...f.configuration.model,protocol:'openai-responses',authMethod:'api-key'}};
    await f.apply(api);
    expect(readFileSync(file,'utf8')).not.toContain('gpt-native');
    writeFileSync(file,readFileSync(file,'utf8').replace('model = "one"','model = "native-menu-choice"'));
    await f.apply({...oauth,revision:3});
    const text=readFileSync(file,'utf8');
    expect(text).not.toContain('model =');expect(text).not.toContain('model_provider');
    expect(text).toContain('model_reasoning_effort = "high"');expect(text).toContain('screen_reader_detection_done = true');
    await f.apply({...api,revision:4});
    writeFileSync(file,readFileSync(file,'utf8').replace('https://model.example/v1','https://changed.invalid/v1'));
    await expect(f.apply({...oauth,revision:5})).rejects.toThrow('codex_global_config_conflict');
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
  it('propagates per-model native capabilities to Pi, Codex and DSH',async()=>{
    const capability={modelId:'vision',inputModalities:['text','image'] as Array<'text'|'image'>,contextWindow:256000,maxTokens:32000,
      reasoningLevels:['low','high'] as Array<'low'|'high'>,defaultReasoningLevel:'high' as const,
      supportsReasoningSummaries:true,defaultReasoningSummary:'detailed' as const};
    for(const agentType of ['pi','codex','dsh'] as const){
      const f=fixture(),model={...f.configuration.model,modelId:'vision',modelIds:['vision'],modelCapabilities:[capability],
        protocol:agentType==='codex'?'openai-responses' as const:'openai-completions' as const};
      await f.apply({...f.configuration,agentType,model});
      if(agentType==='pi'){
        expect(JSON.parse(readFileSync(join(f.home,'.pi','agent','models.json'),'utf8')).providers.team.models[0]).toMatchObject({
          id:'vision',input:['text','image'],contextWindow:256000,maxTokens:32000,reasoning:true,
        });
      }else if(agentType==='codex'){
        expect(JSON.parse(readFileSync(join(f.home,'.codex','platform-models.json'),'utf8')).models[0]).toMatchObject({
          slug:'vision',input_modalities:['text','image'],context_window:256000,default_reasoning_level:'high',
          supports_reasoning_effort_updates:true,default_reasoning_summary:'detailed',
        });
        expect(readFileSync(join(f.home,'.codex','config.toml'),'utf8')).toContain('model_supports_reasoning_summaries = true');
      }else{
        const settings=Object.fromEntries(JSON.parse(readFileSync(dshModelPatchPath(f.home),'utf8')).filter((r:any)=>r.id).map((r:any)=>[r.id,r.config]));
        expect(settings['llm-pi-ai'].providers.platform.models[0]).toMatchObject({
          id:'vision',input:['text','image'],contextWindow:256000,maxTokens:32000,reasoning:true,
        });
      }
    }
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
    expect(apiConfig).toContain('model_catalog_json = ');
    const catalog=JSON.parse(readFileSync(join(f.home,'.codex','platform-models.json'),'utf8'));
    expect(catalog.models.map((model:any)=>model.slug)).toEqual(['one']);
    expect(catalog.models[0].supported_reasoning_levels.map((level:any)=>level.effort)).toEqual(['low','medium','high','xhigh']);
    expect(catalog.models[0]).toMatchObject({default_reasoning_level:'medium',supports_reasoning_effort_updates:true});
    expect(f.bots()[0].codexAuthSync).toBe('shared');
    expect(f.bots()[0].env.PLATFORM_MODEL_API_KEY).toBeUndefined();
    expect(readContainerAgentEnvironment(f.home,'codex')?.PLATFORM_MODEL_API_KEY).toBe('model-private');
    await f.apply({...config,revision:2,model:{...config.model,authMethod:'oauth'}});
    expect(f.bots()[0].env).toEqual({});expect(readFileSync(join(f.home,'.codex','auth.json'),'utf8')).toBe('private-oauth');
    const native=readFileSync(join(f.home,'.codex','config.toml'),'utf8');
    expect(native).not.toContain('model_provider = "platform"');expect(native).toContain('cli_auth_credentials_store = "file"');
    expect(native).toContain('[mcp_servers.user]');expect(native).toContain('command = "keep-me"');
    expect(()=>readFileSync(join(f.home,'.codex','platform-models.json'),'utf8')).toThrow();
  });
  it('registers every configured Codex API model in the native catalog',async()=>{
    const f=fixture(),model={...f.configuration.model,protocol:'openai-responses',modelIds:['one','two'],modelId:'two'};
    await f.apply({...f.configuration,agentType:'codex',model});
    const catalog=JSON.parse(readFileSync(join(f.home,'.codex','platform-models.json'),'utf8'));
    expect(catalog.models.map((item:any)=>item.slug)).toEqual(['one','two']);
    expect(readFileSync(join(f.home,'.codex','config.toml'),'utf8')).toContain('model = "two"');
  });
  it('rejects protocol confusion and builds Claude API settings without putting the key in argv',()=>{
    const f=fixture();expect(()=>nativeModelEnvironment(f.home,'codex',f.configuration.model)).toThrow('responses');
    expect(nativeModelEnvironment(f.home,'claude-code',{...f.configuration.model,protocol:'anthropic-messages'})).toEqual({ANTHROPIC_BASE_URL:'https://model.example/v1',ANTHROPIC_API_KEY:'model-private',ANTHROPIC_MODEL:'one',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_UPDATES:'1',DISABLE_AUTOUPDATER:'1'});
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
