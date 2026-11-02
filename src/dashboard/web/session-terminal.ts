export interface SessionTerminalLocation {
  protocol: string;
  origin: string;
  hostname: string;
}

function currentLocation(): SessionTerminalLocation | null {
  return typeof window === 'undefined' ? null : window.location;
}

export function sessionTerminalHref(s: any, loc: SessionTerminalLocation | null = currentLocation()): string | null {
  // riff：只读入口对齐飞书卡片语义 —— 「Web终端=日志页」走本地 worker 端口的
  // 只读日志视图，而不是 riffAccessUrl。riffAccessUrl 是 AIO Sandbox 的**可写**
  // capability（bearer URL，见 riff-backend.ts:hashUrlForLog「the unique subdomain
  // IS the write capability」），只能经鉴权的 /write-link（🔑「操作链接=AIO」）下发。
  // 若在此短路返回它，只读图标会打开可写沙箱、且匿名只读面板也会拿到写能力 ——
  // 故这里一律走 webPort 分支，让读/写入口与卡片侧一一对应。
  if (!s?.webPort || !loc) return null;
  // Isolated Worker origins expose only the authenticated Dashboard port,
  // including on HTTP localhost. Native /s/ handles its internal terminal hop.
  if (/^w-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\./.test(loc.hostname)) {
    return `${loc.origin}/s/${encodeURIComponent(s.sessionId)}`;
  }
  // The dashboard front proxy authenticates and bridges `/s/<session>` on both
  // HTTP and HTTPS. Prefer it whenever the daemon proxy is registered: an HTTP
  // LAN browser then needs only the dashboard port, rather than a separately
  // exposed per-daemon proxy port.
  if (s.proxyPort) return `${loc.origin}/s/${encodeURIComponent(s.sessionId)}`;
  // HTTPS platform hosts expose only their main reverse-proxy port; never emit
  // an unreachable raw worker port when the daemon proxy is not registered.
  if (loc.protocol === 'https:') return null;
  const port = s.proxyPort ?? s.webPort;
  return `http://${loc.hostname}:${port}`;
}
