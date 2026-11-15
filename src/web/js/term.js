/* sbridge · 内嵌终端：节点级 PTY 挂载、输入通道、终端状态 */

/* ---------------- 内嵌终端 ---------------- */

/* xterm 按需加载：工作轨迹是首屏，终端只在用户切到终端时才需要。
   启动阶段不再解析 500KB 的 xterm.js，首屏更快。 */
let xtermLoading = null;
function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (xtermLoading) return xtermLoading;
  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`终端组件加载失败: ${src}`));
    document.head.appendChild(s);
  });
  xtermLoading = Promise.all([loadScript('/vendor/xterm.js'), loadScript('/vendor/addon-fit.js')])
    .then(() => {
      if (!window.Terminal || !window.FitAddon) throw new Error('终端组件加载失败');
    }).catch(err => { xtermLoading = null; throw err; });
  return xtermLoading;
}

async function refreshTerms() {
  try { state.terms = (await api('/api/terms')).terms; } catch { /* 服务未起时忽略 */ }
}

/* 终端状态变化后立刻同步「顶部标签页 + 侧栏会话链 + 白板」的绿点：
   之前只有 8s 定时刷新 renderBoard（顺带 mini-chain），标签页要等下一次显式 renderTabs
   才更新——所以会出现「左边有绿点、上面标签没有」的短暂不同步。 */
function refreshTermIndicators() {
  return refreshTerms().then(() => {
    try { renderTabs(); } catch { /* 任务未就绪 */ }
    try { renderBoard(); } catch { /* ignore */ }
  }).catch(() => {});
}

/* 该节点「自己」的运行中终端：节点级绑定（nodeTermBindings / node.termId）+ 服务端记录的
   term.nodeId 归属。禁止用 cwd+tool 回退——同一目录同工具的多个会话（例如 huabu 下 4 个
   Claude 会话）会全部挂到同一个 PTY，切到终端后四个面板显示同一份内容。 */
function nodeTermFor(node) {
  const terms = state.terms || [];
  const tid = nodeTermBindings.get(node.id) || node.termId || null;
  if (tid) {
    const bound = terms.find((t) => t.running && t.id === tid);
    if (bound) return bound;
  }
  return terms.find((t) => t.running && t.nodeId === node.id) || null;
} 
function boundRunningTerm(node) { return nodeTermFor(node); }

/* ConPTY 与 xterm 的本地 reflow 存在 1 行偏差：宽度变化（最大化/拖宽）时，xterm 会先在
   fit.fit() 里同步重排出一份「旧一行」的中间态，随后 ConPTY 的权威重绘（重发可见屏原始行）
   又纠正回来，用户因此看到「先上滚一下再滚回底部」。把 backend 标为非 conpty，可关闭 xterm
   本地 reflow 与 Windows wrapping heuristics，让 ConPTY 重绘作为唯一权威来源，消除中间跳变。
   POSIX / 未知后端保持默认行为。 */
function xtermPtyOption(p) {
  if (p && p.backend === 'conpty') return { ...p, backend: 'winpty' };
  return p || {};
}

/* 把原始终端挂进指定容器（面板「⌨」切换用；agent 进程挂在服务上，关页面不中断） */
async function mountTerm(hostEl, node, retries = 0, hooks = {}) {
  // 跨任务分屏：终端服务的任务归属跟着会话走，不能假定是 currentTask
  const ownerTaskId = () => hooks?.taskId || (typeof taskIdForNode === 'function' ? taskIdForNode(node.id) : null) || currentTask.id;
  const taskId = ownerTaskId();
  const startedAt = performance.now();
  const viewEl = hostEl.closest('.term-view');
  const loadingEl = viewEl?.querySelector('[data-role="termloading"]');
  const bottomBtn = viewEl?.querySelector('[data-role="termbottom"]');
  const historyBtn = viewEl?.querySelector('[data-role="termhistory"]');
  if (loadingEl) { loadingEl.hidden = false; loadingEl.textContent = `正在连接 ${toolLabel(node.tool)} 终端…`; }
  await loadXterm();
  if (!hostEl.isConnected) return null;
  hostEl.innerHTML = '';
  let term = nodeTermFor(node);
  const t = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace',
    fontSize: 15, lineHeight: 1.2, fontWeight: 'normal', fontWeightBold: 'bold', letterSpacing: 0,
    cursorBlink: true, scrollback: 5000, theme: theme.xtermTheme(),
    windowsPty: xtermPtyOption(term?.windowsPty),
  });
  const fit = new FitAddon.FitAddon();
  t.loadAddon(fit);
  t.open(hostEl);
  fit.fit();
  // 先测量真实行列，再启动 PTY，避免先按 100×30 输出、随后立即清屏重画。
  let lastSentSize = term?.cols && term?.rows ? { cols: term.cols, rows: term.rows } : null;
  try {
    if (!term) {
      if (loadingEl) loadingEl.textContent = `正在启动 ${toolLabel(node.tool)}…`;
      const r = await api(`/api/tasks/${taskId}/term`, {
        method: 'POST',
        body: { tool: node.tool, cwd: node.cwd || undefined, resumeCommand: node.resumeCommand || undefined,
          file: node.file || undefined, label: toolLabel(node.tool), nodeId: node.id, cols: t.cols, rows: t.rows },
      });
      term = { id: r.termId, nodeId: node.id, tool: node.tool, running: true,
        cols: r.cols, rows: r.rows, windowsPty: r.windowsPty };
      state.terms = [...(state.terms || []).filter(v => v.id !== term.id), term];
      if (r.cols && r.rows) lastSentSize = { cols: r.cols, rows: r.rows };
    }
  } catch (err) {
    t.dispose(); hostEl.innerHTML = '';
    if (loadingEl) loadingEl.hidden = true;
    throw err;
  }
  // 必须在 WS 回放前应用真实 PTY 信息：未知后端增高会先拉回历史，再被 ConPTY 重画。
  // 新建 / POST 复用时只能等响应；此时 xterm 尚未写入数据。POSIX 保留默认行为。
  t.options.windowsPty = xtermPtyOption(term.windowsPty);
  nodeTermBindings.set(node.id, term.id);
  theme.liveTerms.add(t);
  window.__sbTerms = window.__sbTerms || new Set();
  window.__sbTerms.add(t);
  window.__sbLastMountTerm = t;
  const timing = window.__sbLastMount = { id: term.id, node: node.id, at: Date.now(), connectMs: Math.round(performance.now() - startedAt) };
  let termDisposed = false, followBottom = true, resizing = false, writing = false;
  let scrollUiFrame = 0, resizeTimer = 0, dialogTimer = 0, reconnectTimer = 0;
  let gotTermData = false, dialogReported = false;
  const isAtBottom = () => t.buffer.active.viewportY >= t.buffer.active.baseY;
  const syncFollow = () => { followBottom = isAtBottom(); };
  const syncScrollUi = () => {
    scrollUiFrame = 0;
    if (termDisposed) return;
    const b = t.buffer.active;
    const hasScrollback = b.type === 'normal' && b.baseY > 0;
    viewEl?.classList.toggle('has-scrollback', hasScrollback);
    if (bottomBtn) bottomBtn.hidden = !hasScrollback || isAtBottom();
    if (historyBtn) historyBtn.hidden = hasScrollback || b.type === 'alternate' || !node.file;
    if (loadingEl && !loadingEl.hidden) {
      for (let row = b.baseY; row < b.baseY + t.rows; row++) {
        if (b.getLine(row)?.translateToString(true).trim()) {
          loadingEl.hidden = true;
          timing.contentMs ??= Math.round(performance.now() - startedAt);
          break;
        }
      }
    }
  };
  const scheduleScrollUi = () => {
    if (!termDisposed && !scrollUiFrame) scrollUiFrame = requestAnimationFrame(syncScrollUi);
  };
  // 回滚、屏幕切换及滚动条几何交给 xterm；不再缩小 scrollback 或模拟上下滚动。
  const scrollListener = t.onScroll(() => { if (!resizing && !writing) syncFollow(); scheduleScrollUi(); });
  const renderListener = t.onRender(scheduleScrollUi);
  const writeParsedListener = t.onWriteParsed(scheduleScrollUi);
  const wheelHandler = (e) => {
    if (e.ctrlKey || e.metaKey || !e.deltaY) return;
    if (t.modes.mouseTrackingMode !== 'none' && !e.shiftKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const amount = e.deltaMode === 1 ? Math.abs(e.deltaY) : e.deltaMode === 2 ? t.rows : Math.abs(e.deltaY) / 36;
    t.scrollLines(Math.sign(e.deltaY) * Math.max(1, Math.round(amount)));
    syncFollow(); scheduleScrollUi();
  };
  viewEl?.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/term/${term.id}`);
  const resizeToContainer = () => {
    resizeTimer = 0;
    if (termDisposed || !hostEl.isConnected || viewEl?.hidden || !hostEl.clientHeight || !hostEl.clientWidth) return;
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    const changed = dims.cols !== t.cols || dims.rows !== t.rows;
    const shouldFollow = followBottom;
    // 标记跟随 xterm 的行重排移动，缩放后保持用户正在阅读的历史位置。
    const b = t.buffer.active;
    const anchor = changed && !shouldFollow && b.type === 'normal'
      ? t.registerMarker(b.viewportY - b.baseY - b.cursorY) : null;
    resizing = true;
    try {
      if (changed) fit.fit();
      if (ws.readyState === 1 && (lastSentSize?.cols !== t.cols || lastSentSize?.rows !== t.rows)) {
        lastSentSize = { cols: t.cols, rows: t.rows };
        ws.send(JSON.stringify({ resize: lastSentSize }));
      }
      if (changed) {
        if (shouldFollow) t.scrollToBottom();
        else if (anchor && !anchor.isDisposed) t.scrollToLine(anchor.line);
      }
      if (changed && ws.readyState === 1) {
        // ConPTY 即将按新宽度重发可见屏与回滚历史：开缓冲窗把这段重绘攒成一次写入，
        // 不让「重画到一半」的中间帧上屏（用户看到的冒顶再滑底）。
        clearTimeout(pendingTimer);
        pendingData = '';
        pendingTimer = setTimeout(flushPending, RESIZE_BUFFER_MS);
      }
    } finally { anchor?.dispose(); resizing = false; followBottom = shouldFollow; }
    scheduleScrollUi();
  };
  // 最大化/拖动会同时触发窗口和容器事件；合并到一次实际尺寸变化，避免反复清屏。
  const scheduleResize = () => { clearTimeout(resizeTimer); if (!termDisposed) resizeTimer = setTimeout(resizeToContainer, 80); };
  ws.onopen = () => { timing.socketMs = Math.round(performance.now() - startedAt); resizeToContainer(); };
  window.addEventListener('resize', scheduleResize);
  const resizeObserver = new ResizeObserver(scheduleResize);
  resizeObserver.observe(hostEl);
  // 每块等待解析完成再写下一块，不让大段回放淹没渲染队列；不改变终端屏幕/历史。
  let writeChain = Promise.resolve();
  const writeBig = (data) => {
    writeChain = writeChain.then(async () => {
      if (termDisposed) return;
      writing = true;
      try {
        for (let offset = 0; offset < data.length && !termDisposed; offset += 64000) {
          await new Promise(resolve => t.write(data.slice(offset, offset + 64000), resolve));
        }
        if (!termDisposed && followBottom) t.scrollToBottom();
      } finally { writing = false; scheduleScrollUi(); }
    }).catch(() => {});
    return writeChain;
  };
  /* ConPTY 宽度重排的「补帧」治理：宽度变化（最大化/拖宽）时 ConPTY 会按新宽度把
     可见屏与回滚历史重发一遍（光标复位 + 逐行重画）。这段数据若照常流式写入，
     xterm 会把「重画到一半」的中间帧上屏——用户看到上面的对话涌出来再滑回底部。
     对策：resize 通知发出后开一个短暂缓冲窗，期间 WS 数据只攒不写；静默期一过
     （ConPTY 重绘结束）一次性交给 writeBig，中间帧永远不落屏。正常输出不受影响
     （窗口只在我们刚发过 resize 时才开启）。 */
  const RESIZE_BUFFER_MS = 160;
  let pendingData = '', pendingTimer = 0;
  const flushPending = () => {
    pendingTimer = 0;
    if (!pendingData || termDisposed) { pendingData = ''; return; }
    const chunk = pendingData; pendingData = '';
    writeBig(chunk);
  };
  const bufferOrWrite = (data) => {
    if (!pendingTimer) { writeBig(data); return; }
    pendingData += data;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flushPending, RESIZE_BUFFER_MS);
  };
  ws.onmessage = (e) => {
    const data = String(e.data).replaceAll('\u0000REPLAY_DONE\u0000', '');
    if (!data || termDisposed) return;
    gotTermData = true;
    timing.firstByteMs ??= Math.round(performance.now() - startedAt);
    if (/Enter to confirm|Esc to cancel/i.test(data)) {
      if (!dialogReported) { dialogReported = true; hooks.onTuiDialog?.(true); }
      clearTimeout(dialogTimer);
      dialogTimer = setTimeout(() => { dialogReported = false; hooks.onTuiDialog?.(false); }, 15000);
    }
    bufferOrWrite(data);
  };
  t.onData(d => { if (ws.readyState === 1) ws.send(d); });
  ws.onclose = () => {
    if (termDisposed || gotTermData || !hostEl.isConnected) return;
    if (retries >= 1) { if (loadingEl) loadingEl.hidden = true; toast('终端连接失效，请重新启动终端'); return; }
    nodeTermBindings.delete(node.id);
    if (node.termId === term.id) node.termId = null;
    state.terms = (state.terms || []).filter(v => v.id !== term.id);
    reconnectTimer = setTimeout(async () => {
      if (termDisposed || !hostEl.isConnected) return;
      handle.dispose();
      try { const next = await mountTerm(hostEl, node, retries + 1, hooks); if (next) Object.assign(handle, next); }
      catch (err) { toast(err.message); }
    }, 400);
  };
  /* 输入法候选框定位修正：系统 IME 的候选框锚定在键盘捕获层（helper textarea）上，
     xterm 把它放在「真实终端光标」处——但 pi 的 regular TUI 空闲时把真实光标放在
     状态行（右下角），视觉输入行（画出来的 ┃ 假光标）在它上面几行，候选框于是
     出现在状态行上。关键时序：IME 在第一个拼音键的 keydown 时就定位候选框，
     compositionstart 才挪已经晚了（实测仍跳右下角），所以 focus/keydown 时就挪，
     compositionupdate 期间保持，compositionend/blur 还原为 xterm 的值。 */
  const imeTa = t.textarea;
  let imeSaved = null;
  if (imeTa) {
    const imeCellH = () => {
      const r = imeTa.closest('.xterm').getBoundingClientRect();
      return r.height / t.rows;
    };
    const imeReposition = () => {
      try {
        const b = t.buffer.active;
        if (b.cursorY < t.rows - 1) return; // 光标本来就是输入位（shell 等），跟随即可
        const cellH = imeCellH();
        if (!(cellH > 0)) return;
        if (!imeSaved) imeSaved = { left: imeTa.style.left, top: imeTa.style.top };
        imeTa.style.left = '0px';
        imeTa.style.top = `${Math.max(0, Math.round((t.rows - 4) * cellH))}px`;
      } catch { /* ignore */ }
    };
    const imeRestore = () => {
      if (!imeSaved) return;
      try {
        imeTa.style.left = imeSaved.left;
        imeTa.style.top = imeSaved.top;
      } catch { /* ignore */ }
      imeSaved = null;
    };
    imeTa.addEventListener('focus', imeReposition);
    imeTa.addEventListener('keydown', imeReposition);
    imeTa.addEventListener('compositionstart', imeReposition);
    imeTa.addEventListener('compositionupdate', imeReposition);
    imeTa.addEventListener('compositionend', imeRestore);
    imeTa.addEventListener('blur', imeRestore);
  }
  t.attachCustomKeyEventHandler(ev => {
    if (ev.type !== 'keydown' || !ev.shiftKey) return true;
    if (ev.key === 'PageUp') { t.scrollPages(-1); syncFollow(); return false; }
    if (ev.key === 'PageDown') { t.scrollPages(1); syncFollow(); return false; }
    return true;
  });
  const handle = {
    id: term.id,
    refit: scheduleResize,
    focus() { if (!termDisposed && hostEl.getClientRects().length) t.focus(); },
    scrollToBottom() { followBottom = true; t.scrollToBottom(); scheduleScrollUi(); },
    dispose() {
      if (termDisposed) return;
      termDisposed = true;
      theme.liveTerms.delete(t); window.__sbTerms?.delete(t);
      resizeObserver.disconnect();
      viewEl?.removeEventListener('wheel', wheelHandler, true);
      window.removeEventListener('resize', scheduleResize);
      clearTimeout(resizeTimer); clearTimeout(dialogTimer); clearTimeout(reconnectTimer); clearTimeout(pendingTimer);
      if (scrollUiFrame) cancelAnimationFrame(scrollUiFrame);
      scrollListener.dispose(); renderListener.dispose(); writeParsedListener.dispose();
      ws.close(); t.dispose();
      hostEl.innerHTML = '';
      viewEl?.classList.remove('has-scrollback');
      if (bottomBtn) bottomBtn.hidden = true;
      if (historyBtn) historyBtn.hidden = true;
      if (loadingEl) loadingEl.hidden = true;
    },
  };
  return handle;
}

/* agent 输入通道：确保有活终端，把文字写进 PTY stdin */
const agentSockets = new Map(); // termId -> ws
const nodeTuiHandlers = new Map(); // nodeId → TUI 对话框回调（工作轨迹「终端」按钮脉冲）
// 每个会话节点专属的 PTY：分屏下多个会话常同目录同工具，若按 cwd 匹配共享 PTY，
// 发给 B 的消息会串进 A 的终端（B 的会话文件里没有，重开后内容凭空消失）。
// 节点级绑定：node.termId 有值优先用；没有就为该节点新起专属 PTY 并记录。
const nodeTermBindings = new Map(); // nodeId -> termId
async function sendToAgent(node, text, taskId = null) {
  const ownerTaskId = taskId || (typeof taskIdForNode === 'function' ? taskIdForNode(node.id) : null) || currentTask.id;
  let termId = nodeTermBindings.get(node.id) || node.termId || null;
  let term = termId ? (state.terms || []).find((x) => x.id === termId && x.running) : null;
  if (!term) {
    // 页面刷新后内存绑定会丢：先从服务端拿「归属本节点」（term.nodeId）的运行终端
    await refreshTerms();
    const owned = nodeTermFor(node);
    if (owned) { term = owned; termId = owned.id; }
  }
  if (!term) {
    const r = await api(`/api/tasks/${ownerTaskId}/term`, {
      method: 'POST',
      body: { tool: node.tool, cwd: node.cwd || undefined, resumeCommand: node.resumeCommand || undefined, file: node.file || undefined, label: toolLabel(node.tool), nodeId: node.id },
    });
    await refreshTerms();
    termId = r.termId;
    term = { id: termId };
  }
  nodeTermBindings.set(node.id, term.id);
  refreshTermIndicators(); // 新 spawn 的 TUI 终端立刻点亮标签/会话链上的绿点
  const ws0 = agentSockets.get(term.id);
  const ws = (ws0 && ws0.readyState <= 1) ? ws0 : (() => {
    const w = new WebSocket(`ws://${location.host}/ws/term/${term.id}`);
    agentSockets.set(term.id, w);
    return w;
  })();
  // TUI 对话框检测（聊天优先模式）：必须在 open 之前挂监听——attach 回放里就带着
  // 闸门特征（恢复选择框等），open 之后再挂会漏检。匹配即触发「终端」按钮脉冲。
  if (!ws._dlgHooked) {
    ws._dlgHooked = true;
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || !/Enter to confirm|Esc to cancel/i.test(e.data)) return;
      const h = nodeTuiHandlers.get(node.id);
      if (!h) return;
      h(true);
      clearTimeout(h._t);
      h._t = setTimeout(() => h(false), 15000);
    });
  }
  if (ws.readyState === 0) await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('终端连接失败')); });
  if (ws.readyState !== 1) throw new Error('终端连接失败');
  ws.send(text + '\r');
}

/* 清空所有会话面板（切换任务时） */
