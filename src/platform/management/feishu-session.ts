import { statSync } from 'node:fs';
import {
  botmuxFeishuSessionFilePath, inspectCachedFeishuOpenPlatformSession,
  readStoredCookiesFromSessionFile,
} from '../../setup/open-platform-automation.js';

export interface FeishuSessionStatus {
  status: 'ready' | 'missing' | 'expired' | 'unknown';
  checkedAt: number;
  /** Administrator display projection, never credentials or app-scoped IDs. */
  identity?: { userName: string; tenantName: string; email?: string };
}

/** Read-only, machine-wide health projection. Never start QR login, fall back
 * to another account, or return cookies/internal identity IDs to the browser. */
export function createFeishuSessionReader(options: {
  sessionFile?: string;
  inspect?: typeof inspectCachedFeishuOpenPlatformSession;
  now?: () => number;
} = {}) {
  const file = options.sessionFile ?? botmuxFeishuSessionFilePath();
  const inspect = options.inspect ?? inspectCachedFeishuOpenPlatformSession;
  const now = options.now ?? Date.now;
  let cached: { stamp: string; value: FeishuSessionStatus } | undefined;
  let pending: { stamp: string; value: Promise<FeishuSessionStatus> } | undefined;
  return async (force = false): Promise<FeishuSessionStatus> => {
    let stamp = 'missing';
    try { const stat = statSync(file); stamp = `${stat.mtimeMs}/${stat.size}`; } catch { /* missing/unreadable is not authenticated */ }
    if (!force && cached?.stamp === stamp && now() - cached.value.checkedAt < 30_000) return cached.value;
    if (pending?.stamp === stamp) return pending.value;
    const check = async (): Promise<FeishuSessionStatus> => {
      let status: FeishuSessionStatus['status'];
      let identity: FeishuSessionStatus['identity'];
      if (stamp === 'missing') status = 'missing';
      else if (!readStoredCookiesFromSessionFile(file)?.length) status = 'expired';
      else {
        try {
          let networkFailed = false;
          const result = await inspect({sessionFilePath:file, fetchImpl: (async (input, init) => {
            try {
              const response = await fetch(input, {...init, signal:AbortSignal.timeout(8000)});
              if(response.status >= 500) networkFailed = true;
              return response;
            } catch(error) { networkFailed = true; throw error; }
          }) as typeof fetch});
          status = networkFailed ? 'unknown' : result.ok ? 'ready' : ['invalid_session','missing_csrf'].includes(result.reason) ? 'expired' : 'unknown';
          if(status === 'ready' && result.ok){
            // Explicit allowlist: do not spread the upstream identity/session.
            identity = {userName:result.identity.userName, tenantName:result.identity.tenantName,
              ...(result.identity.email?.trim() ? {email:result.identity.email.trim()} : {})};
          }
        } catch { status = 'unknown'; }
      }
      const value: FeishuSessionStatus = {status, checkedAt:now(), ...(identity ? {identity} : {})};
      cached = {stamp, value};
      return value;
    };
    const current = {stamp, value:check()}; pending = current;
    try { return await current.value; }
    finally { if(pending === current) pending = undefined; }
  };
}
