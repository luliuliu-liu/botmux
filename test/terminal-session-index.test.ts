import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appendEventDurable, readJournal, withJournalMutationSync } from '../src/workflows/v3/journal.js';
import { configureJournalBackend } from '../src/workflows/v3/journal-backend.js';
import { backfillLocalTerminalSessionIndex, indexTerminalSessionEvent, lookupTerminalSession, verifyTerminalReadCapability } from '../src/workflows/v3/terminal-session-index.js';
import { createPlatformJournalResolver, createRemoteTerminalIndexMaintenance } from '../src/platform/workflow/remote-journal.js';
import { createWorkflowTerminalProxy } from '../src/dashboard/workflow-terminal-proxy.js';
import { spawnTsEvalWithRepoImports, spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';
import type { StoredEvent } from '../src/workflows/v3/event-contract.js';

const folders: string[] = [];
afterEach(() => { configureJournalBackend(undefined); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-index-'))); folders.push(base);
  const path = join(base, 'run-a', 'journal.ndjson'); mkdirSync(join(base, 'run-a'));
  const event: StoredEvent = { ts: 1, type: 'nodeSessionReady', nodeId: 'task', instanceId: 'task#001', attemptId: 'task/001',
    sessionInfo: { sessionId: randomUUID(), webPort: 43210, viewToken: 'fixture-read-secret' } };
  return { base, path, event, sid: event.sessionInfo.sessionId };
}
function indexPath(base: string): string { return join(base, '.terminal-sessions', readdirSync(join(base, '.terminal-sessions')).find(name => name.endsWith('.json'))!); }

it('indexes actual runtime instance attempt paths with a hash-delimited instance', () => {
  const f = fixture();
  const event = { ...f.event, attemptId: 'task#001/attempts/001' };
  indexTerminalSessionEvent(f.path, event);
  const lookup = lookupTerminalSession(f.base, f.sid);
  expect(lookup.status).toBe('ready');
  if (lookup.status !== 'ready') throw Error('runtime attempt was not indexed');
  expect(lookup.record.attemptId).toBe('task#001/attempts/001');
  expect(verifyTerminalReadCapability(lookup.record, event.sessionInfo.viewToken!)).toBe(true);
});

it('indexes mutation.append (not only appendEvent), storing only a private read-capability digest', () => {
  const f = fixture();
  withJournalMutationSync(f.path, mutation => { mutation.append(f.event, { durable: true }); });
  const lookup = lookupTerminalSession(f.base, f.sid); expect(lookup.status).toBe('ready');
  if (lookup.status !== 'ready') throw Error('not indexed');
  expect(lookup.record).toMatchObject({ runId: 'run-a', nodeId: 'task', instanceId: 'task#001', attemptId: 'task/001' });
  expect(verifyTerminalReadCapability(lookup.record, 'fixture-read-secret')).toBe(true);
  expect(verifyTerminalReadCapability(lookup.record, 'wrong')).toBe(false);
  const raw = readFileSync(indexPath(f.base), 'utf8');
  expect(raw).not.toContain('fixture-read-secret'); expect(raw).not.toContain('43210'); expect(raw).not.toContain('viewToken');
  expect(statSync(join(f.base, '.terminal-sessions')).mode & 0o777).toBe(0o700);
  expect(statSync(indexPath(f.base)).mode & 0o777).toBe(0o600);
  expect(Object.keys(lookup.record).sort()).toEqual(['schema', 'sessionId', 'runId', 'nodeId', 'instanceId', 'attemptId', 'readCapabilityHash'].sort());
});

it.each(['_task', '.task', '-task'])('preserves path-safe DAG node ids starting with punctuation: %s', nodeId => {
  const f = fixture(); f.event.nodeId = nodeId; f.event.instanceId = nodeId + '#001'; f.event.attemptId = nodeId + '/001';
  indexTerminalSessionEvent(f.path, f.event); expect(lookupTerminalSession(f.base, f.sid).status).toBe('ready');
});

it.each(['run', 'node', 'instance', 'attempt', 'capability'])('persists a fail-closed tombstone on a conflicting %s binding', kind => {
  const f = fixture(); indexTerminalSessionEvent(f.path, f.event);
  let path = f.path;
  const conflict = structuredClone(f.event);
  if (kind === 'run') { path = join(f.base, 'run-b', 'journal.ndjson'); mkdirSync(join(f.base, 'run-b')); }
  if (kind === 'node') conflict.nodeId = 'other';
  if (kind === 'instance') conflict.instanceId = 'task#002';
  if (kind === 'attempt') conflict.attemptId = 'task/002';
  if (kind === 'capability') conflict.sessionInfo.viewToken = 'other-read';
  expect(() => indexTerminalSessionEvent(path, conflict)).toThrow('conflict');
  expect(lookupTerminalSession(f.base, f.sid).status).toBe('blocked');
  expect(() => indexTerminalSessionEvent(f.path, f.event)).toThrow('conflict');
  const result = spawnSyncTsEvalWithRepoImports(`import {lookupTerminalSession} from ${JSON.stringify(fileURLToPath(new URL('../src/workflows/v3/terminal-session-index.ts', import.meta.url)))}; console.log(lookupTerminalSession(${JSON.stringify(f.base)},${JSON.stringify(f.sid)}).status);`, { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  expect(result.status).toBe(0); expect(String(result.stdout).trim()).toBe('blocked');
});

it('fails closed on corrupt, permissive and symlink index data without reversing a durable ACK', () => {
  const f = fixture(); appendEventDurable(f.path, f.event);
  const file = indexPath(f.base); writeFileSync(file, '{bad');
  expect(lookupTerminalSession(f.base, f.sid).status).toBe('blocked');
  expect(() => appendEventDurable(f.path, f.event)).not.toThrow(); expect(readJournal(f.path)).toHaveLength(2);
  chmodSync(file, 0o644); expect(lookupTerminalSession(f.base, f.sid).status).toBe('blocked');
  const outside = join(f.base, 'untouched'); writeFileSync(outside, 'DO NOT CHANGE');
  rmSync(file); symlinkSync(outside, file);
  expect(() => appendEventDurable(f.path, f.event)).not.toThrow();
  expect(lookupTerminalSession(f.base, f.sid).status).toBe('blocked'); expect(readFileSync(outside, 'utf8')).toBe('DO NOT CHANGE');
});

it('rejects symlink roots, ancestor directories, lock files and unsafe event paths', () => {
  const f = fixture(); indexTerminalSessionEvent(f.path, f.event);
  const alias = join(f.base, 'alias'); symlinkSync(f.base, alias);
  expect(lookupTerminalSession(alias, f.sid).status).toBe('blocked');
  expect(lookupTerminalSession(join(alias, 'subdir'), f.sid).status).toBe('blocked');
  const file = indexPath(f.base), outside = join(f.base, 'outside'); writeFileSync(outside, 'unchanged'); symlinkSync(outside, file + '.lock');
  expect(() => indexTerminalSessionEvent(f.path, f.event)).toThrow('unsafe');
  expect(readFileSync(outside, 'utf8')).toBe('unchanged');
  const invalid = structuredClone(f.event); invalid.attemptId = '../outside';
  expect(() => indexTerminalSessionEvent(f.path, invalid)).toThrow('invalid');
  expect(() => indexTerminalSessionEvent(join(f.base, 'run-a', 'other'), f.event)).toThrow('invalid');
  expect(lookupTerminalSession(f.base, '../outside').status).toBe('missing');
});

it('keeps simultaneous writers idempotent and makes discovery visible to a different process', async () => {
  const f = fixture();
  const module = fileURLToPath(new URL('../src/workflows/v3/terminal-session-index.ts', import.meta.url));
  const code = `import {indexTerminalSessionEvent,lookupTerminalSession} from ${JSON.stringify(module)}; indexTerminalSessionEvent(${JSON.stringify(f.path)},${JSON.stringify(f.event)}); console.log(lookupTerminalSession(${JSON.stringify(f.base)},${JSON.stringify(f.sid)}).status);`;
  const runs = Array.from({ length: 4 }, () => new Promise<string>((done, reject) => {
    const child = spawnTsEvalWithRepoImports(code, { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout!.on('data', bytes => { out += bytes; }); child.stderr!.on('data', bytes => { err += bytes; });
    child.once('error', reject); child.once('exit', status => status === 0 ? done(out.trim()) : reject(Error(err)));
  }));
  expect(await Promise.all(runs)).toEqual(['ready', 'ready', 'ready', 'ready']);
  expect(lookupTerminalSession(f.base, f.sid).status).toBe('ready');
  expect(readdirSync(join(f.base, '.terminal-sessions'))).toHaveLength(1);
});

it('backfills local history asynchronously without invoking a journal backend or accepting corrupt/remote histories', async () => {
  const f = fixture(); writeFileSync(f.path, JSON.stringify(f.event) + '\n');
  const read = vi.fn(); configureJournalBackend(() => { read(); throw Error('maintenance must not RPC'); });
  const work = backfillLocalTerminalSessionIndex(f.base);
  expect(lookupTerminalSession(f.base, f.sid).status).toBe('missing'); await work;
  expect(lookupTerminalSession(f.base, f.sid).status).toBe('ready'); expect(read).not.toHaveBeenCalled();
  for (const name of ['corrupt', 'remote', 'linked']) {
    const directory = join(f.base, name); mkdirSync(directory);
    const event = structuredClone(f.event); event.sessionInfo.sessionId = randomUUID();
    const path = join(directory, 'journal.ndjson');
    if (name === 'linked') symlinkSync(f.path, path);
    else writeFileSync(path, JSON.stringify(event) + (name === 'corrupt' ? '\ninvalid\n' : '\n'));
    if (name === 'remote') writeFileSync(join(directory, 'journal.api.json'), '{}');
    await backfillLocalTerminalSessionIndex(f.base); expect(lookupTerminalSession(f.base, event.sessionInfo.sessionId).status).toBe('missing');
  }
  expect(read).not.toHaveBeenCalled();
});

function remoteFixture() {
  const f = fixture(), home = f.base, root = join(home, '.botmux', 'v3-runs'), directory = join(root, 'remote-run'), path = join(directory, 'journal.ndjson');
  mkdirSync(directory, { recursive: true }); mkdirSync(join(home, '.botmux', 'platform'));
  writeFileSync(join(home, '.botmux', 'platform', 'workflow-storage.json'), '{}');
  writeFileSync(join(directory, 'journal.api.json'), JSON.stringify({ schema: 'botmux-journal-api-v1', runId: 'remote-run', registrationHash: 'fixture',
    baseUrl: 'http://fixture.invalid', token: 'fixture-WRITE-token', expiresAt: 1e12 }), { mode: 0o600 });
  const events: StoredEvent[] = [{ ts: 1, type: 'runStarted', runId: 'remote-run' }, { ts: 2, type: 'nodeDispatched', nodeId: 'task', instanceId: 'task#001', attemptId: 'task/001' }];
  const request = vi.fn((input: any) => {
    if (input.path.endsWith('/acquire')) return { version: events.length, events: structuredClone(events), fence: 1 };
    if (input.path.endsWith('/append')) { events.push({ ...input.body.events[0], ts: 3 }); return { version: events.length, events: [events.at(-1)] }; }
    if (input.path.endsWith('/release')) return { ok: true };
    return { version: events.length, events: structuredClone(events) };
  });
  configureJournalBackend(createPlatformJournalResolver({ home, active: true, request, requestAsync: async input => request(input), now: () => 1000, readCacheMs: 60000 }));
  return { ...f, root, directory, path, home, events, request };
}

it('indexes remote confirmed mutation.append despite a broken mirror, keeps write tokens out and freshly revalidates one run', async () => {
  const f = remoteFixture(); mkdirSync(f.path); // atomic mirror rename will fail
  expect(() => withJournalMutationSync(f.path, mutation => mutation.append(f.event, { durable: true }))).not.toThrow();
  expect(lookupTerminalSession(f.root, f.sid).status).toBe('ready');
  expect(readFileSync(indexPath(f.root), 'utf8')).not.toContain('fixture-WRITE-token');
  rmSync(f.path, { recursive: true }); f.request.mockClear();
  const resolve = vi.fn(async () => { throw Error('fixture must not dial'); });
  const proxy = createWorkflowTerminalProxy({ runsDir: () => f.root, authenticated: () => false, resolve });
  const response = { writeHead() {}, end() {} } as any;
  await proxy.legacyHttp({ method: 'GET', url: `/s/${f.sid}/?viewToken=wrong`, headers: { host: 'fixture' } } as any, response);
  await proxy.legacyHttp({ method: 'GET', url: `/s/${randomUUID()}/?viewToken=fixture-read-secret`, headers: { host: 'fixture' } } as any, response);
  expect(f.request).not.toHaveBeenCalled();
  await proxy.legacyHttp({ method: 'GET', url: `/s/${f.sid}/?viewToken=fixture-read-secret`, headers: { host: 'fixture' } } as any, response);
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.request.mock.calls[0]![0].path).toBe('/runs/remote-run'); expect(resolve).toHaveBeenCalledTimes(1);
  f.events.push({ type: 'nodeFailed', nodeId: 'task', instanceId: 'task#001', attemptId: 'task/001', errorClass: 'infra', ts: 4 });
  resolve.mockClear();
  await proxy.legacyHttp({ method: 'GET', url: `/s/${f.sid}/?viewToken=fixture-read-secret`, headers: { host: 'fixture' } } as any, response);
  expect(f.request).toHaveBeenCalledTimes(2); expect(resolve).not.toHaveBeenCalled();
  expect(existsSync(f.path)).toBe(false); // no mirror relied on or repaired in requests
});

it('returns a remote durable ACK once even when index publication is unsafe', () => {
  const f = remoteFixture(), outside = join(f.home, 'outside-index'); mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'unchanged');
  symlinkSync(outside, join(f.root, '.terminal-sessions'));
  let calls = 0;
  const stored = withJournalMutationSync(f.path, mutation => { calls++; return mutation.append(f.event, { durable: true }); });
  expect(calls).toBe(1); expect(stored).toEqual(f.events.at(-1)); expect(f.events).toHaveLength(3);
  expect(lookupTerminalSession(f.root, f.sid).status).toBe('blocked');
  expect(readdirSync(outside)).toEqual(['sentinel']); expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
  expect(f.request.mock.calls.filter(([input]) => input.path.endsWith('/append'))).toHaveLength(1);
});

it('remote historical repair is bounded, read-only, descriptor-scoped and skips expired credentials', async () => {
  const f = remoteFixture(); f.events.push(f.event);
  for (const name of ['remote-b', 'remote-c']) {
    const directory = join(f.root, name); mkdirSync(directory);
    writeFileSync(join(directory, 'journal.api.json'), JSON.stringify({ schema: 'botmux-journal-api-v1', runId: name,
      baseUrl: 'http://fixture.invalid', token: 'fixture-WRITE-token', expiresAt: name === 'remote-c' ? 10 : 1e12 }), { mode: 0o600 });
  }
  const maintain = createRemoteTerminalIndexMaintenance({ home: f.home, active: true, now: () => 1000, maxRuns: 1, request: f.request });
  expect(lookupTerminalSession(f.root, f.sid).status).toBe('missing');
  await maintain(); expect(f.request).toHaveBeenCalledTimes(1); await maintain(); expect(f.request).toHaveBeenCalledTimes(1);
  await maintain(); expect(f.request).toHaveBeenCalledTimes(2); expect(lookupTerminalSession(f.root, f.sid).status).toBe('blocked'); // same sid returned for two runs is ambiguous
  expect(f.request.mock.calls.every(([input]) => input.method === 'GET' && !input.path.endsWith('/session') && input.body === undefined)).toBe(true);
  expect(readFileSync(indexPath(f.root), 'utf8')).not.toContain('fixture-WRITE-token');
});
