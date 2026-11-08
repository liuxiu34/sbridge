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
  xtermLoading = loadScript('/vendor/xterm.js')
    .then(() => loadScript('/vendor/addon-fit.js'))
    .then(() => {
      if (!window.Terminal || !window.FitAddon) throw new Error('终端组件加载失败');
    });
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

/* 把原始终端挂进指定容器（面板「⌨」切换用；agent 进程挂在服务上，关页面不中断） */
async function mountTerm(hostEl, node, retries = 0, hooks = {}) {
  await loadXterm();
  if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') throw new Error('终端组件加载失败');
  // 只认「本节点自己的」终端；找不到就为它单独 spawn 一个（绝不按 cwd+tool 复用别人的）
  let term = nodeTermFor(node);
  const fromAttach = !!term; // 挂载已存在的终端（区别于本函数内新 spawn）
  if (!term) {
    const r = await api(`/api/tasks/${currentTask.id}/term`, {
      method: 'POST',
      body: { tool: node.tool, cwd: node.cwd || undefined, resumeCommand: node.resumeCommand || undefined, file: node.file || undefined, label: toolLabel(node.tool), nodeId: node.id },
    });
    await refreshTerms();
    term = { id: r.termId, replayed: !!r.replayed }; // 服务端已注入历史回放
  }
  // 登记绑定：本节点 spawn 的终端归本节点；已被其他节点绑定的终端只作展示、不抢
  //（分屏同目录场景，防止 reintroduce 串台）
  let owner = null;
  for (const [nid, tid] of nodeTermBindings) if (tid === term.id) owner = nid;
  if (!owner) nodeTermBindings.set(node.id, term.id);
  window.__sbLastMount = { id: term.id, node: node.id, at: Date.now() }; // 调试口
  hostEl.innerHTML = '';
  const t = new Terminal({
    // 终端字体对齐 Windows Terminal（默认 Cascadia Mono 16px，该处再降 1 档缓解偏大）
    // 15px + lineHeight 1.2 + DOM 渲染（ClearType 风格 subpixel，canvas 灰度 AA 会发虚）
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace',
    fontSize: 15,
    lineHeight: 1.2,
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    letterSpacing: 0,
    cursorBlink: true,
    scrollback: 5000,
    theme: theme.xtermTheme(),
  });
  const fit = new FitAddon.FitAddon();
  t.loadAddon(fit);
  /* 渲染器：改用 xterm 默认 DOM（不再加载 canvas addon）。
     实测在 155% DPI 下 canvas 是灰度抗锯齿，Cascadia 笔画发虚、观感「奇怪」；
     DOM 走浏览器 subpixel（ClearType 风格）渲染，字形清晰度对齐 Windows Terminal。
     色块边缘在 xterm 6 DOM 下按单元格铺满，实测 Claude TUI 深色块右缘整齐。 */
  t.open(hostEl);
  theme.liveTerms.add(t); // 主题切换时热换肤
  window.__sbTerms = window.__sbTerms || new Set();
  window.__sbTerms.add(t); // 调试口：诊断 buffer 状态
  window.__sbLastMountTerm = t; // 调试口：最近挂载的实例
  // 仅 Pi 拦截 alternate buffer：pi regular 模式逐行打印，历史要留在 normal buffer
  // 供滚轮回看（滑块/trimBlank 逻辑也都建立在 normal buffer 上）。
  // Claude/Codex 的全屏 TUI 用 \x1b[H 绝对定位从缓冲区顶部重绘——拦截 alt-screen 会让
  // 它们的实况画进 normal buffer 顶部，视口却停在底部的回放+垫行上，用户看到的就是
  // 「只有历史回放+大片空白、实况不知去向」。放回原生 alt-screen：实况直接可见，
  // 历史走工作轨迹。（实测 Claude 卡信任框/恢复选择等确认框也是这个原因看不见）
  const blockAltScreen = (params) => Array.isArray(params)
    && params.some((v) => v === 47 || v === 1047 || v === 1049);
  const altScreenHandlers = [];
  if (node.tool === 'pi') {
    try {
      altScreenHandlers.push(t.parser.registerCsiHandler({ prefix: '?', final: 'h' }, blockAltScreen));
      altScreenHandlers.push(t.parser.registerCsiHandler({ prefix: '?', final: 'l' }, blockAltScreen));
    } catch { /* 版本不支持时至少保持原有行为 */ }
  }
  // 注入回放的会话：agent 启动时的首次全屏清屏（CSI 2J/3J）只擦可视区，回放已在
  // 回滚区里安然无恙。抓住这「第一次清屏」把视口跳到回放顶部——用户打开终端直接
  // 看到本会话历史，而不是底部一片空白垫行。仅此一次，之后的清屏不再动视口。
  if (term.replayed) {
    try {
      // 回放未收缩（还在 400 行高屏可视区）时，吞掉所有 2J/3J 清屏——否则 agent 启动的
      // 清屏会把仍留在可视区的回放整体抹掉（旧方案靠回放末尾垫 120 行盲文空白顶出去，
      // 但垫行被 trimBlank 计为内容永远不裁，堆出「历史下面一大段空白」，已废弃垫行）。
      // 收缩完成后回放已落回滚区，首个清屏放行并跳到顶部，之后的清屏不再动视口。
      let clearJumped = false;
      altScreenHandlers.push(t.parser.registerCsiHandler({ final: 'J' }, (params) => {
        const p0 = Array.isArray(params) ? params[0] : params;
        if (p0 !== 2 && p0 !== 3) return false; // 0J 只擦光标下方，无碍
        if (!replayShrunk) return true; // 吞掉：回放还在可视区
        if (!clearJumped) {
          clearJumped = true;
          setTimeout(() => {
            try { t.scrollToLine(0); scheduleScrollUi(); } catch { /* ignore */ }
            needRebottom = true; // 跳顶只是让你瞥一眼历史：下一帧实况到达立刻回底部
          }, 80);
        }
        return false;
      }));
    } catch { /* ignore */ }
  }
  try { fit.fit(); } catch { /* 容器未就绪 */ }
  // 高屏回放：大窗口里 TUI 回放内容一屏装得下 → buffer 永不溢出 → 没有可滚动历史。
  // 挂载时先临时把行数扩到 400（Pi/Codex 长会话重绘可轻松超过 150 行），回放完成后
  // （数据流停止 300ms）收缩回真实高度，被挤出的行全部变成真正的 scrollback。
  // 服务端已注入历史回放的会话不走这套：回放本身就是历史，且高屏 resize 会引发
  // ConPTY 按 400 行重绘、在回放与实际输出之间塞进数百行空白（实测），反而把回放
  // 从 trimBlank 的「保留最新 N 行」窗口里挤出去。
  // 历史回放注入已停用（见 server.mjs /term 注释），400 行高屏相位不再有意义：
  // 实测 pi 在 400 行视口下会按 400 行重绘、满屏输出清行序列，终端看起来就是一片空白，
  // 缩回真实行数后才正常绘制。现在所有工具都直接用容器真实行数挂载（由 sendResize/refit 负责）。
  let replayShrunk = true;
  const viewEl = hostEl.closest('.term-view');
  /* 自动贴底：新输出默认跟随滚到最下面（Claude/Codex 的改动与确认框都出现在最新一行）。
     用户主动往上翻时暂停跟随，滚回底部或点「最新」后恢复。 */
  let followBottom = true;
  const isAtBottom = () => {
    try {
      const b = t.buffer.active;
      return (b.viewportY || 0) >= (b.baseY || 0);
    } catch { return true; }
  };
  const syncFollow = () => { followBottom = isAtBottom(); };
  /* 终端启动提示：pi/codex 启动阶段只发清行序列，屏幕看起来空白十几秒。
     buffer 出现第一行非空内容即隐藏；不要用「收到数据」判定——清行也是数据。 */
  const loadingEl = viewEl?.querySelector('[data-role="termloading"]');
  let loadingTimer = 0;
  if (loadingEl) {
    loadingEl.hidden = false;
    const checkTermContent = () => {
      try {
        const b = t.buffer.active;
        const total = Math.min(b.length, (b.baseY || 0) + t.rows);
        for (let i = 0; i < total; i++) {
          if ((b.getLine(i)?.translateToString(true) || '').trim()) {
            loadingEl.hidden = true;
            clearInterval(loadingTimer);
            return;
          }
        }
      } catch { /* 终端尚未就绪 */ }
    };
    loadingTimer = setInterval(checkTermContent, 500);
  }
  const bottomBtn = viewEl?.querySelector('[data-role="termbottom"]');
  const historyBtn = viewEl?.querySelector('[data-role="termhistory"]');
  let scrollUiFrame = 0;
  let sliderDragging = false; // 滑块拖动接管中：syncScrollUi 暂停写 --sb-slider-top，由拖动逻辑直接控制
  // TUI（pi/codex）重绘会把 buffer 收缩回一屏，baseY 归 0，但历史输出确实发生过。
  // 判定用「粘性」：一旦出现过回滚内容就保持 has-scrollback，直到终端销毁。
  let stickyHasScrollback = false;
  const evalScrollback = () => {
    try {
      if (!stickyHasScrollback) stickyHasScrollback = (t.buffer.active.baseY || 0) > 0;
    } catch { /* 终端尚未就绪 */ }
    return stickyHasScrollback;
  };
  const syncScrollUi = () => {
    scrollUiFrame = 0;
    try {
      const buffer = t.buffer.active;
      const hasScrollback = evalScrollback();
      const atBottom = (buffer.viewportY || 0) >= (buffer.baseY || 0);
      viewEl?.classList.toggle('has-scrollback', hasScrollback);
      if (bottomBtn) bottomBtn.hidden = !hasScrollback || atBottom;
      // resume 出来的新终端没有本地回滚（TUI 只重绘最后一屏）：
      // 此时提示用户去工作轨迹看本会话的历史内容
      if (historyBtn) historyBtn.hidden = hasScrollback;
      // 滑块高度与位置：xterm 6 在 scrollback 裁剪后不重算 slider 内联 height/top
      //（停在 0px/旧值），只接管 height 会出现「滑块沉底只露头」。这里一并接管：
      // 高度 = rows/(baseY+rows) × 轨道；位置 = viewportY/(baseY+rows) × 轨道。
      const trackH = viewEl?.querySelector('.xterm-scrollable-element')?.clientHeight
        || viewEl?.clientHeight || 0;
      const total = (buffer.baseY || 0) + t.rows;
      if (trackH > 0 && total > 0) {
        const hPx = Math.max(28, Math.round(trackH * Math.min(1, t.rows / total)));
        const maxTop = trackH - hPx;
        const topPx = Math.round(Math.min(maxTop, Math.max(0,
          (buffer.viewportY || 0) / Math.max(1, total - t.rows) * maxTop)));
        viewEl.style.setProperty('--sb-slider-h', `${hPx}px`);
        // 拖动期间滑块位置由 startSliderDrag 直接控制（同一公式反算，避免两边拉扯）
        if (!sliderDragging) viewEl.style.setProperty('--sb-slider-top', `${topPx}px`);
      }
    } catch { /* 终端尚未就绪 */ }
  };
  const scheduleScrollUi = () => {
    if (scrollUiFrame) return;
    scrollUiFrame = requestAnimationFrame(syncScrollUi);
  };
  // 滚轮只回滚 xterm 自己的历史缓冲：不让空 viewport 吞事件，也不让 xterm
  // 在无本地回滚时把 wheel 转成 ↑/↓ 发回 PTY（表现为输入框翻命令历史）。
  const wheelHandler = (e) => {
    if (!viewEl || e.ctrlKey || e.metaKey || !e.deltaY) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.sess-input')) return; // 页面输入框保持原有滚轮行为
    e.preventDefault();
    e.stopImmediatePropagation();
    let lines = e.deltaMode === 1 ? Math.abs(e.deltaY)
      : e.deltaMode === 2 ? t.rows
        : Math.abs(e.deltaY) / 40;
    lines = Math.max(1, Math.min(10, Math.round(lines)));
    t.scrollLines(e.deltaY > 0 ? lines : -lines);
    syncFollow();
    scheduleScrollUi();
  };
  viewEl?.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
  /* 滑块拖动接管：我们用 CSS 变量强制接管了 slider 的 height/top，但 xterm 6 内部
     拖动逻辑按它自己的（未重算的）slider 尺寸换算指针位置，两边互相拉扯导致拖动
     不跟手。这里在 capture 阶段拦下 mousedown（先于 xterm 在目标元素上的监听），
     用与 syncScrollUi 完全相同的公式把指针位置反算成 viewportY：
       topPx/maxTop = viewportY/(total-rows)
     拖动期间由本逻辑直接写 --sb-slider-top，松手后交还 syncScrollUi。 */
  const startSliderDrag = (ev) => {
    // 只劫持「滚动条区域」的点击。判定不能用 closest('.xterm-scrollable-element')——
    // xterm 6 的终端正文（.xterm-screen）和键盘捕获层都在它内部，那样会把点正文
    // 的 mousedown 也拦掉，xterm 拿不到焦点，终端就没法直接输入（↑翻历史、/命令）。
    // 几何测量仍用 scrollable element（.scrollbar.vertical 是 xterm 内部高度，会失真）。
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target?.closest('.xterm-scrollable-element > .scrollbar.vertical')) return;
    const scrollable = target.closest('.xterm-scrollable-element');
    const slider = scrollable?.querySelector(':scope > .scrollbar.vertical > .slider');
    if (!scrollable || !slider || !viewEl?.classList.contains('has-scrollback')) return;
    ev.preventDefault();
    ev.stopPropagation(); // capture 阶段拦下，xterm 内部拖动逻辑不再收到事件
    sliderDragging = true;
    slider.classList.add('active');
    const sliderRect = slider.getBoundingClientRect();
    const onSlider = ev.target === slider;
    // 点在滑块上保持抓取点相对位置；点在轨道空白处则让滑块中心跳到点击处
    const grabOffset = onSlider ? ev.clientY - sliderRect.top : sliderRect.height / 2;
    const onMove = (mv) => {
      try {
        const buffer = t.buffer.active;
        const trackRect = scrollable.getBoundingClientRect();
        const hPx = slider.getBoundingClientRect().height;
        const maxTop = Math.max(0, scrollable.clientHeight - hPx);
        const total = (buffer.baseY || 0) + t.rows;
        const scrollableRows = Math.max(1, total - t.rows);
        const topPx = Math.min(maxTop, Math.max(0, mv.clientY - trackRect.top - grabOffset));
        viewEl.style.setProperty('--sb-slider-top', `${Math.round(topPx)}px`);
        const target = Math.round((maxTop ? topPx / maxTop : 1) * scrollableRows);
        t.scrollToLine(Math.min(buffer.baseY || 0, Math.max(0, target)));
        syncFollow();
      } catch { /* ignore */ }
    };
    if (!onSlider) onMove(ev); // 轨道点击立即跳转
    const onUp = () => {
      sliderDragging = false;
      slider.classList.remove('active');
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      scheduleScrollUi(); // 松手后按实际 viewportY 校准一次
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  };
  viewEl?.addEventListener('mousedown', startSliderDrag, true);
  const scrollListener = t.onScroll(scheduleScrollUi);
  // 历史回放/重绘时同步滚动条状态，避免 has-scrollback 晚一拍。
  const renderListener = typeof t.onRender === 'function' ? t.onRender(scheduleScrollUi) : null;
  const writeParsedListener = typeof t.onWriteParsed === 'function' ? t.onWriteParsed(scheduleScrollUi) : null;
  // 兜底轮询：resume 回放后 buffer.baseY 的最终值可能晚于最后一次 onRender/onWriteParsed，
  // 事件全部触发完 has-scrollback 仍是旧值。每 600ms 核对一次。这里直接走 syncScrollUi：
  // 滑块 CSS 变量同样依赖 baseY/viewportY，trimBlank 裁剪后 xterm 不发任何事件，
  // 只靠事件驱动的滑块尺寸会停在挂载时的陈旧值（实测假 28px 滑块）。
  let followCursor = false; // 内嵌面板打开期间置位：轮询跟随光标（TUI 重绘位置=光标处）
  const scrollToCursor = () => {
    try {
      const b = t.buffer.active;
      t.scrollToLine(Math.max(0, b.cursorY - Math.floor(t.rows / 2)));
      scheduleScrollUi();
    } catch { /* ignore */ }
  };
  const pollScrollUi = setInterval(() => {
    syncScrollUi();
    if (followCursor) scrollToCursor();
    // 对话框特征 15s 未再出现 = 交互结束，通知切回工作轨迹
    if (dialogReported && Date.now() - lastDialogAt > 15000) {
      dialogReported = false;
      try { hooks.onTuiDialog?.(false); } catch { /* ignore */ }
    }
  }, 600);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/term/${term.id}`);
  let gotTermData = false; // onclose 时区分「连上但没收到任何数据」（终端记录失效）与正常断开
  let termDisposed = false;
  let needRebottom = false; // 回放首清屏跳顶后置位：下一帧实况数据到达就回底部（否则视口钉死在历史区，实况全在视野外）
  let lastDialogAt = 0; // TUI 对话框特征（确认/选择框）最后出现时间，驱动工作轨迹⇄终端自动切换
  let dialogReported = false;
  const sendResize = () => {
    try {
      // 容器隐藏（默认工作轨迹视图）时 fit 拿到 0 尺寸，resize 会把 buffer 清成空壳——
      // 跳过，等视图显示时 refit 再补偿
      if (viewEl?.hidden || !hostEl.clientHeight) return;
      fit.fit();
      if (ws.readyState === 1) ws.send(JSON.stringify({ resize: { cols: t.cols, rows: t.rows } }));
      if (followBottom) { try { t.scrollToBottom(); } catch { /* ignore */ } }
      scheduleScrollUi();
    } catch { /* 布局未就绪 */ }
  };
  ws.onopen = sendResize;
  // 同步采样：回放期间 buffer 可能瞬时超过一屏（baseY>0），但 scheduleScrollUi 的 rAF
  // 去抖会把整段回放合并成一帧，等帧执行时 TUI 已重绘收缩、baseY 归 0 —— 峰值躲过采样。
  // 所以在 write 之前直接同步判定一次（sticky 只会单向置 true，开销可忽略）。
  let shrinkTimer = 0;
  let replayDone = false; // 服务端回放结束标记（REPLAY_DONE）
  // 空白清理：Pi 的 TUI 用绝对定位跳行重绘（无论回放还是正常运行），buffer 里会
  // 持续积累「跳行空白」。方案：周期性把 scrollback 动态调小到「非空内容行数 + 余量」，
  // xterm 监听该选项变化，从 buffer 头部丢掉最老的行——横幅和空白段一起被裁。
  // 开销：每 5 秒全 buffer 扫一遍字符串（≤5100 行），可忽略。
  // 裁剪后 buffer 骤减，但 xterm 内部 slider 高度要等下一次滚动/尺寸事件才重算——
  // 实测 slider 的内联 height 会停在 '0px'（CSS min-height 顶了个假滑块）。
  // scrollLines(±1) 在视口已在底部时会被抵消，无法触发重算；
  // 有效方法：同尺寸 resize 重入（xterm resize 会重算 scrollDimensions 并同步 slider）。
  const refreshScrollbar = () => {
    try {
      t.resize(t.cols, t.rows);
      t.scrollLines(1);
      t.scrollLines(-1);
      if (followBottom) t.scrollToBottom();
    } catch { /* ignore */ }
  };
  const trimBlank = () => {
    try {
      if (viewEl?.hidden || !hostEl.clientHeight) return; // 隐藏时不裁剪（尺寸语义不对，会误伤）
      const buf = t.buffer.active;
      const sbRows = buf.baseY || 0;
      // 只统计「回滚区」的非空行——可视区行不受 scrollback 影响，不该撑大 keep。
      // 之前用全 buffer 内容计数，可视区 40+ 行内容把 keep 撑到与 baseY 相同，
      // 裁剪等于没裁（这正是修了几轮都没效果的最后一个坑）。
      let sbContent = 0;
      let replayHeaderY = -1; // 历史回放头行位置（注入回放的会话需要保护）
      for (let y = 0; y < sbRows; y++) {
        const s = buf.getLine(y)?.translateToString(true) || '';
        if (s.trim()) sbContent++;
        if (replayHeaderY === -1 && s.includes('📜 本会话历史回放')) replayHeaderY = y;
      }
      let keep = Math.max(10, Math.min(sbContent + 8, 2000));
      // 注入回放的会话：回放头行之上的空白随便裁，回放本体到视口之间不许动。
      // 否则 TUI 重绘/ConPTY 重绘产生的空白行（在回放之后写入）会把回放挤出
      // 「最新 sbContent+8 行」窗口，历史被裁没（实测采样抓到 sbOpt=92 那一刀）。
      if (replayHeaderY >= 0) keep = Math.max(keep, Math.min(sbRows - replayHeaderY + 8, 2000));
      // 只在空白「压倒性占多数」时才裁（空白 > 2× 非空行）。这个清理是为 Pi 全屏
      // TUI 的跳行空白洪水设计的——那种场景空白占 90%+。regular 行式模式的会话
      // 历史里天然有 ~1/3 空白行（对话格式），按「keep=非空+8」的比例裁剪会把
      // 最老的历史一刀刀吃掉：实测 resume 回放 2259 行（非空 848）在 20 秒内被
      // 裁到 344 行，用户发一条消息（触发重绘+下一轮裁剪）滚动条比例就跳变一次。
      const blankRows = sbRows - sbContent;
      if (sbRows > 20 && blankRows > Math.max(15, sbContent * 2)) {
        t.options.scrollback = keep;
        setTimeout(() => {
          try {
            t.options.scrollback = 5000;
            // scrollback 恢复 5000 后 buffer 尺寸语义又变了，此刻再同步才有效
            setTimeout(refreshScrollbar, 50);
          } catch { /* ignore */ }
        }, 150);
      } else if (sbRows > 5) {
        refreshScrollbar(); // 没裁也同步一次：滑块比例可能因早期收缩而失真
      }
    } catch { /* ignore */ }
  };
  const shrinkNow = () => {
    replayShrunk = true;
    if (viewEl?.hidden || !hostEl.clientHeight) return;
    try {
      trimBlank(); // 回放结束：先裁掉启动横幅/大段空白
      refreshScrollbar();
      setTimeout(() => { trimBlank(); refreshScrollbar(); }, 2500);
    } catch { /* ignore */ }
    scheduleScrollUi();
  };
  const blankTrimTimer = setInterval(trimBlank, 5000); // 常驻：运行期空白持续清理
  /* 大回放分块写入：一条 WS 消息可能带 120k 回放 + 200k PTY 缓冲，一次性 t.write
     会让 xterm 同步解析整段、主线程卡住。按 64k 分块、块间让出事件循环；所有写入
     （分块/哨兵收缩/后续 live 数据）串在同一条 promise 链上，保证严格按到达顺序落盘。 */
  const WRITE_CHUNK = 64000;
  let writeChain = Promise.resolve();
  window.__sbW = window.__sbW || [];
  const wlog = (m, data) => {
    const a = window.__sbW;
    if (a.length > 120) a.length = 0;
    a.push({ m, t: Date.now() % 100000, h: typeof data === 'string' ? data.slice(0, 60).replace(/\x1b/g, '\\e') : undefined });
  };
  const writeBig = (data) => {
    wlog('write ' + data.length, data);
    const job = writeChain.then(() => new Promise((done) => {
      if (data.length <= WRITE_CHUNK) { t.write(data, done); return; }
      let i = 0;
      const step = () => {
        if (i >= data.length) { done(); return; }
        t.write(data.slice(i, i + WRITE_CHUNK));
        i += WRITE_CHUNK;
        setTimeout(step, 0);
      };
      step();
    }));
    job.catch((err) => wlog('CHAIN-ERR ' + (err && err.stack || err)));
    // 链上失败不能毒化后续写入：catch 后返回 resolved，保证新数据还能继续写
    writeChain = job.catch(() => {});
    return job;
  };
  const queueShrink = () => {
    // 收缩必须等「分块全部发出并解析完」之后：未发出的块还不在 xterm 解析队列里，
    // 直接 t.write('', shrinkNow) 只会排在已发出写入之后，剩余块会被 resize 丢弃。
    // 关键：xterm 的 write 回调必须显式 resolve 我们的 Promise——这里曾把 shrinkNow
    // 直接当回调，done 永远不调用 → writeChain 永久 pending，REPLAY_DONE 之后
    // 所有实况数据都不再写入（终端一片空白的真正根因）。
    wlog('shrink-queue');
    writeChain = writeChain.then(() => new Promise((done) => {
      try {
        t.write('', () => { try { shrinkNow(); } catch { /* ignore */ } done(); });
      } catch { done(); }
    })).catch(() => {});
  };
  ws.onmessage = (e) => {
    gotTermData = true;
    // TUI 对话框特征：claude/codex 的确认框/选择框都带这类页脚。出现即上报（自动切终端视图）
    if (typeof e.data === 'string' && /Enter to confirm|Esc to cancel/i.test(e.data)) {
      lastDialogAt = Date.now();
      if (!dialogReported) {
        dialogReported = true;
        try { hooks.onTuiDialog?.(true); } catch { /* 回调异常不影响终端 */ }
      }
    }
    // 回放结束哨兵：服务端 buffer 回放完才发。Pi 启动横幅分段输出之间常有
    // >300ms 停顿，仅靠静默计时会误判「回放提前结束」，在回放中途就收缩小屏，
    // 导致剩余回放全部覆写在可视区内、挤不出 scrollback（首次启动无滚动条的根因）。
    if (typeof e.data === 'string' && e.data.includes('\u0000REPLAY_DONE\u0000')) {
      replayDone = true;
      clearTimeout(shrinkTimer);
      queueShrink();
      return;
    }
    evalScrollback();
    if (needRebottom) {
      needRebottom = false;
      try { t.scrollToBottom(); } catch { /* ignore */ }
    }
    writeBig(e.data).then(() => {
      // 必须在写入解析完成后滚，否则滚到的还是旧底部（新行还没进 buffer）
      if (followBottom) {
        try { t.scrollToBottom(); } catch { /* ignore */ }
      }
    });
    scheduleScrollUi();
    // 回放未结束时不收缩：数据流静默 1.2s 且已收到结束标记才缩（正常路径由哨兵触发，
    // 此计时仅作哨兵丢失的兜底）；回放结束后交给 PTY 正常节奏。
    if (!replayDone && !replayShrunk) {
      clearTimeout(shrinkTimer);
      shrinkTimer = setTimeout(queueShrink, 1200);
    }
  };
  t.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  /* 静默空白修复：ws 关闭且从未收到任何数据 = 挂到了已失效的终端记录
     （服务端重启/记录被清，服务端 attachTerm 查不到直接 close）。不处理的话
     终端永远空白、无任何提示。自动清绑定重拉一次（带 retries 防循环）。 */
  ws.onclose = () => {
    if (termDisposed || gotTermData || !hostEl.isConnected) return;
    if (retries >= 1) {
      toast('终端连接失效，请点「启动此会话的终端」手动重试');
      return;
    }
    console.warn('[终端] 连接关闭且未收到数据，自动重新拉起', term.id);
    toast('终端连接已失效，正在重新拉起…');
    nodeTermBindings.delete(node.id);
    if (node.termId === term.id) node.termId = null;
    // 关键：把失效记录从本地 state 剔除并刷新服务端列表，否则重挂的 nodeTermFor
    // 会再次匹配到同一条死记录（实测第二次挂载仍然零字节、终端依旧空白）
    state.terms = (state.terms || []).filter((x) => x.id !== term.id);
    refreshTerms().catch(() => {});
    setTimeout(() => {
      if (termDisposed || !hostEl.isConnected) return;
      mountTerm(hostEl, node, retries + 1, hooks).then((h) => {
        if (h && !termDisposed) Object.assign(handle, h); // 嫁接新句柄：面板 close() 仍能正确释放新实例
      }).catch(() => {});
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
  // Shift+PgUp / Shift+PgDn 翻页回看（普通 PgUp/PgDn 仍交给终端程序）
  t.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.shiftKey) return true;
    if (ev.key === 'PageUp') { t.scrollPages(-1); syncFollow(); return false; }
    if (ev.key === 'PageDown') { t.scrollPages(1); syncFollow(); return false; }
    return true;
  });
  setTimeout(sendResize, 80);
  window.addEventListener('resize', sendResize);
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sendResize);
  resizeObserver?.observe(hostEl);
  scheduleScrollUi();
  // 命名句柄：onclose 自动重拉后用 Object.assign 把新实例的方法嫁接进来，
  // 面板持有的旧 rawTerm 仍能正确 dispose 最新实例
  const handle = {
    // 视图切换/窗口变化后必须把「新尺寸」同步给 PTY：只 fit 本地 canvas 会让
    // 终端里的 TUI 仍按旧列数绘制，宽屏右侧留出一条空白（Claude/Codex 的历史
    // 行不会重排，只有新的 resize 才会让它们按新宽度重画）。
    refit() { sendResize(); },
    setFollowCursor(v) { followCursor = v; },
    scrollToBottom() { followBottom = true; try { t.scrollToBottom(); scheduleScrollUi(); } catch { /* ignore */ } },
    dispose() {
      termDisposed = true;
      theme.liveTerms.delete(t);
      resizeObserver?.disconnect();
      viewEl?.removeEventListener('wheel', wheelHandler, true);
      viewEl?.removeEventListener('mousedown', startSliderDrag, true);
      window.removeEventListener('resize', sendResize);
      clearInterval(pollScrollUi);
      clearInterval(blankTrimTimer);
      clearInterval(loadingTimer);
      clearTimeout(shrinkTimer);
      if (scrollUiFrame) cancelAnimationFrame(scrollUiFrame);
      for (const h of altScreenHandlers) { try { h.dispose(); } catch { /* ignore */ } }
      try { scrollListener?.dispose(); } catch { /* ignore */ }
      try { renderListener?.dispose(); } catch { /* ignore */ }
      try { writeParsedListener?.dispose(); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      try { t.dispose(); } catch { /* ignore */ }
      hostEl.innerHTML = '';
      viewEl?.classList.remove('has-scrollback');
      if (bottomBtn) bottomBtn.hidden = true;
      if (historyBtn) historyBtn.hidden = true;
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
async function sendToAgent(node, text) {
  let termId = nodeTermBindings.get(node.id) || node.termId || null;
  let term = termId ? (state.terms || []).find((x) => x.id === termId && x.running) : null;
  if (!term) {
    // 页面刷新后内存绑定会丢：先从服务端拿「归属本节点」（term.nodeId）的运行终端
    await refreshTerms();
    const owned = nodeTermFor(node);
    if (owned) { term = owned; termId = owned.id; }
  }
  if (!term) {
    const r = await api(`/api/tasks/${currentTask.id}/term`, {
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
