import {describe, expect, it} from 'vitest';
import {templateRawParams} from '../src/workflows/v3/template-run-params.js';
import {cmdSavedWorkflow} from '../src/cli/saved-workflow.js';

// 原桥接源码退役后，验证真正CLI入口拒绝旧能力；不保留死模块的假调用测试。
describe('托管模板草稿桥退役', () => {
  it.each([['--resume-draft', 'r1'], ['--resume-draft=r1']].map(args => ({args})))('在主体/文件读取前拒绝旧恢复参数 $args', async ({args}) => {
    await expect(cmdSavedWorkflow('run', args)).rejects.toThrow(/--resume-draft.*移除/);
  });
  it.each([['template', '--pool', 'p1'], ['template', '--pool=p1']].map(args => ({args})))('在主体/新目录创建前拒绝未支持的池模板参数 $args', async ({args}) => {
    await expect(cmdSavedWorkflow('run', args)).rejects.toThrow(/直接启动尚未支持/);
  });
});

describe('仍使用的原生模板参数协议', () => {
  it('JSON参数类型可持久化恢复，并拒绝缺项、重复标记和非法参数', () => {
    const params = {filters: '{"region":"cn"}', text: '{"literal":true}'};
    expect(templateRawParams(JSON.parse(JSON.stringify(params)), ['filters'])).toEqual({filters: {kind: 'json', value: {region: 'cn'}}, text: {kind: 'string', value: '{"literal":true}'}});
    for (const names of [['missing'], ['filters', 'filters']]) expect(() => templateRawParams(params, names)).toThrow();
    expect(() => templateRawParams({constructor: 'x'})).toThrow();
  });
});
