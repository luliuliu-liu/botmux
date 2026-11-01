import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLockSync } from '../../utils/file-lock.js';
import type { StoredEvent } from './event-contract.js';

/** Discovery only. No live state, worker port, log path or write credential. */
export interface TerminalSessionIndexRecord {
  schema: 'botmux-terminal-session-v1';
  sessionId: string;
  runId: string;
  nodeId: string;
  instanceId?: string;
  attemptId: string;
  readCapabilityHash: string;
}
export type TerminalSessionLookup = { status: 'ready'; record: TerminalSessionIndexRecord } | { status: 'missing' | 'blocked' };
const indexName = '.terminal-sessions';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const validSession = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validNode = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]{1,255}$/.test(value) && value !== '.' && value !== '..';
const validAttempt = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && value.split('/').every(part => part.length <= 255 && validInstance(part));
const validInstance = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._#-]{1,512}$/.test(value) && value !== '.' && value !== '..';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

// macOS system aliases are not user-controlled links. All other links, including
// a symlink runsDir or a symlink in HOME, are rejected rather than canonicalized.
function absolute(path: string): string {
  const result = resolve(path);
  return process.platform === 'darwin' ? result.replace(/^\/(var|tmp)(?=\/|$)/, '/private/$1') : result;
}
function stat(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export function safeTerminalDirectory(path: string): string {
  const target = absolute(path);
  let current = parse(target).root;
  for (const part of relative(current, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    const value = lstatSync(current);
    if (!value.isDirectory() || value.isSymbolicLink()) throw Error('unsafe_terminal_directory');
  }
  return target;
}
/** A single named run; never discover runs from a terminal request. */
export function terminalJournalPath(runsDir: string, runId: string): string {
  if (!validId(runId)) throw Error('invalid_terminal_run');
  return join(safeTerminalDirectory(join(safeTerminalDirectory(runsDir), runId)), 'journal.ndjson');
}
function privateStat(path: string, directory: boolean) {
  const value = stat(path);
  if (!value) return;
  if (value.isSymbolicLink() || !(directory ? value.isDirectory() : value.isFile()) ||
    (value.mode & 0o777) !== (directory ? 0o700 : 0o600) || (!directory && value.nlink !== 1) ||
    (process.getuid && value.uid !== process.getuid())) throw Error('unsafe_terminal_index');
  return value;
}
function indexDirectory(runsDir: string, create = false): string {
  const path = join(safeTerminalDirectory(runsDir), indexName);
  if (create && !stat(path)) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  if (!privateStat(path, true)) throw Object.assign(Error('terminal_index_missing'), { code: 'ENOENT' });
  return path;
}
function indexFile(directory: string, sessionId: string) { return join(directory, digest(sessionId) + '.json'); }
function readIndex(path: string): unknown {
  if (!privateStat(path, false)) return;
  const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const value = fstatSync(fd);
    if (!value.isFile() || value.size > 4096 || value.nlink !== 1 || (value.mode & 0o777) !== 0o600) throw Error('unsafe_terminal_index');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function validRecord(value: any, sessionId: string): value is TerminalSessionIndexRecord {
  return value?.schema === 'botmux-terminal-session-v1' && value.sessionId === sessionId && validSession(value.sessionId) &&
    validId(value.runId) && validNode(value.nodeId) && validAttempt(value.attemptId) &&
    (value.instanceId === undefined || validInstance(value.instanceId)) && typeof value.readCapabilityHash === 'string' && /^[a-f0-9]{64}$/.test(value.readCapabilityHash) &&
    Object.keys(value).every(key => ['schema', 'sessionId', 'runId', 'nodeId', 'instanceId', 'attemptId', 'readCapabilityHash'].includes(key));
}
export function lookupTerminalSession(runsDir: string, sessionId: string): TerminalSessionLookup {
  if (!validSession(sessionId)) return { status: 'missing' };
  try {
    const value = readIndex(indexFile(indexDirectory(runsDir), sessionId));
    if (value === undefined) return { status: 'missing' };
    return validRecord(value, sessionId) ? { status: 'ready', record: value } : { status: 'blocked' };
  } catch (error) { return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'blocked' }; }
}
export function verifyTerminalReadCapability(record: TerminalSessionIndexRecord, token: string): boolean {
  if (!token || token.length > 4096) return false;
  const a = Buffer.from(digest(token), 'hex'), b = Buffer.from(record.readCapabilityHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Called at the journal append boundary, not only from appendEvent. Errors are
 * deliberately visible to maintenance but swallowed by ACK-producing callers. */
export function indexTerminalSessionEvent(journalPath: string, event: StoredEvent): void {
  if (event.type !== 'nodeSessionReady' || !event.sessionInfo.viewToken) return;
  const runDir = dirname(absolute(journalPath)), runId = basename(runDir), runsDir = dirname(runDir);
  if (basename(journalPath) !== 'journal.ndjson' || !validId(runId) || !validNode(event.nodeId) ||
    !validSession(event.sessionInfo.sessionId) || !validAttempt(event.attemptId) ||
    (event.instanceId !== undefined && !validInstance(event.instanceId)) || event.sessionInfo.viewToken.length > 4096) throw Error('invalid_terminal_binding');
  terminalJournalPath(runsDir, runId);
  const directory = indexDirectory(runsDir, true), path = indexFile(directory, event.sessionInfo.sessionId);
  const record: TerminalSessionIndexRecord = { schema: 'botmux-terminal-session-v1', sessionId: event.sessionInfo.sessionId,
    runId, nodeId: event.nodeId, ...(event.instanceId === undefined ? {} : { instanceId: event.instanceId }), attemptId: event.attemptId,
    readCapabilityHash: digest(event.sessionInfo.viewToken) };
  const lock = stat(path + '.lock');
  if (lock && (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1)) throw Error('unsafe_terminal_index_lock');
  withFileLockSync(path, () => {
    privateStat(directory, true);
    chmodSync(path + '.lock', 0o600);
    const previous = readIndex(path);
    if (previous !== undefined) {
      if (validRecord(previous, record.sessionId) && JSON.stringify(previous) === JSON.stringify(record)) return;
      // A session must never select the first of two runs/attempts/capabilities.
      // Persist the ambiguity, including across maintenance and process restarts.
      atomicWriteFileSync(path, JSON.stringify({ schema: 'botmux-terminal-session-conflict-v1' }), { mode: 0o600, durable: true, followTargetSymlink: false });
      throw Error('terminal_session_conflict');
    }
    atomicWriteFileSync(path, JSON.stringify(record), { mode: 0o600, durable: true, followTargetSymlink: false });
  }, { maxWaitMs: 250 });
}
export function indexConfirmedTerminalEvents(journalPath: string, events: StoredEvent[]): void {
  for (const event of events) { try { indexTerminalSessionEvent(journalPath, event); } catch { /* Discovery cannot revoke a durable journal ACK. */ } }
}

/** Offline maintenance: async local file I/O, never readJournal (which may RPC).
 * Remote descriptors must be handled by the restricted remote maintenance path. */
export async function backfillLocalTerminalSessionIndex(runsDir: string): Promise<void> {
  let root: string;
  try { root = safeTerminalDirectory(runsDir); } catch { return; }
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    try {
      const path = terminalJournalPath(root, entry.name);
      if (stat(join(dirname(path), 'journal.api.json')) || stat(join(dirname(path), 'journal.api.pending.json'))) continue;
      const metadata = await fs.lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) continue;
      const handle = await fs.open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      let raw: string;
      try { raw = await handle.readFile('utf8'); } finally { await handle.close(); }
      const lines = raw.split('\n'), events: StoredEvent[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.trim()) continue;
        try { events.push(JSON.parse(lines[i]!)); } catch (error) { if (i === lines.length - 1 && !raw.endsWith('\n')) break; throw error; }
      }
      indexConfirmedTerminalEvents(path, events);
    } catch { /* Bad or unavailable history is not a terminal registration. */ }
    await new Promise<void>(done => setImmediate(done));
  }
}

/** Replay paths stay beneath the same run and never follow links. */
export function safeTerminalReplayPath(runDir: string, path: string): string | undefined {
  try {
    const root = safeTerminalDirectory(runDir), file = absolute(path), rel = relative(root, file);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return;
    safeTerminalDirectory(dirname(file));
    const value = lstatSync(file);
    if (value.isFile() && !value.isSymbolicLink() && value.nlink === 1) return file;
  } catch { /* Fail closed. */ }
}
