import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as botRegistry from '../src/bot-registry.js';
import { cmdWorkflow } from '../src/cli/workflow.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { parseV3SavedWorkflowCommand } from '../src/im/lark/v3-saved-workflow-command.js';
import {
  defaultV3SavedWorkflowExecutionServices,
  executeV3SavedWorkflowCommand,
  resolveV3SavedWorkflowMessageTargets,
  v3SavedWorkflowMessageContext,
} from '../src/im/lark/v3-saved-workflow-handler.js';
import * as daemonDiscovery from '../src/utils/daemon-discovery.js';
import * as daemonIpc from '../src/workflows/v3/daemon-ipc-client.js';
import { defaultBaseDir } from '../src/workflows/v3/grill-state.js';
import { readJournal } from '../src/workflows/v3/journal.js';
import { computeSavedWorkflowGateDigest, type SavedWorkflowScope } from '../src/workflows/v3/library-schema.js';
import { createSavedWorkflow } from '../src/workflows/v3/library-store.js';
import { loadAuthorizedV3Run } from '../src/workflows/v3/run-envelope.js';
import { persistV3StartIntent } from '../src/workflows/v3/start-intent.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const APP = 'cli_non_acp';
const CHAT = 'oc_current';
const CALLER = 'ou_current_caller';
const CREATOR = 'ou_definition_creator';
const ROOT = 'om_current_root';
const TURN = 'om_current_turn';
const SESSION = 'non-acp-session';
const bot = {
  larkAppId: APP,
  larkAppSecret: 'fixture-only',
  cliId: 'claude-code',
  workingDir: '/tmp/non-acp-project',
} as botRegistry.BotConfig;

let root: string;
let dataDir: string;
let baseDir: string;
let output: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workflow-non-acp-'));
  const home = join(root, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('SESSION_DATA_DIR', join(root, 'sessions'));
  vi.stubEnv('BOTMUX_WORKFLOW_ENABLED', 'true');
  vi.stubEnv('BOTMUX_AGENT_ROLE', 'worker');
  vi.stubEnv('BOTMUX_SESSION_ID', SESSION);
  // 继承的旧路由/owner不能替换已认证的当前回合。
  vi.stubEnv('BOTMUX_LARK_APP_ID', 'cli_stale');
  vi.stubEnv('BOTMUX_CHAT_ID', 'oc_stale');
  vi.stubEnv('BOTMUX_ROOT_MESSAGE_ID', 'om_stale');
  vi.stubEnv('BOTMUX_OWNER_OPEN_ID', 'ou_stale_owner');
  baseDir = defaultBaseDir();
  dataDir = dirname(baseDir);
  vi.spyOn(botRegistry, 'loadBotConfigs').mockReturnValue([bot]);
  vi.spyOn(daemonDiscovery, 'findOnlineDaemon').mockReturnValue({ larkAppId: APP } as any);
  vi.spyOn(daemonIpc, 'postWorkflowDaemonMutation').mockResolvedValue({ ok: true, status: 200, bodyRaw: '{}' });
  output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  const sessionsDir = process.env.SESSION_DATA_DIR!;
  mkdirSync(join(sessionsDir, '.botmux-cli-pids'), { recursive: true });
  const procStart = readProcessStartIdentity(process.ppid);
  if (!procStart) throw new Error('test parent process start identity unavailable');
  writeFileSync(join(sessionsDir, '.botmux-cli-pids', String(process.ppid)), JSON.stringify({
    sessionId: SESSION, turnId: TURN, procStart,
  }));
  seedPersistedSessionRows(sessionsDir, APP, {
    [SESSION]: {
      sessionId: SESSION, status: 'active', scope: 'thread', larkAppId: APP,
      chatId: CHAT, chatType: 'group', rootMessageId: ROOT,
      ownerOpenId: 'ou_session_owner', lastCallerOpenId: CALLER, quoteTargetId: TURN,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

// 复用参数化目标形态，通过真实store/materializer和当前回合身份驱动CLI/IM入口。
// 仅daemon传输与分离执行使用夹具，不调用模型或飞书。
async function definition(scope: SavedWorkflowScope, app = APP) {
  const dagTemplate = {
    schemaVersion: 2 as const,
    nodes: [{
      id: 'work', type: 'goal' as const, bot: APP,
      goal: 'report for ${params.city} in ${context.chatId}',
      depends: [], inputs: [], humanGate: null,
    }],
  };
  return createSavedWorkflow(dataDir, {
    displayName: '普通模式周报',
    owner: { openId: CREATOR, larkAppId: app },
    scope,
    publish: true,
    revision: {
      inputs: { city: { type: 'string', required: true } },
      contextRefs: ['chatId'],
      specTemplate: {
        schemaVersion: 1, title: '普通模式周报', requirement: 'write a report',
        nodes: [{
          sketchId: 'work', goal: 'write report', input_needs: [],
          expected_outputs: ['report.md'], acceptance: 'report exists',
          risk_gate: false, unknowns: [],
        }],
      },
      specStatus: 'current', dagTemplate,
      safety: { gateDigest: computeSavedWorkflowGateDigest(dagTemplate), sideEffects: [] },
    },
  });
}

function assertCurrentRun(runId: string, workflowId: string) {
  const loaded = loadAuthorizedV3Run(join(baseDir, runId));
  expect(loaded.envelope).toMatchObject({
    source: { kind: 'saved_definition', workflowId },
    chatBinding: {
      larkAppId: APP, chatId: CHAT, chatType: 'group', rootMessageId: ROOT, ownerOpenId: CALLER,
    },
  });
  expect(loaded.envelope.chatBinding?.ownerOpenId).not.toBe(CREATOR);
  expect(loaded.envelope).not.toHaveProperty('workspace');
  expect(existsSync(join(baseDir, runId, 'workspace.selection.json'))).toBe(false);
  expect(existsSync(join(baseDir, runId, 'grill.state.json'))).toBe(false);
  return loaded;
}

describe('ordinary non-ACP Saved Workflow production entry regression', () => {
  it.each(['chat', 'global'] as const)(
    'CLI %s run reaches the daemon after real materialization with current-turn routing',
    async (scope) => {
      const saved = await definition(scope === 'chat' ? { kind: scope, chatId: CHAT } : { kind: scope });
      const runId = `non-acp-cli-${scope}`;
      vi.mocked(daemonIpc.postWorkflowDaemonMutation).mockImplementation(async (input) => {
        assertCurrentRun(input.runId, saved.metadata.workflowId);
        return { ok: true, status: 200, bodyRaw: '{}' };
      });

      await cmdWorkflow('run', [saved.metadata.workflowId, '--param', 'city=上海', '--run-id', runId, '--json']);

      const loaded = assertCurrentRun(runId, saved.metadata.workflowId);
      expect(loaded.envelope.chatBinding).toHaveProperty('sessionId', SESSION);
      expect(loaded.resolvedParams).toMatchObject({ params: { city: '上海' }, context: { chatId: CHAT } });
      // 参数/上下文在任务执行时展开；物化保留模板并冻结已解析输入。
      expect(loaded.dag.nodes[0]).toMatchObject({ goal: saved.revision.payload.dagTemplate.nodes[0]!.goal });
      expect(daemonDiscovery.findOnlineDaemon).toHaveBeenCalledExactlyOnceWith(APP);
      expect(daemonIpc.postWorkflowDaemonMutation).toHaveBeenCalledExactlyOnceWith({
        daemon: { larkAppId: APP }, runId, mutation: 'start',
      });
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ runId, runDir: join(baseDir, runId) });
    },
  );

  it.each([
    { label: 'another chat', scope: { kind: 'chat', chatId: 'oc_other' } as SavedWorkflowScope, app: APP },
    { label: 'another app global', scope: { kind: 'global' } as SavedWorkflowScope, app: 'cli_other' },
  ])('CLI cannot launch a definition from $label', async ({ scope, app }) => {
    const saved = await definition(scope, app);
    const runId = 'non-acp-denied';
    await expect(cmdWorkflow('run', [saved.metadata.workflowId, 'city=上海', '--run-id', runId]))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(existsSync(baseDir)).toBe(false);
    expect(daemonDiscovery.findOnlineDaemon).not.toHaveBeenCalled();
    expect(daemonIpc.postWorkflowDaemonMutation).not.toHaveBeenCalled();
  });

  it('IM global run keeps the standard parser/service path and persists intent before detached execution', async () => {
    const saved = await definition({ kind: 'global' });
    const command = parseV3SavedWorkflowCommand(`/workflow run ${saved.metadata.workflowId} city=北京`);
    if (!command || command.kind !== 'run') throw new Error('expected standard Saved Workflow run');
    const targets = resolveV3SavedWorkflowMessageTargets({ anchor: CHAT, replyRootId: ROOT, messageId: TURN });
    const context = v3SavedWorkflowMessageContext({
      initiatorOpenId: CALLER, larkAppId: APP, chatId: CHAT, chatType: 'group',
      runRootMessageId: targets.runRootMessageId, messageId: TURN, botSender: false,
    });
    const driveDetached = vi.fn((runId: string) => {
      assertCurrentRun(runId, saved.metadata.workflowId);
      expect(readJournal(join(baseDir, runId, 'journal.ndjson'))).toMatchObject([{ type: 'runStarted', runId }]);
    });
    const result = await executeV3SavedWorkflowCommand({ command, dataDir, baseDir, context }, {
      ...defaultV3SavedWorkflowExecutionServices,
      loadBots: () => [bot], persistStartIntent: persistV3StartIntent, driveDetached,
      cancelAndDrive: vi.fn(),
    });
    expect(result.effect).toBe('run_started');
    expect(driveDetached).toHaveBeenCalledTimes(1);
    const runId = driveDetached.mock.calls[0]![0];
    expect(readdirSync(baseDir)).toEqual([runId]);
    expect(assertCurrentRun(runId, saved.metadata.workflowId).resolvedParams)
      .toMatchObject({ params: { city: '北京' }, context: { chatId: CHAT } });
  });

  it.each([
    { label: 'another chat', scope: { kind: 'chat', chatId: 'oc_other' } as SavedWorkflowScope, app: APP },
    { label: 'another app global', scope: { kind: 'global' } as SavedWorkflowScope, app: 'cli_other' },
  ])('IM cannot materialize or drive a definition from $label', async ({ scope, app }) => {
    const saved = await definition(scope, app);
    const instantiate = vi.fn(defaultV3SavedWorkflowExecutionServices.instantiate);
    const persistStartIntent = vi.fn();
    const driveDetached = vi.fn();
    const result = await executeV3SavedWorkflowCommand({
      command: { kind: 'run', ref: saved.metadata.workflowId, rawParams: { city: '上海' } },
      dataDir, baseDir,
      context: { actor: { openId: CALLER, larkAppId: APP }, chatId: CHAT, rootMessageId: ROOT },
    }, {
      ...defaultV3SavedWorkflowExecutionServices,
      instantiate, loadBots: () => [bot], persistStartIntent, driveDetached, cancelAndDrive: vi.fn(),
    });
    expect(result.effect).toBe('failed');
    // 即使底层物化也会拒绝，隐藏定义仍须在可见性查询时失败，不能暴露其存在。
    expect(instantiate).toHaveBeenCalledTimes(1);
    await expect(instantiate.mock.results[0]!.value).rejects.toMatchObject({ code: 'not_found' });
    expect(existsSync(baseDir)).toBe(false);
    expect(persistStartIntent).not.toHaveBeenCalled();
    expect(driveDetached).not.toHaveBeenCalled();
  });
});
