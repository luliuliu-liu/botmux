import { cliAuthBind, signCliAuth } from '../dashboard/auth.js';
import { loopbackFetchImpl } from '../core/loopback-fetch.js';
import {WORKFLOW_CHAT_GRANT_PATH,type WorkflowLaunchGrantLease} from '../core/workflow-grant-protocol.js';

export interface ExactChatGrantDaemon {
  ipcPort: number;
  larkAppId: string;
}

export interface ExactChatGrantClientInput {
  daemon: ExactChatGrantDaemon;
  secret: string;
  receiverLarkAppId: string;
  chatId: string;
  operation?: 'grant' | 'revoke' | 'readback' | 'resolve';
  subjectOpenIds?: string[];
  subjectLarkAppIds?: string[];
  workflowLease?: WorkflowLaunchGrantLease;
}

export class ExactChatGrantClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ExactChatGrantClientError';
  }
}

/**
 * Call a receiver daemon's HMAC-protected exact-grant endpoint.
 *
 * `subjectLarkAppIds` is resolved inside the receiver daemon so app-scoped
 * open_ids never cross receiver boundaries. The endpoint still performs a
 * live membership check before persisting the talk-only grant.
 */
export async function requestExactChatGrant(
  input: ExactChatGrantClientInput,
  fetchImpl: typeof fetch = loopbackFetchImpl,
): Promise<Record<string, any>> {
  if (input.daemon.larkAppId !== input.receiverLarkAppId) {
    throw new ExactChatGrantClientError('receiver daemon mismatch');
  }
  if(input.workflowLease&&(!['grant','revoke'].includes(input.operation??'grant')||input.subjectOpenIds||input.subjectLarkAppIds))throw new ExactChatGrantClientError('invalid workflow lease request');
  const path = input.workflowLease?WORKFLOW_CHAT_GRANT_PATH:'/api/grants/chat';
  const { ts, nonce, sig } = signCliAuth(
    input.secret,
    cliAuthBind('POST', path, input.daemon.ipcPort),
  );
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${input.daemon.ipcPort}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Botmux-Cli-Ts': ts,
        'X-Botmux-Cli-Nonce': nonce,
        'X-Botmux-Cli-Auth': sig,
      },
      body: JSON.stringify({
        operation: input.operation ?? 'grant',
        receiverLarkAppId: input.receiverLarkAppId,
        chatId: input.chatId,
        ...(input.workflowLease?{leaseId:input.workflowLease.leaseId,subjectOpenId:input.workflowLease.subjectOpenId}:{
          ...(input.subjectOpenIds ? { subjectOpenIds: input.subjectOpenIds } : {}),
          ...(input.subjectLarkAppIds ? { subjectLarkAppIds: input.subjectLarkAppIds } : {}),
        }),
      }),
    });
  } catch (err: any) {
    throw new ExactChatGrantClientError(`receiver daemon unavailable: ${err?.message ?? err}`);
  }

  const raw = await response.text();
  let body: Record<string, any>;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { ok: false, error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok || body.ok !== true) {
    throw new ExactChatGrantClientError(
      typeof body.message === 'string' ? body.message : `exact chat grant failed (HTTP ${response.status})`,
      response.status,
      body,
    );
  }
  if(input.workflowLease&&(body.workflowLeaseFenced!==true||body.leaseId!==input.workflowLease.leaseId||body.subjectOpenId!==input.workflowLease.subjectOpenId||body.receiverLarkAppId!==input.receiverLarkAppId||body.chatId!==input.chatId||body.leaseActive!==(input.operation!=='revoke')||input.operation!=='revoke'&&body.grantsTalk!==true))throw new ExactChatGrantClientError('workflow receiver did not confirm lease fencing',response.status);
  return body;
}

export interface BotChatGrantMatrixDeps {
  findDaemon(larkAppId: string): ExactChatGrantDaemon | null;
  /** A function is called once, right before the first receiver that has
   * something to write — a matrix with nothing to write never reads it. */
  secret: string | (() => string);
  /** Write only the receiver ← subject pairs this returns true for; omitted =
   * every pair. A receiver left with no subject is skipped entirely: its
   * daemon is neither looked up nor called. */
  needsGrant?(receiverLarkAppId: string, subjectLarkAppId: string): boolean;
  request?: typeof requestExactChatGrant;
  retryDelaysMs?: number[];
}

export interface BotChatGrantMatrixResult {
  ok: true;
  chatId: string;
  participants: string[];
  receivers: Array<{ receiverLarkAppId: string; subjectLarkAppIds: string[] }>;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Establish a full-mesh, talk-only grant matrix for local bots in one chat
 * (minus the pairs `needsGrant` rules out). Every receiver resolves the other
 * stable app ids in its own Lark namespace. The operation is idempotent; any
 * unresolved/offline receiver that has something to write fails closed.
 */
export async function ensureBotChatGrantMatrix(
  chatId: string,
  rawParticipantAppIds: string[],
  deps: BotChatGrantMatrixDeps,
): Promise<BotChatGrantMatrixResult> {
  const participants = [...new Set(rawParticipantAppIds.map(value => value.trim()).filter(Boolean))];
  if (participants.length < 2) {
    return { ok: true, chatId, participants, receivers: [] };
  }
  const request = deps.request ?? requestExactChatGrant;
  const retryDelays = deps.retryDelaysMs ?? [250, 750, 1_500];
  const receivers: BotChatGrantMatrixResult['receivers'] = [];
  let secret: string | undefined;

  for (const receiverLarkAppId of participants) {
    const subjectLarkAppIds = participants.filter(appId => appId !== receiverLarkAppId
      && (deps.needsGrant?.(receiverLarkAppId, appId) ?? true));
    if (subjectLarkAppIds.length === 0) continue;
    secret ??= typeof deps.secret === 'function' ? deps.secret() : deps.secret;
    const daemon = deps.findDaemon(receiverLarkAppId);
    if (!daemon) {
      throw new ExactChatGrantClientError(`receiver daemon offline: ${receiverLarkAppId}`);
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        await request({
          daemon,
          secret,
          operation: 'grant',
          receiverLarkAppId,
          chatId,
          subjectLarkAppIds,
        });
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < retryDelays.length) await delay(retryDelays[attempt]);
      }
    }
    if (lastError) throw lastError;
    receivers.push({ receiverLarkAppId, subjectLarkAppIds });
  }

  return { ok: true, chatId, participants, receivers };
}
