/** 平台 Worker/Dev 当前维护的 CLI；不影响 Botmux 独立安装的适配器。 */
export const PLATFORM_CLI_IDS = ['pi','codex','claude-code','zcode'] as const;
export function isPlatformCli(value:unknown):boolean{return PLATFORM_CLI_IDS.some(id=>id===value);}
