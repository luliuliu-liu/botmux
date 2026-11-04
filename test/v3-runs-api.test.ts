import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { handleV3RunsApi } from '../src/dashboard/v3-runs-api.js';
import type { V3RunsApiDeps } from '../src/dashboard/v3-runs-api.js';
import {ArchiveReader} from '../src/platform/workflow/archive-reader.js';

/** Minimal ServerResponse mock: a real Writable (so createReadStream.pipe
 *  works) with writeHead/end capture. */
function mockRes() {
  const chunks: Buffer[] = [];
  let status = 0;
  let headers: Record<string, string> = {};
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  (w as unknown as ServerResponse).writeHead = ((s: number, h?: Record<string, string>) => {
    status = s; if (h) headers = h; return w as unknown as ServerResponse;
  }) as ServerResponse['writeHead'];
  return {
    res: w as unknown as ServerResponse,
    done: new Promise<void>((resolve) => w.on('finish', resolve)),
    get status() { return status; },
    get headers() { return headers; },
    body() { return Buffer.concat(chunks).toString('utf-8'); },
    json() { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); },
  };
}

function get(path: string): { req: IncomingMessage; url: URL } {
  return { req: { method: 'GET' } as IncomingMessage, url: new URL(`http://x${path}`) };
}

function post(path: string): { req: IncomingMessage; url: URL } {
  return { req: { method: 'POST' } as IncomingMessage, url: new URL(`http://x${path}`) };
}

function apiDeps(
  runsDir: string,
  proxyToDaemon: V3RunsApiDeps['proxyToDaemon'] = async () => new Response('{}', { status: 500 }),
): V3RunsApiDeps {
  return { runsDir, proxyToDaemon };
}

function buildRun(runsDir: string, runId: string): string {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'dag.json'), JSON.stringify({
    runId,
    nodes: [{ id: 'research', type: 'goal', goal: 'g', depends: [], inputs: [] }],
  }));
  const jp = join(runDir, 'journal.ndjson');
  appendEvent(jp, { type: 'runStarted', runId });
  appendEvent(jp, { type: 'nodeDispatched', nodeId: 'research', attemptId: 'research/attempts/001' });
  appendEvent(jp, {
    type: 'nodeSessionReady', nodeId: 'research', attemptId: 'research/attempts/001',
    sessionInfo: { sessionId: 's', webPort: 5101 },
    ptyLogPath: join(runDir, 'research/attempts/001/pty.log'),
  });
  return runDir;
}

it('serves an authenticated standalone xterm replay page for a completed node without executing a worker', async () => {
  const base = mkdtempSync(join(tmpdir(), 'v3-replay-api-'));
  try {
    const dir = buildRun(base, 'completed-replay'), attempt = join(dir, 'research/attempts/001');
    mkdirSync(attempt, { recursive: true }); writeFileSync(join(attempt, 'pty.log'), '\u001b[31mRED OUTPUT\u001b[0m\n');
    appendEvent(join(dir, 'journal.ndjson'), { type: 'nodeSucceeded', nodeId: 'research', attemptId: 'research/attempts/001', manifestPath: join(attempt, 'manifest.json') });
    appendEvent(join(dir, 'journal.ndjson'), { type: 'runSucceeded' });
    const proxy = vi.fn(), deps = apiDeps(base, proxy), path = '/api/v3/runs/completed-replay/nodes/research/terminal-replay';
    const denied = mockRes(), a = get(path); await handleV3RunsApi(a.req, denied.res, a.url, deps, false); expect(denied.status).toBe(401);
    const allowed = mockRes(), b = get(path); await handleV3RunsApi(b.req, allowed.res, b.url, deps, true);
    expect(allowed.status).toBe(200); expect(allowed.headers['content-type']).toContain('text/html');
    expect(allowed.body()).toContain('/assets/xterm.umd.js'); expect(allowed.body()).toContain('/nodes/research/pty-log');
    expect(allowed.body()).not.toContain(base); expect(allowed.body()).not.toContain('viewToken'); expect(proxy).not.toHaveBeenCalled();
    const raw = mockRes(), c = get(path.replace('terminal-replay', 'pty-log')); await handleV3RunsApi(c.req, raw.res, c.url, deps, true); await raw.done;
    expect(raw.body()).toBe('\u001b[31mRED OUTPUT\u001b[0m\n');
    const missing = mockRes(), d = get(path.replace('/research/', '/missing/')); await handleV3RunsApi(d.req, missing.res, d.url, deps, true); expect(missing.status).toBe(404);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

function writeEnvelope(runDir: string, runId: string, larkAppId?: string): void {
  const sha256 = `sha256:${'0'.repeat(64)}`;
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    schemaVersion: 1,
    engine: 'workflow-v3',
    runId,
    createdAt: '2026-07-11T00:00:00.000Z',
    ...(larkAppId ? {
      chatBinding: { larkAppId, chatId: 'oc_chat', ownerOpenId: 'ou_owner' },
    } : {}),
    source: { kind: 'manual_cli' },
    artifacts: {
      dag: { path: 'dag.json', sha256 },
      botSnapshots: { path: 'bots.snapshot.json', sha256 },
    },
    authorization: {
      kind: 'local_cli',
      authorizedAt: '2026-07-11T00:00:00.000Z',
      dagSha256: sha256,
    },
  }));
}

function writeLegacyGrill(runDir: string, runId: string, larkAppId: string): void {
  writeFileSync(join(runDir, 'grill.state.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    goal: 'legacy',
    status: 'dag_approved',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    specPath: join(runDir, 'spec.md'),
    specJsonPath: join(runDir, 'spec.json'),
    chatBinding: { larkAppId, chatId: 'oc_chat', ownerOpenId: 'ou_owner' },
  }));
}

describe('v3-runs-api', () => {
  it('GET list/detail 未授权 → 401，不泄漏 run 是否存在', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      buildRun(base, 'r-260602-0907');
      for (const path of ['/api/v3/runs', '/api/v3/runs/r-260602-0907', '/api/v3/runs/missing']) {
        const m = mockRes();
        const { req, url } = get(path);
        const handled = await handleV3RunsApi(req, m.res, url, apiDeps(base), false);
        expect(handled).toBe(true);
        expect(m.status, path).toBe(401);
        expect(m.json()).toEqual({ ok: false, error: 'auth_required' });
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('GET /api/v3/runs → 200 + runs[]', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      buildRun(base, 'r-260602-0907');
      const { req, url } = get('/api/v3/runs');
      const m = mockRes();
      const handled = await handleV3RunsApi(req, m.res, url, apiDeps(base), true);
      expect(handled).toBe(true);
      expect(m.status).toBe(200);
      const body = m.json() as { runs: Array<{ runId: string }> };
      expect(body.runs.map((r) => r.runId)).toContain('r-260602-0907');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('GET /api/v3/runs/:id → 200 + RunView', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      buildRun(base, 'r-260602-0907');
      const { req, url } = get('/api/v3/runs/r-260602-0907');
      const m = mockRes();
      await handleV3RunsApi(req, m.res, url, apiDeps(base), true);
      expect(m.status).toBe(200);
      const view = m.json() as { runId: string; nodes: Array<{ id: string; webTerminal?: unknown }> };
      expect(view.runId).toBe('r-260602-0907');
      expect(view.nodes[0].id).toBe('research');
      // read-only DTO：webTerminal 无 token
      expect((view.nodes[0].webTerminal as Record<string, unknown>).token).toBeUndefined();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('GET /api/v3/runs/:id 未知 → 404；非法字符 id → 404（isValidRunId 拒）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      const m1 = mockRes();
      await handleV3RunsApi(get('/api/v3/runs/missing-260602-0000').req, m1.res, get('/api/v3/runs/missing-260602-0000').url, apiDeps(base), true);
      expect(m1.status).toBe(404);
      // 单段但含非法字符（projectRunById 的 isValidRunId 拒 → 404）
      const m2 = mockRes();
      await handleV3RunsApi(get('/api/v3/runs/bad!id').req, m2.res, get('/api/v3/runs/bad!id').url, apiDeps(base), true);
      expect(m2.status).toBe(404);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('GET pty-log 未授权 → 401（不泄漏原始终端字节）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      buildRun(base, 'r-260602-0907');
      const p = '/api/v3/runs/r-260602-0907/nodes/research/pty-log';
      const m = mockRes();
      await handleV3RunsApi(get(p).req, m.res, get(p).url, apiDeps(base), /*authed*/ false);
      expect(m.status).toBe(401);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('GET pty-log 已授权 + 文件存在 → 200 + 内容 + size header', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      const runDir = buildRun(base, 'r-260602-0907');
      const ptyDir = join(runDir, 'research/attempts/001');
      mkdirSync(ptyDir, { recursive: true });
      writeFileSync(join(ptyDir, 'pty.log'), 'hello pty bytes\n');
      const p = '/api/v3/runs/r-260602-0907/nodes/research/pty-log';
      const m = mockRes();
      await handleV3RunsApi(get(p).req, m.res, get(p).url, apiDeps(base), /*authed*/ true);
      await m.done;
      expect(m.status).toBe(200);
      expect(m.headers['x-botmux-log-bytes']).toBe(String('hello pty bytes\n'.length));
      expect(m.body()).toContain('hello pty bytes');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('GET pty-log 已授权但无日志 → 404', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      buildRun(base, 'r-260602-0907'); // 事件里有路径，但 pty.log 文件没写出来
      const p = '/api/v3/runs/r-260602-0907/nodes/research/pty-log';
      const m = mockRes();
      await handleV3RunsApi(get(p).req, m.res, get(p).url, apiDeps(base), true);
      expect(m.status).toBe(404);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('POST cancel 必须授权，且从 run.json 不可变绑定代理到 owner daemon', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      const runId = 'r-260602-0907';
      const runDir = buildRun(base, runId);
      writeEnvelope(runDir, runId, 'cli_owner');
      // A mutable legacy file must not override an existing valid envelope.
      writeLegacyGrill(runDir, runId, 'legacy_owner');
      const proxy = vi.fn(async () => new Response(JSON.stringify({
        ok: true, runId, status: 'cancelling', cancelRequestId: 'cancel-1',
      }), { status: 202, headers: { 'content-type': 'application/json' } }));
      const path = `/api/v3/runs/${runId}/cancel`;

      const denied = mockRes();
      await handleV3RunsApi(post(path).req, denied.res, post(path).url, apiDeps(base, proxy), false);
      expect(denied.status).toBe(401);
      expect(proxy).not.toHaveBeenCalled();

      const accepted = mockRes();
      await handleV3RunsApi(post(path).req, accepted.res, post(path).url, apiDeps(base, proxy), true);
      expect(accepted.status).toBe(202);
      expect(accepted.json()).toMatchObject({ ok: true, status: 'cancelling' });
      expect(proxy).toHaveBeenCalledOnce();
      const [owner, daemonPath, init] = proxy.mock.calls[0]!;
      expect(owner).toBe('cli_owner');
      expect(daemonPath).toBe(`/__workflow-ipc/v1/runs/${runId}/cancel`);
      expect(init).toMatchObject({ method: 'POST' });
      expect(JSON.parse(init.body as string)).toEqual({ reason: 'cancelled via dashboard' });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('POST cancel 仅在 run.json 缺失时回退 legacy grill；invalid envelope fail-closed', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      const legacyId = 'legacy-260602-0907';
      const legacyDir = buildRun(base, legacyId);
      writeLegacyGrill(legacyDir, legacyId, 'legacy_owner');
      const proxy = vi.fn(async () => new Response(JSON.stringify({ ok: true, status: 'cancelling' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }));
      const legacyPath = `/api/v3/runs/${legacyId}/cancel`;
      const legacy = mockRes();
      await handleV3RunsApi(post(legacyPath).req, legacy.res, post(legacyPath).url, apiDeps(base, proxy), true);
      expect(legacy.status).toBe(202);
      expect(proxy.mock.calls[0]?.[0]).toBe('legacy_owner');

      const corruptId = 'corrupt-260602-0907';
      const corruptDir = buildRun(base, corruptId);
      writeLegacyGrill(corruptDir, corruptId, 'must_not_win');
      writeFileSync(join(corruptDir, 'run.json'), '{not-json');
      const corruptPath = `/api/v3/runs/${corruptId}/cancel`;
      const corrupt = mockRes();
      await handleV3RunsApi(post(corruptPath).req, corrupt.res, post(corruptPath).url, apiDeps(base, proxy), true);
      expect(corrupt.status).toBe(409);
      expect(corrupt.json()).toEqual({ ok: false, error: 'invalid_run_envelope' });
      expect(proxy).toHaveBeenCalledTimes(1);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('POST cancel 对未知或无 daemon owner 的 run 拒绝在 Dashboard 直写', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      const proxy = vi.fn(async () => new Response('{}', { status: 202 }));
      const missingPath = '/api/v3/runs/missing-260602-0907/cancel';
      const missing = mockRes();
      await handleV3RunsApi(post(missingPath).req, missing.res, post(missingPath).url, apiDeps(base, proxy), true);
      expect(missing.status).toBe(404);

      const malformedPath = '/api/v3/runs/%E0%A4%A/cancel';
      const malformed = mockRes();
      await handleV3RunsApi(post(malformedPath).req, malformed.res, post(malformedPath).url, apiDeps(base, proxy), true);
      expect(malformed.status).toBe(400);
      expect(malformed.json()).toEqual({ ok: false, error: 'bad_run_id' });

      const runId = 'manual-260602-0907';
      const runDir = buildRun(base, runId);
      writeEnvelope(runDir, runId);
      const manualPath = `/api/v3/runs/${runId}/cancel`;
      const manual = mockRes();
      await handleV3RunsApi(post(manualPath).req, manual.res, post(manualPath).url, apiDeps(base, proxy), true);
      expect(manual.status).toBe(409);
      expect(manual.json()).toMatchObject({ ok: false, error: 'needs_cli_cancel' });
      expect(proxy).not.toHaveBeenCalled();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('非 v3 路由 / 非 GET → 返回 false（交给后续 handler）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      const m = mockRes();
      const handled = await handleV3RunsApi({ method: 'POST' } as IncomingMessage, m.res, new URL('http://x/api/v3/runs'), apiDeps(base), false);
      expect(handled).toBe(false);
      const m2 = mockRes();
      const h2 = await handleV3RunsApi(get('/api/other').req, m2.res, get('/api/other').url, apiDeps(base), false);
      expect(h2).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe('v3 runs API — compacted archive guard',()=>{
 const archiveRow={runId:'archived-run',revision:7,state:'compacted',pinned:false,archiveHash:'a'.repeat(64),archiveVerifiedAt:'2026-10-01T00:00:00Z',archiveBytes:5,lastError:null,summary:{runId:'archived-run',runStatus:'succeeded',title:'Archived',createdAt:'2026-09-01T00:00:00Z',terminalAt:'2026-09-02T00:00:00Z',deliveryMode:'archive-only',reportDelivery:{status:'not_applicable'},jobs:[],readOnly:true,logsArchived:false},files:[{key:'b'.repeat(64),nodeId:'report',attemptId:'report/1',path:'report.md',bytes:5,sha256:'c'.repeat(64),kind:'file',blob:'blob'}],compactionReasons:[],canCompact:false,recommendedArchiveUntil:null};
 const archives={schema:'acp-retention-archives-v1',automaticCleanup:false,rows:[archiveRow]};
 function archivedDeps(base:string,request=vi.fn(async()=>({status:200,data:archives}))){return {...apiDeps(base),archiveReader:new ArchiveReader({runsDir:base,active:true,request,rawRequest:async()=>new Response('hello')})};}
 it('uses Gateway archive state before stale local detail, blocks mutation and never serves raw PTY',async()=>{
  const base=mkdtempSync(join(tmpdir(),'v3-archive-'));try{const dir=buildRun(base,'archived-run'),attempt=join(dir,'research/attempts/001');mkdirSync(attempt,{recursive:true});writeFileSync(join(attempt,'pty.log'),'STALE LOCAL SECRET');
   const deps=archivedDeps(base);for(const [path,status,error] of [['/api/v3/runs/archived-run',200,null],['/api/v3/runs/archived-run/nodes/research/pty-log',410,'not_archived'],['/api/v3/runs/archived-run/cancel',410,'archived_read_only']] as const){const call=path.endsWith('/cancel')?post(path):get(path),out=mockRes();await handleV3RunsApi(call.req,out.res,call.url,deps,true);expect(out.status).toBe(status);if(error)expect(out.json().error).toBe(error);else expect(out.json()).toMatchObject({archived:true,readOnly:true,nodes:[]});}
   const artifact=mockRes(),call=get('/api/v3/runs/archived-run/artifacts/'+'b'.repeat(64));await handleV3RunsApi(call.req,artifact.res,call.url,deps,true);expect(artifact.status).toBe(200);expect(artifact.body()).toBe('hello');
  }finally{rmSync(base,{recursive:true,force:true});}
 });
 it('does not treat Gateway failure as archive absence and fall back to local cache',async()=>{const base=mkdtempSync(join(tmpdir(),'v3-archive-fail-'));try{buildRun(base,'archived-run');const deps=archivedDeps(base,vi.fn(async()=>{throw Error('offline');}));const out=mockRes(),call=get('/api/v3/runs/archived-run');await handleV3RunsApi(call.req,out.res,call.url,deps,true);expect(out.status).toBe(503);expect(out.json().error).toBe('archive_gateway_unavailable');}finally{rmSync(base,{recursive:true,force:true});}});
});

describe('v3 runs API — remote journal reads never block the event loop', () => {
  it('serves the list, detail and pty-log route through the non-blocking journal read', async () => {
    const { configureJournalBackend } = await import('../src/workflows/v3/journal-backend.js');
    const base = mkdtempSync(join(tmpdir(), 'v3-runs-async-'));
    try {
      buildRun(base, 'remote-260602-0001');
      const events = (await import('../src/workflows/v3/journal.js')).readJournal(join(base, 'remote-260602-0001', 'journal.ndjson'));
      let release = () => {};
      const gate = new Promise<void>((done) => { release = done; });
      const readAsync = vi.fn(async () => { await gate; return events; });
      const read = vi.fn(() => { throw new Error('a Dashboard request must not use the blocking read'); });
      configureJournalBackend(() => ({ read, readAsync, withMutationSync: () => { throw new Error('read only'); } }));
      try {
        const pending = [
          (async () => { const r = mockRes(); const { req, url } = get('/api/v3/runs'); await handleV3RunsApi(req, r.res, url, apiDeps(base), true); return r; })(),
          (async () => { const r = mockRes(); const { req, url } = get('/api/v3/runs/remote-260602-0001'); await handleV3RunsApi(req, r.res, url, apiDeps(base), true); return r; })(),
          (async () => { const r = mockRes(); const { req, url } = get('/api/v3/runs/remote-260602-0001/nodes/research/pty-log'); await handleV3RunsApi(req, r.res, url, apiDeps(base), true); return r; })(),
        ];
        await vi.waitFor(() => expect(readAsync).toHaveBeenCalledTimes(3));
        // The event loop is free while the reads are pending.
        expect(await new Promise((done) => setImmediate(() => done('free')))).toBe('free');
        release();
        const [list, detail, log] = await Promise.all(pending);
        expect(list.json().runs).toEqual([expect.objectContaining({ runId: 'remote-260602-0001', nodeCount: 1 })]);
        expect(detail.json()).toMatchObject({ runId: 'remote-260602-0001' });
        expect(log.status).toBe(404);
        expect(read).not.toHaveBeenCalled();
      } finally { configureJournalBackend(undefined); }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
