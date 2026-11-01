import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJournalAsync } from '../workflows/v3/journal.js';
import type { StoredEvent } from '../workflows/v3/event-contract.js';
import { materialize } from '../workflows/v3/state.js';
import { isValidRunId } from '../workflows/v3/ops-projection.js';
import { lookupTerminalSession, safeTerminalReplayPath, terminalJournalPath, verifyTerminalReadCapability, type TerminalSessionIndexRecord } from '../workflows/v3/terminal-session-index.js';
import { proxyHttp, proxyUpgrade, safeProxyPath, type ProxyTarget } from '../platform/transport/http-proxy.js';
import { terminalOnlyTarget } from '../platform/management/terminal-entry.js';
import { buildReplayTerminalSrcdoc } from './web/v3-terminal.js';

export type WorkflowTerminalSession = { attemptId: string; sessionId: string; webPort: number; viewToken: string };
type SessionRecord = WorkflowTerminalSession & { runId: string; nodeId: string; live: boolean; logPath?: string };

/** Async so a slow remote journal never stalls other Dashboard requests. */
async function authoritativeEvents(runsDir: string, runId: string): Promise<{ path: string; events: StoredEvent[] }> {
  const path = terminalJournalPath(runsDir, runId);
  try {
    const value = lstatSync(path);
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) throw Error('unsafe_terminal_journal');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { path, events: await readJournalAsync(path) };
}
function currentSession(events: StoredEvent[], event: Extract<StoredEvent, { type: 'nodeSessionReady' }>): boolean {
  const state = materialize(events), node = state.nodes.get(event.nodeId), port = event.sessionInfo.webPort;
  return state.runStatus === 'running' && !state.cancelRequestId && node?.status === 'running' && node.effectiveInstanceId === event.instanceId &&
    state.attempts.get(event.instanceId ?? event.nodeId) === event.attemptId && Number.isInteger(port) && port! > 0 && port! <= 65535;
}
/** Capability was verified against discovery before this one-run authoritative read. */
async function workflowTerminalForSession(runsDir: string, record: TerminalSessionIndexRecord, token: string): Promise<SessionRecord | undefined> {
  const { path, events } = await authoritativeEvents(runsDir, record.runId);
  const candidates = events.filter((event): event is Extract<StoredEvent, { type: 'nodeSessionReady' }> =>
    event.type === 'nodeSessionReady' && event.sessionInfo.sessionId === record.sessionId);
  // Check all observations, not only the last one: retries/loops may not reuse
  // a session to silently select a different attempt or read capability.
  if (!candidates.length || candidates.some(event => event.nodeId !== record.nodeId || event.instanceId !== record.instanceId ||
    event.attemptId !== record.attemptId || event.sessionInfo.viewToken !== token)) return;
  const event = candidates[candidates.length - 1]!, runDir = dirname(path);
  const logPath = (event.ptyLogPath ? safeTerminalReplayPath(runDir, event.ptyLogPath) : undefined) ??
    safeTerminalReplayPath(runDir, join(runDir, record.attemptId, 'pty.log')) ?? safeTerminalReplayPath(runDir, join(runDir, record.attemptId, 'stdout.log'));
  return { runId: record.runId, nodeId: record.instanceId ?? record.nodeId, attemptId: record.attemptId, sessionId: record.sessionId,
    viewToken: token, webPort: event.sessionInfo.webPort ?? 0, live: currentSession(events, event), logPath };
}
/** Never route a stale retry/loop session or a browser-selected port. */
export async function liveWorkflowTerminal(runsDir: string, runId: string, nodeId: string): Promise<WorkflowTerminalSession | undefined> {
  if (!isValidRunId(runId)) return;
  try {
    const { events } = await authoritativeEvents(runsDir, runId);
    for (const event of [...events].reverse()) {
      if (event.type !== 'nodeSessionReady' || (event.nodeId !== nodeId && event.instanceId !== nodeId)) continue;
      const session = event.sessionInfo;
      if (session.viewToken && currentSession(events, event))
        return { attemptId: event.attemptId, sessionId: session.sessionId, webPort: session.webPort!, viewToken: session.viewToken };
    }
  } catch { /* Invalid or unavailable authority never registers a live target. */ }
}

export function createWorkflowTerminalProxy(deps: {
  runsDir: () => string;
  authenticated: (req: IncomingMessage) => boolean;
  resolve: (runId: string, session: WorkflowTerminalSession) => Promise<ProxyTarget>;
  bind?: (req: IncomingMessage, close: () => void) => (() => void) | undefined;
}) {
  function parsed(req: IncomingMessage): URL | undefined {
    try { return new URL(safeProxyPath(req.url ?? '/'), 'http://workflow.local'); } catch { return; }
  }
  function route(req: IncomingMessage) {
    const url = parsed(req), match = url?.pathname.match(/^\/api\/v3\/runs\/([^/]+)\/nodes\/([^/]+)\/terminal\/?$/);
    try { return match ? { runId: decodeURIComponent(match[1]!), nodeId: decodeURIComponent(match[2]!), url: url! } : undefined; } catch { return; }
  }
  function originAllowed(req: IncomingMessage) {
    if (!req.headers.origin) return true;
    try {
      const origin = new URL(req.headers.origin);
      return ['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && origin.host === req.headers.host;
    } catch { return false; }
  }
  function allowed(req: IncomingMessage, url: URL) {
    // Modern token params remain inert for compatibility, never port selection.
    return req.method === 'GET' && [...url.searchParams.keys()].every(key => key === 'token' || key === 'viewToken') &&
      originAllowed(req) && deps.authenticated(req);
  }
  function legacyRoute(req: IncomingMessage) {
    const url = parsed(req), match = url?.pathname.match(/^\/s\/([0-9a-f-]{36})(?:\/(pty-log))?\/?$/);
    if (!match) return;
    const lookup = lookupTerminalSession(deps.runsDir(), match[1]!);
    return lookup.status === 'missing' ? undefined : { lookup, log: match[2] === 'pty-log', url: url! };
  }
  function legacyAllowed(req: IncomingMessage, url: URL, record: TerminalSessionIndexRecord) {
    const tokens = url.searchParams.getAll('viewToken');
    return req.method === 'GET' && tokens.length === 1 && [...url.searchParams.keys()].every(key => key === 'viewToken') &&
      originAllowed(req) && verifyTerminalReadCapability(record, tokens[0]!);
  }
  async function target(req: IncomingMessage, runId: string, session: WorkflowTerminalSession) {
    const result = terminalOnlyTarget(await deps.resolve(runId, session));
    for (const name of Object.keys(req.headers)) if (name.startsWith('x-botmux-')) delete req.headers[name];
    req.url = `/?viewToken=${encodeURIComponent(session.viewToken)}`;
    return result;
  }
  function track(req: IncomingMessage, connection: ServerResponse | Duplex) {
    const unbind = deps.bind?.(req, () => connection.destroy());
    if (unbind) connection.once('close', unbind);
  }
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
  return {
    async legacyHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const match = legacyRoute(req); if (!match) return false;
      if (match.lookup.status !== 'ready' || !legacyAllowed(req, match.url, match.lookup.record)) {
        res.writeHead(403, headers); res.end('Workflow terminal access denied'); return true;
      }
      let record: SessionRecord | undefined;
      try { record = await workflowTerminalForSession(deps.runsDir(), match.lookup.record, match.url.searchParams.get('viewToken')!); } catch { /* Fail closed. */ }
      if (!record) { res.writeHead(410, headers); res.end('Workflow terminal unavailable'); return true; }
      if (match.log || !record.live) {
        if (!record.logPath) { res.writeHead(410, headers); res.end('任务已结束，未保存终端日志'); return true; }
        if (match.log) {
          // Pin the leaf without following a link and cap the snapshot end too:
          // concurrent log growth must not turn a 4 MiB tail into an unbound stream.
          let fd: number | undefined;
          try {
            fd = openSync(record.logPath, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
            const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1) throw Error('unsafe_terminal_log');
            const size = stat.size, start = Math.max(0, size - 4 * 1024 * 1024);
            res.writeHead(200, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'x-botmux-log-bytes': String(size),
              'x-botmux-served-bytes': String(size - start), 'x-botmux-truncated': start ? '1' : '0' });
            if (!size) { closeSync(fd); fd = undefined; res.end(); return true; }
            const stream = createReadStream(record.logPath, { fd, start, end: size - 1, autoClose: true }); fd = undefined;
            stream.on('error', () => res.destroy()); res.once('close', () => stream.destroy()); stream.pipe(res);
          } catch { if (fd !== undefined) closeSync(fd); if (!res.headersSent) res.writeHead(410, headers); res.end(); }
          return true;
        }
        const endpoint = `/s/${record.sessionId}/pty-log?viewToken=${encodeURIComponent(record.viewToken)}`;
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
        res.end(buildReplayTerminalSrcdoc(endpoint, `${record.runId} / 终端回放`)); return true;
      }
      try { proxyHttp(req, res, await target(req, record.runId, record)); }
      catch { res.writeHead(502, headers); res.end('Workflow terminal unavailable'); }
      return true;
    },
    async legacyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
      const match = legacyRoute(req); if (!match) return false;
      const deny = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      if (match.log || match.lookup.status !== 'ready' || !legacyAllowed(req, match.url, match.lookup.record)) { deny(); return true; }
      try {
        const record = await workflowTerminalForSession(deps.runsDir(), match.lookup.record, match.url.searchParams.get('viewToken')!);
        if (!record?.live) { deny(); return true; }
        proxyUpgrade(req, socket, head, await target(req, record.runId, record));
      } catch { socket.destroy(); }
      return true;
    },
    async http(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const match = route(req); if (!match) return false;
      if (!allowed(req, match.url)) { res.writeHead(403, headers); res.end('Workflow terminal access denied'); return true; }
      try {
        const session = await liveWorkflowTerminal(deps.runsDir(), match.runId, match.nodeId);
        if (!session) throw Error('workflow_terminal_unavailable');
        track(req, res); proxyHttp(req, res, await target(req, match.runId, session));
      } catch { res.writeHead(409, headers); res.end('Workflow terminal is no longer running'); }
      return true;
    },
    async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
      const match = route(req); if (!match) return false;
      if (!allowed(req, match.url)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return true; }
      try {
        const session = await liveWorkflowTerminal(deps.runsDir(), match.runId, match.nodeId);
        if (!session) throw Error('workflow_terminal_unavailable');
        track(req, socket); proxyUpgrade(req, socket, head, await target(req, match.runId, session));
      } catch { socket.destroy(); }
      return true;
    },
  };
}
