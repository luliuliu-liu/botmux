import {resolvedMcpHeaders,type McpConfig,type McpCli} from './mcp-schema.js';
export function nativeMcpValue(config:McpConfig,cli:McpCli){const option=config.options[cli]??{},local=config.transport==='stdio',headers={...resolvedMcpHeaders(config),...(config.auth.type==='bearer'?{Authorization:'Bearer '+config.auth.token}:{})};
 const base:any=local?{command:config.command,args:config.args??[],...(Object.keys(config.env).length?{env:config.env}:{}),...(config.cwd?{cwd:config.cwd}:{})}:{url:config.url,...(Object.keys(headers).length?{headers}:{})};
 if(cli==='codex'||cli==='traex'){if(base.headers){base.http_headers=base.headers;delete base.headers;}if(option.timeoutSec)base.tool_timeout_sec=option.timeoutSec;if(option.startupTimeoutSec)base.startup_timeout_sec=option.startupTimeoutSec;return base;}
 base.type=config.transport;if(cli==='pi'){base.description=config.description;if(option.timeoutSec)base.timeout=option.timeoutSec;if(option.exposure)base.exposure=option.exposure;}
 if(cli==='zcode'){if(option.timeoutSec)base.timeoutMs=Number(option.timeoutSec)*1000;if(option.alwaysLoad!==undefined)base.alwaysLoad=option.alwaysLoad;}
 if(config.auth.type==='oauth'&&['pi','claude-code','zcode'].includes(cli))base.oauth={...(cli==='zcode'?{type:'authorization_code'}:{}),...(config.auth.clientId?{clientId:config.auth.clientId}:{}),...(config.auth.clientSecret?{clientSecret:config.auth.clientSecret}:{}),...(config.auth.callbackPort?{callbackPort:config.auth.callbackPort}:{})};
 if(cli==='dsh'){delete base.type;return {id:'platform-mcp-'+config.name,name:'@deepseek-ai/dsh-mcp-client',config:{serverName:config.name,transport:local?'stdio':'streamable-http',...base,...(option.timeoutSec?{toolCallTimeoutMs:Number(option.timeoutSec)*1000}:{}),...(option.failOnStartupError!==undefined?{failOnStartupError:option.failOnStartupError}:{})}};}
 return base;
}
