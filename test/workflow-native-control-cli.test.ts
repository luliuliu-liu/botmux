import {describe, it, expect} from 'vitest';
import {createServer} from 'node:http';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnTsEvalWithRepoImports} from './helpers/ts-runner.js';
import {managedWorkspaceBinding} from './helpers/workflow-managed-workspace.js';
import {builtinSkillContent} from '../src/skills/injection-mode.js';

function child(source: string, env: Record<string, string>) {
  return new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
    const p = spawnTsEvalWithRepoImports(source, {env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = ''; p.stdout?.on('data', b => {stdout += b.toString();}); p.stderr?.on('data', b => {stderr += b.toString();});
    p.on('error', reject); p.on('close', code => resolve({code, stdout, stderr}));
  });
}
// 真实Dev镜像的角色文件参与Control判定；此验证lane在Linux测试容器运行。
describe.runIf(process.platform === 'linux' && existsSync('/etc/botmux-platform-role'))('原生Control CLI保留父子工作区', () => {
  it('执行Skill给出的显式选池协议，通过真实同步子进程HTTP冻结权威绑定', async () => {
    const home = mkdtempSync(join(tmpdir(), 'native-control-cli-'));
    const binding = managedWorkspaceBinding(), paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!); res.setHeader('content-type', 'application/json');
      if (req.url === `/internal/v1/workflow-storage/agent-pools/${binding.poolId}/workspace`) { res.end(JSON.stringify(binding)); return; }
      res.writeHead(404); res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw Error('missing listener');
      const platform = join(home, '.botmux/platform'); mkdirSync(platform, {recursive: true});
      writeFileSync(join(platform, 'control-runtime.json'), JSON.stringify({role: 'control', workspaceKind: 'hostpath', workspaceClaim: '/data/agents'}));
      writeFileSync(join(platform, 'workflow-storage.json'), JSON.stringify({baseUrl: `http://127.0.0.1:${address.port}`, token: 'synthetic-test-token', expiresAt: Date.now() + 60000}));
      // 消费实际Skill中的原生CLI示例，不读取src文本或假定仅UI能选择池。
      const old = process.env.BOTMUX_WORKFLOW_ENABLED; process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
      let skill: string | undefined;
      try {skill = builtinSkillContent('botmux-workflow');} finally {if (old === undefined) delete process.env.BOTMUX_WORKFLOW_ENABLED; else process.env.BOTMUX_WORKFLOW_ENABLED = old;}
      const command = skill?.match(/botmux workflow new "<目标>" --pool <poolId>/)?.[0];
      if (!command) throw Error('native Control CLI invocation missing from Skill');
      const args = ['parent-child validation', '--pool', binding.poolId];
      const result = await child(`import {cmdWorkflowHost} from './src/workflows/v3/host.js'; await cmdWorkflowHost('new', ${JSON.stringify(args)}, {resolveChatBinding: () => undefined});`, {HOME: home, BOTMUX_AGENT_ROLE: 'control', BOTMUX_WORKFLOW_ENABLED: 'true'});
      expect(result.code, result.stderr).toBe(0);
      const created = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
      expect(created.status).toBe('grilling');
      const frozen = JSON.parse(readFileSync(join(created.runDir, 'workspace.selection.json'), 'utf8'));
      expect(frozen).toEqual(binding); expect(frozen.controlRoot.claim).toBe('/data/agents'); expect(frozen.claim).toBe('/data/agents/project-a');
      expect(paths).toEqual([`/internal/v1/workflow-storage/agent-pools/${binding.poolId}/workspace`]);
      expect(existsSync(join(created.runDir, 'run.json'))).toBe(false);
      const missing = await child(`import {cmdWorkflowHost} from './src/workflows/v3/host.js'; await cmdWorkflowHost('new', ['missing pool'], {resolveChatBinding: () => undefined});`, {HOME: home, BOTMUX_AGENT_ROLE: 'control', BOTMUX_WORKFLOW_ENABLED: 'true'});
      expect(missing.code).not.toBe(0);
      expect(readdirSync(join(home, '.botmux/v3-runs'))).toEqual([created.runId]);
    } finally {await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, {recursive: true, force: true});}
  }, 20000);
});
