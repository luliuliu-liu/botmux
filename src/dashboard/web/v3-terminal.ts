/**
 * Per-node terminal panel for the v3 dashboard.
 *
 * Input contract is deliberately small and safe:
 *   - no worker write token
 *   - no raw filesystem path
 *   - replay fetches the cookie-auth `/api/v3/.../pty-log` endpoint
 */
import type { RunNodeView } from '../../workflows/v3/ops-projection.js';
import { XTERM_VENDOR_ASSETS, xtermVendorRootUrl } from '../../core/xterm-vendor-assets.js';

export type NodeTerminalRenderKind = 'live' | 'replay' | 'empty';

export interface NodeTerminalRender {
  kind: NodeTerminalRenderKind;
  signature: string;
  html: string;
}

/** Signature of a node's terminal-relevant inputs. React keeps the iframe DOM
 *  mounted across polling ticks unless this value, prefixed by node id, changes. */
export function nodeTerminalSignature(node: RunNodeView): string {
  const wt = node.webTerminal;
  return `${wt?.status ?? '-'}|${wt?.sessionId ?? '-'}|${wt?.webPort ?? '-'}|${node.hasPtyLog ? '1' : '0'}`;
}

export function renderNodeTerminal(container: HTMLElement, runId: string, node: RunNodeView): void {
  container.setAttribute('data-run-id', runId);
  container.setAttribute('data-node-id', node.id);
  container.innerHTML = buildNodeTerminalRender(runId, node).html;
}

export function buildNodeTerminalRender(
  runId: string,
  node: RunNodeView,
  options: { host?: string } = {},
): NodeTerminalRender {
  const signature = nodeTerminalSignature(node);

  const wt = node.webTerminal;
  if (wt?.status === 'live' && wt.webPort && wt.webPort > 0) {
    return { kind: 'live', signature, html: liveTerminalHtml(runId, node.id) };
  }

  if (node.hasPtyLog) {
    return { kind: 'replay', signature, html: replayTerminalHtml(runId, node.id, wt?.status === 'closed') };
  }

  const message = wt?.status === 'live' ? '终端正在启动，稍后刷新' : '暂无终端记录';
  return { kind: 'empty', signature, html: emptyTerminalHtml(message) };
}

function liveTerminalHtml(runId: string, nodeId: string): string {
  const url = `/api/v3/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/terminal/`;
  return `<div class="v3-terminal-panel">
    <div class="v3-terminal-head">
      <span class="v3-terminal-dot live"></span>
      <span>实时终端（只读）</span>
      <a class="btn-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">新窗口打开</a>
    </div>
    <iframe class="v3-terminal-frame" src="${escapeAttr(url)}" title="v3 live terminal" loading="lazy"></iframe>
  </div>`;
}

function replayTerminalHtml(runId: string, nodeId: string, closed: boolean): string {
  const endpoint = `/api/v3/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/pty-log`;
  const replayUrl = `/api/v3/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/terminal-replay`;
  const srcdoc = buildReplayTerminalSrcdoc(endpoint, `${runId} / ${nodeId}`);
  return `<div class="v3-terminal-panel">
    <div class="v3-terminal-head">
      <span class="v3-terminal-dot ${closed ? 'closed' : 'replay'}"></span>
      <span>${closed ? '终端回放' : '终端记录'}</span>
      <span class="muted">PTY log</span>
      <a class="btn-link" href="${escapeAttr(replayUrl)}" target="_blank" rel="noopener">打开终端回放</a>
      <a class="btn-link" href="${escapeAttr(endpoint)}" target="_blank" rel="noopener">下载/打开原始日志</a>
    </div>
    <iframe class="v3-terminal-frame" srcdoc="${escapeAttr(srcdoc)}" title="v3 terminal replay" loading="lazy"></iframe>
  </div>`;
}

function emptyTerminalHtml(message: string): string {
  return `<div class="v3-terminal-empty muted">${escapeHtml(message)}</div>`;
}

export function liveTerminalUrl(webPort: number, host?: string, sessionId?: string): string {
  // The dashboard owns `/s/<session>` on HTTP as well as HTTPS. Keeping this
  // same-origin avoids requiring LAN clients to reach the ephemeral web port.
  if (sessionId && typeof window !== 'undefined') {
    return `${window.location.origin}/s/${encodeURIComponent(sessionId)}`;
  }
  return `http://${host ?? browserHost()}:${webPort}/`;
}

function browserHost(): string {
  return typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname || '127.0.0.1';
}

/** Same-origin dashboard assets (copied by scripts/build-dashboard.mjs). The
 * replay must work without internet access, so it never loads xterm from a CDN;
 * if the assets are missing it still falls back to plain text below. */

/** Boundaries after synchronized full-screen updates; older TUIs may instead
 * start each repaint by homing the cursor. Offsets leave the PTY bytes intact. */
export function replayFrameEnds(text: string): number[] {
  const ends: number[] = [];
  const sync = /\x1b\[\?([0-9;]+)l/g;
  let match: RegExpExecArray | null;
  while ((match = sync.exec(text))) {
    if (match[1]!.split(';').includes('2026')) ends.push(sync.lastIndex);
  }
  if (!ends.length) {
    const home = /\x1b\[(?:1;1|1|)H/g;
    while ((match = home.exec(text))) if (match.index > 0) ends.push(match.index);
  }
  if (ends[ends.length - 1] !== text.length) ends.push(text.length);
  if (ends.length <= 10000) return ends;
  const sampled: number[] = [], step = Math.ceil(ends.length / 9999);
  for (let i = 0; i < ends.length; i += step) sampled.push(ends[i]!);
  if (sampled[sampled.length - 1] !== text.length) sampled.push(text.length);
  return sampled;
}

export function buildReplayTerminalSrcdoc(endpoint: string, title: string): string {
  const endpointJson = JSON.stringify(endpoint);
  const titleText = escapeHtml(title);
  // xterm 由 Dashboard 自己在根路径下提供（#1940 固定的 5.5.0 组），不走外部 CDN。
  // srcdoc 文档的相对地址按父页面（Dashboard，总在源站根路径）解析，与下面 fetch 的
  // `/api/v3/…` 同理。
  const css = escapeAttr(xtermVendorRootUrl(XTERM_VENDOR_ASSETS.css));
  const xtermJs = escapeAttr(xtermVendorRootUrl(XTERM_VENDOR_ASSETS.xterm));
  const fitJs = escapeAttr(xtermVendorRootUrl(XTERM_VENDOR_ASSETS.fit));
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${titleText}</title>
  <link rel="stylesheet" href="${css}">
  <style>
    html,body{margin:0;height:100%;background:#0d1117;color:#c9d1d9;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
    #bar{height:31px;display:flex;align-items:center;gap:10px;padding:0 10px;background:#161b22;border-bottom:1px solid #30363d;box-sizing:border-box}
    #bar>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #status{margin-left:auto;color:#8b949e;white-space:nowrap}
    #history{display:flex;align-items:center;gap:6px;padding:4px 8px;min-height:34px;box-sizing:border-box;background:#161b22;flex-wrap:wrap}
    #history[hidden]{display:none}
    #history input{flex:1;min-width:80px}
    #history button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px 8px;cursor:pointer}
    body{display:flex;flex-direction:column;overflow:hidden}
    #bar{flex:none}
    #term{flex:1;min-height:0;padding:4px;box-sizing:border-box;overflow:auto;touch-action:pan-y}
    body.history-mode #term{touch-action:none}
    a{color:#58a6ff;text-decoration:none}
  </style>
</head>
<body>
  <div id="bar"><span>${titleText}</span><span id="status">loading...</span></div>
  <div id="history" hidden><span>屏幕历史</span><button id="history-first" type="button">最早</button><button id="history-prev" type="button">上一屏</button><input id="history-position" type="range" min="0" value="0" aria-label="历史屏幕位置"><button id="history-next" type="button">下一屏</button><button id="history-last" type="button">最新</button><span id="history-label" aria-live="polite"></span></div>
  <div id="term" tabindex="0" aria-label="终端回放，可上下浏览"></div>
  <script src="${xtermJs}"><\/script>
  <script src="${fitJs}"><\/script>
  <script>
  (function(){
    var endpoint=${endpointJson};
    // v3 ephemeral workers spawn their PTY at DEFAULT_RENDER_COLS (=160, see
    // worker.ts) and never adopt, so the captured stream's TUI / box-drawing
    // is exactly 160 cols wide.  Fitting it into a narrower (or oddly-measured)
    // grid re-wraps those fixed-width lines into a stair-stepped mess and
    // wastes the panel.  So we render at the capture width and let FitAddon
    // only size the ROW count to the iframe height (cols pinned back to 160).
    var COLS=160;
    var frameEnds=${replayFrameEnds.toString()};
    var status=document.getElementById('status');
    var termEl=document.getElementById('term');
    if(!window.Terminal){
      termEl.style.whiteSpace='pre-wrap';
      fetch(endpoint,{credentials:'include'}).then(function(res){if(!res.ok)throw new Error('HTTP '+res.status);return res.text();}).then(function(text){termEl.textContent=text;status.textContent='终端文本记录';}).catch(function(err){status.textContent='加载失败: '+err.message;});
      return;
    }
    var term=new Terminal({
      cols:COLS,
      convertEol:false,
      scrollback:100000,
      fontSize:13,
      disableStdin:true,
      allowProposedApi:true,
      theme:{background:'#0d1117',foreground:'#c9d1d9',cursor:'#c9d1d9'}
    });
    var fit=null;
    if(window.FitAddon){fit=new window.FitAddon.FitAddon();term.loadAddon(fit);}
    term.open(termEl);
    function doFit(){
      try{if(fit)fit.fit()}catch(_){}
      if(term.cols!==COLS)term.resize(COLS,term.rows||24);
    }
    doFit(); window.addEventListener('resize',doFit);
    var source='',frames=[],position=0,rendered=-1,rendering=false,history=false;
    var slider=document.getElementById('history-position');
    function paintHistory(){
      if(rendering||position===rendered)return;
      var target=position;rendering=true;term.reset();
      term.write(source.slice(0,frames[target]),function(){
        rendered=target;rendering=false;doFit();
        document.getElementById('history-label').textContent=(rendered+1)+' / '+frames.length;
        slider.value=String(position);
        paintHistory();
      });
    }
    function seek(next){position=Math.max(0,Math.min(frames.length-1,next));slider.value=String(position);paintHistory();}
    slider.addEventListener('input',function(){seek(Number(slider.value));});
    document.getElementById('history-first').onclick=function(){seek(0);};
    document.getElementById('history-prev').onclick=function(){seek(position-1);};
    document.getElementById('history-next').onclick=function(){seek(position+1);};
    document.getElementById('history-last').onclick=function(){seek(frames.length-1);};
    termEl.addEventListener('wheel',function(event){
      if(!history||!event.deltaY)return;
      event.preventDefault();event.stopPropagation();
      var delta=event.deltaMode===1?event.deltaY*16:event.deltaMode===2?event.deltaY*termEl.clientHeight:event.deltaY;
      seek(position+(delta>0?1:-1)*Math.max(1,Math.round(Math.abs(delta)/40)));
    },{capture:true,passive:false});
    var touchY=null;
    termEl.addEventListener('touchstart',function(event){if(history&&event.touches.length===1)touchY=event.touches[0].clientY;},{passive:true});
    termEl.addEventListener('touchmove',function(event){
      if(!history||touchY===null||event.touches.length!==1)return;
      event.preventDefault();event.stopPropagation();
      var delta=touchY-event.touches[0].clientY;
      if(Math.abs(delta)>=20){seek(position+(delta>0?1:-1)*Math.max(1,Math.floor(Math.abs(delta)/20)));touchY=event.touches[0].clientY;}
    },{capture:true,passive:false});
    termEl.addEventListener('touchend',function(){touchY=null;},{passive:true});
    termEl.addEventListener('keydown',function(event){
      if(!history)return;
      var next=event.key==='Home'?0:event.key==='End'?frames.length-1:event.key==='ArrowUp'?position-1:event.key==='ArrowDown'?position+1:event.key==='PageUp'?position-20:event.key==='PageDown'?position+20:null;
      if(next!==null){event.preventDefault();event.stopPropagation();seek(next);}
    },true);
    fetch(endpoint,{credentials:'include'}).then(function(res){
      if(!res.ok){
        if(res.status===401){status.textContent='需要登录 dashboard 后查看回放';}
        else if(res.status===404){status.textContent='没有 PTY 日志';}
        else{status.textContent='加载失败 HTTP '+res.status;}
        return null;
      }
      var total=Number(res.headers.get('x-botmux-log-bytes')||0);
      var served=Number(res.headers.get('x-botmux-served-bytes')||0);
      var truncated=res.headers.get('x-botmux-truncated')==='1';
      status.textContent=truncated
        ? 'showing tail '+formatBytes(served)+' / '+formatBytes(total)
        : 'loaded '+formatBytes(total);
      return res.arrayBuffer();
    }).then(function(buf){
      if(!buf)return;
      source=new TextDecoder().decode(buf);
      term.write(source,function(){
        doFit();frames=frameEnds(source);
        // Alternate-screen TUIs never populate xterm's normal scrollback.
        // Re-render a selected prefix instead of sending dead arrow keys to a
        // finished process. Ordinary line-oriented logs retain native scrolling.
        history=frames.length>1&&(term.buffer.active.type==='alternate'||term.buffer.active.baseY===0&&source.indexOf(String.fromCharCode(27)+'[?2026')>=0);
        if(history){
          document.body.classList.add('history-mode');document.getElementById('history').hidden=false;
          slider.max=String(frames.length-1);position=rendered=frames.length-1;slider.value=String(position);
          document.getElementById('history-label').textContent=frames.length+' / '+frames.length;
          termEl.setAttribute('aria-label','全屏终端历史，用滚轮、触摸或方向键浏览');doFit();
        }
      });
    }).catch(function(err){
      status.textContent='加载失败: '+(err&&err.message?err.message:String(err));
    });
    function formatBytes(n){
      if(!Number.isFinite(n)||n<=0)return '0 B';
      var u=['B','KiB','MiB','GiB'];var i=0;
      while(n>=1024&&i<u.length-1){n/=1024;i++;}
      return (i===0?String(n):n.toFixed(1))+' '+u[i];
    }
  })();
  <\/script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, '&#96;');
}
