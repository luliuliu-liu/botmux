import {describe, it, expect} from 'vitest';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildArchitectGoal, runArchitect} from '../src/workflows/v3/architect.js';
import {readAndValidateManifest} from '../src/workflows/v3/manifest.js';
import {spawnTsEval} from './helpers/ts-runner.js';
import type {RunNode} from '../src/workflows/v3/contract.js';

// 执行真正下发的协议示例，不读取src文本或钉提示文案。
function recipeFromGoal(goal: string): string {
  const match = /node --input-type=module -e '([\s\S]*?)' -- ok/.exec(goal);
  if (!match) throw Error('Architect protocol has no executable metadata recipe');
  return match[1]!;
}
function execute(recipe: string, env: Record<string, string>, args: string[]): Promise<{code: number | null; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawnTsEval(`process.argv = ${JSON.stringify(['node', ...args])};\n${recipe}`, {env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = ''; child.stderr?.on('data', b => { stderr += b.toString(); });
    child.on('error', reject); child.on('close', code => resolve({code, stderr}));
  });
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'native-architect-protocol-'));
  const output = join(root, 'work'); mkdirSync(output);
  const manifest = join(root, 'manifest.json');
  const env = {BOTMUX_GOAL_OUTPUT_DIR: output, BOTMUX_GOAL_MANIFEST_PATH: manifest};
  const dag = '{"schemaVersion":2,"runId":"test","nodes":[]}\n';
  const notes = '# 编排说明\n保留父级访问范围，仅池目录可写。\n';
  writeFileSync(join(output, 'dag.json'), dag); writeFileSync(join(output, 'architect-notes.md'), notes);
  return {root, output, manifest, env, dag, notes};
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

describe('原生Architect完整产物协议', () => {
  it('实际执行下发示例，从真实字节生成完整清单，再经严格校验通过', async () => {
    const f = setup();
    try {
      const recipe = recipeFromGoal(buildArchitectGoal('/spec.md', '/spec.json'));
      const result = await execute(recipe, f.env, ['ok', '两份编排产物完成']);
      expect(result.code, result.stderr).toBe(0);
      const manifest = await readAndValidateManifest(f.manifest, f.output);
      expect(manifest.status).toBe('ok'); expect(manifest.summary).toBe('两份编排产物完成');
      expect(manifest.files).toEqual([
        {name: 'dag.json', path: 'dag.json', kind: 'json', mime: 'application/json', bytes: Buffer.byteLength(f.dag), sha256: digest(f.dag)},
        {name: 'architect-notes.md', path: 'architect-notes.md', kind: 'markdown', mime: 'text/markdown', bytes: Buffer.byteLength(f.notes), sha256: digest(f.notes)},
      ]);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
  it('缺显式状态或缺文件均失败且不覆盖旧清单，不推断ok', async () => {
    const f = setup();
    try {
      const recipe = recipeFromGoal(buildArchitectGoal('/spec.md', '/spec.json'));
      writeFileSync(f.manifest, '原失败清单');
      for (const args of [[], ['ok'], ['unknown', 'summary']]) {
        expect((await execute(recipe, f.env, args)).code).not.toBe(0);
        expect(readFileSync(f.manifest, 'utf8')).toBe('原失败清单');
      }
      rmSync(join(f.output, 'architect-notes.md'));
      expect((await execute(recipe, f.env, ['ok', 'summary'])).code).not.toBe(0);
      expect(readFileSync(f.manifest, 'utf8')).toBe('原失败清单');
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
  it('拒绝符号链接产物，不用目录存在冒充完成', async () => {
    const f = setup();
    try {
      rmSync(join(f.output, 'architect-notes.md')); symlinkSync(join(f.output, 'dag.json'), join(f.output, 'architect-notes.md'));
      expect((await execute(recipeFromGoal(buildArchitectGoal('/spec.md', '/spec.json')), f.env, ['ok', 'summary'])).code).not.toBe(0);
      expect(existsSync(f.manifest)).toBe(false);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
  it('明确失败仅产生fail/error，严格验收不会把它当ok', async () => {
    const f = setup();
    try {
      const recipe = recipeFromGoal(buildArchitectGoal('/spec.md', '/spec.json'));
      expect((await execute(recipe, f.env, ['fail', '编排未完成', 'architect_failed', 'missing output'])).code).toBe(0);
      const manifest = await readAndValidateManifest(f.manifest, f.output);
      expect(manifest.status).toBe('fail'); expect(manifest.error?.code).toBe('architect_failed'); expect(manifest.files).toEqual([]);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
  it('真实runArchitect接收完整文件清单，稀疏原失败清单仍被拒绝', async () => {
    const f = setup();
    try {
      const specPath = join(f.root, 'spec.md'), specJsonPath = join(f.root, 'spec.json');
      writeFileSync(specPath, '# spec'); writeFileSync(specJsonPath, '{}');
      const run = async (sparse: boolean) => {
        const runNode: RunNode = async req => {
          writeFileSync(join(req.outputDir, 'dag.json'), f.dag); writeFileSync(join(req.outputDir, 'architect-notes.md'), f.notes);
          const manifestPath = req.env.BOTMUX_GOAL_MANIFEST_PATH!;
          if (sparse) writeFileSync(manifestPath, JSON.stringify({files: [{name: 'dag.json', path: 'dag.json', kind: 'json'}, {name: 'architect-notes.md', path: 'architect-notes.md', kind: 'markdown'}]}));
          else {
            const recipe = recipeFromGoal(req.node.goal);
            const result = await execute(recipe, req.env, ['ok', 'completed']);
            if (result.code !== 0) throw Error(result.stderr);
          }
          return {status: 'ok', manifestPath};
        };
        return runArchitect({runId: 'test', runDir: f.root, specPath, specJsonPath, botSnapshot: {larkAppId: 'cli_test', cliId: 'claude-code', workingDir: f.root}, runNode});
      };
      const bad = await run(true); expect(bad.status).toBe('fail'); expect(bad.dagPath).toBeUndefined();
      expect(bad.problems?.join('\n')).toMatch(/schemaVersion must be 1/);
      expect(bad.problems?.join('\n')).toMatch(/bytes must be/);
      const good = await run(false); expect(good.status).toBe('ok'); expect(good.dagPath).toBe(join(f.root, 'architect/attempts/001/work/dag.json'));
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
});
