/* sbridge · 右侧面板（T3 Code 风格 surface）：
   工作区共用一个，内容跟随当前聚焦会话；只读，不挂终端，开合不影响工作轨迹/终端切换。 */

const SP_ITEMS = [
  { id: 'side', icon: 'chat', label: '侧边对话', key: 'S', hint: '基于当前会话上下文开一条独立对话，和主会话同时进行' },
  { id: 'diff', icon: 'diff', label: '改动', key: 'D', hint: '当前会话目录的 git 改动与逐文件 diff' },
  { id: 'files', icon: 'folder', label: '文件', key: 'F', hint: '浏览会话目录，点文件看文本内容' },
  { id: 'context', icon: 'context', label: '上下文', key: 'C', hint: '这个任务已被捕获的认知与证据' },
  { id: 'worktree', icon: 'git', label: 'Worktree', key: 'W', hint: '独立工作区的分支状态与合并' },
];

const spState = { open: false, surface: null, dir: '', file: null, wtFile: null };
let spLastKey = '';

/* 侧边对话运行时状态：独立会话 + 自己的 SSE 流，面板关闭/切换时回收 */
const spChat = { nodeId: null, es: null, cot: null, tick: 0, poll: 0, busy: false, startedAt: 0, mounted: '' };

function currentPanelNode() {
  if (typeof findNode !== 'function') return null;
  return findNode(activeTabId) || findNode(layout?.slots?.[0]) || (currentTask?.nodes || [])[0] || null;
}

function spApiBase(node) {
  return `/api/tasks/${currentTask.id}/nodes/${node.id}`;
}

function refreshSidePanel(force = false) {
  if (!spState.open) return;
  // 侧边对话是并行会话：不跟当前标签走，否则切个标签就把对话流打断
  const key = spState.surface === 'side'
    ? `side|${currentTask?.id || ''}|${spChat.nodeId || ''}`
    : `${activeTabId || ''}|${spState.surface || ''}|${spState.dir}|${spState.file || ''}`;
  if (!force && key === spLastKey) return;
  spLastKey = key;
  spRender();
}

/** 面板宽度变化后，让当前终端的 xterm 重新量尺寸（refit 内部只在终端视图生效） */
function spRefitTerm() {
  const id = activeTabId || layout?.slots?.[0];
  const handle = id && typeof paneHandles !== 'undefined' ? paneHandles.get(id) : null;
  try { handle?.refit(); } catch { /* ignore */ }
}

const SP_WIDTH_KEY = 'sbridge-side-width';
const SP_WIDTH_MIN = 260;
const spMaxWidth = () => Math.min(760, Math.max(SP_WIDTH_MIN, Math.round(window.innerWidth * 0.62)));

/** 拖动分隔条调整右侧面板宽度（记在本地，下次打开沿用） */
function initSideResizer() {
  const bar = $('sp-resizer');
  const panel = $('side-panel');
  if (!bar || !panel) return;
  const saved = Number(localStorage.getItem(SP_WIDTH_KEY) || 0);
  if (saved >= SP_WIDTH_MIN) panel.style.width = `${Math.min(saved, spMaxWidth())}px`;
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    bar.classList.add('dragging');
    try { bar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    let raf = 0;
    const move = (ev) => {
      const next = Math.max(SP_WIDTH_MIN, Math.min(spMaxWidth(), Math.round(startW - (ev.clientX - startX))));
      panel.style.width = `${next}px`;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; spRefitTerm(); });
    };
    const up = () => {
      bar.classList.remove('dragging');
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
      try { localStorage.setItem(SP_WIDTH_KEY, String(Math.round(panel.getBoundingClientRect().width))); } catch { /* ignore */ }
      spRefitTerm();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
}

function toggleSidePanel(force) {
  const panel = $('side-panel');
  if (!panel) return;
  const want = force === undefined ? !spState.open : !!force;
  spState.open = want;
  panel.hidden = !want;
  const bar = $('sp-resizer');
  if (bar) bar.hidden = !want;
  const btn = $('btn-panel');
  btn?.classList.toggle('active', want);
  btn?.setAttribute('aria-pressed', String(want));
  if (want) {
    const savedW = Number(localStorage.getItem(SP_WIDTH_KEY) || 0);
    panel.style.width = `${Math.min(savedW >= SP_WIDTH_MIN ? savedW : 320, spMaxWidth())}px`;
    spLastKey = '';
    spRender();
  } else {
    spUnmountSide();
    $('sp-body')?.classList.remove('sp-body-chat');
  }
  setTimeout(spRefitTerm, 60);
}

function openSidePanel(id) {
  spState.surface = id || null;
  spState.dir = '';
  spState.file = null;
  spState.wtFile = null;
  spLastKey = '';
  toggleSidePanel(true);
  spRender();
}

function spBack() {
  spState.surface = null;
  spState.dir = '';
  spState.file = null;
  spState.wtFile = null;
  spLastKey = '';
  spRender();
}

async function spRender() {
  const body = $('sp-body');
  if (!body) return;
  // 记录本次渲染的签名：renderTabs 频繁触发 refreshSidePanel，签名一致就不再重绘（防闪烁）
  spLastKey = spState.surface === 'side'
    ? `side|${currentTask?.id || ''}|${spChat.nodeId || ''}`
    : `${activeTabId || ''}|${spState.surface || ''}|${spState.dir}|${spState.file || ''}`;
  if (spState.surface !== 'side') spUnmountSide();
  const node = currentPanelNode();
  const item = SP_ITEMS.find((i) => i.id === spState.surface);
  $('sp-back').hidden = !spState.surface;
  $('sp-title').textContent = item ? item.label : '面板';

  if (!spState.surface) return spRenderLauncher(body);
  if (!node) {
    body.innerHTML = '<div class="sp-empty">先打开一个会话，面板会跟随当前会话</div>';
    return;
  }
  body.innerHTML = '<div class="sp-loading">加载中…</div>';
  try {
    if (spState.surface === 'side') return spRenderSide(body, node);
    if (spState.surface === 'diff') return await spRenderDiff(body, node);
    if (spState.surface === 'files') return await spRenderFiles(body, node);
    if (spState.surface === 'context') return await spRenderContext(body, node);
    if (spState.surface === 'worktree') return await spRenderWorktree(body, node);
  } catch (err) {
    body.innerHTML = `<div class="sp-empty">${escapeHtml(err.message)}</div>`;
  }
}

function spRenderLauncher(body) {
  body.innerHTML = `
    <div class="sp-launcher">
      <h3 class="sp-launcher-title">打开面板</h3>
      ${SP_ITEMS.map((it, i) => `
        <button type="button" class="sp-item" data-sp="${it.id}" data-i="${i}" title="${escapeHtml(it.hint)}">
          <span class="sp-item-icon">${icon(it.icon, 15)}</span>
          <span class="sp-item-label">${escapeHtml(it.label)}</span>
          <kbd class="sp-kbd">${it.key}</kbd>
        </button>`).join('')}
    </div>`;
  body.querySelectorAll('[data-sp]').forEach((btn) => {
    btn.addEventListener('click', () => openSidePanel(btn.dataset.sp));
  });
}

/* 键盘上下选择（对齐 T3 面板的手感） */
document.addEventListener('keydown', (e) => {
  if (!spState.open || spState.surface) return;
  const body = $('sp-body');
  if (!body || !body.contains(document.activeElement) && document.activeElement !== body) return;
  const items = [...body.querySelectorAll('.sp-item')];
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[next].focus();
  }
});

/* ---------- 侧边对话 ---------- */
function spSideNodes() {
  return (currentTask?.nodes || []).filter((n) => n.edgeKind === 'side' || n.sideOf);
}

/** 回收侧边对话的流与定时器（不改 spChat.nodeId，方便重新打开同一段对话） */
function spUnmountSide() {
  if (spChat.es) { try { spChat.es.close(); } catch { /* ignore */ } spChat.es = null; }
  clearInterval(spChat.tick); spChat.tick = 0;
  clearTimeout(spChat.poll); spChat.poll = 0;
  $('sp-body')?.querySelectorAll('.model-pop').forEach((el) => el.remove());
  spChat.cot = null;
  spChat.busy = false;
  spChat.mounted = '';
}

async function spRenderSide(body, node) {
  const sides = spSideNodes();
  const cur = sides.find((n) => n.id === spChat.nodeId);
  if (cur) return spMountSide(body, cur);
  spUnmountSide();
  body.classList.remove('sp-body-chat');
  body.innerHTML = `
    <div class="sp-side">
      <button type="button" class="btn-primary sp-side-new" data-sp-new>＋ 基于当前会话开启侧边对话</button>
      <p class="sp-side-note">把当前会话最近的上下文摘录成一份独立会话，在右侧并行对话；主会话不受影响，两边可以同时进行。</p>
      ${sides.length ? `<div class="sp-side-list">${sides.map((n) => `
        <button type="button" class="sp-side-item" data-sp-side="${n.id}">
          <span class="sp-side-item-title">${escapeHtml(n.title || '侧边对话')}</span>
          <span class="sp-side-item-meta">${toolLabel(n.tool)} · ${fmtTime(n.lastActivity || n.createdAt)} · ${n.summary?.messageCount || 0} 条消息</span>
        </button>`).join('')}</div>` : ''}
    </div>`;

  const newBtn = body.querySelector('[data-sp-new]');
  newBtn?.addEventListener('click', async () => {
    if (!currentTask || !node) return;
    newBtn.disabled = true;
    const label = newBtn.textContent;
    newBtn.textContent = '正在创建…';
    try {
      const r = await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/side-chat`, { method: 'POST' });
      await refreshTask();
      spChat.nodeId = r.node.id;
      spLastKey = '';
      spRender();
      toast(`侧边对话已创建（带入约 ${r.seedTokens} tokens 上下文）`);
    } catch (err) {
      toast(err.message);
      newBtn.disabled = false;
      newBtn.textContent = label;
    }
  });
  body.querySelectorAll('[data-sp-side]').forEach((btn) => {
    btn.addEventListener('click', () => {
      spChat.nodeId = btn.dataset.spSide;
      spLastKey = '';
      spRender();
    });
  });
}

/** 把一段独立会话挂进面板：自己的 SSE 流 + 自己的无头发送通道 */
function spMountSide(body, sideNode) {
  if (spChat.mounted === sideNode.id && body.querySelector('.sp-chat')) return;
  spUnmountSide();
  spChat.mounted = sideNode.id;
  body.classList.add('sp-body-chat');
  body.innerHTML = `
    <div class="sp-chat">
      <div class="sp-chat-head">
        <span class="sp-chat-title" title="${escapeHtml(sideNode.title || '侧边对话')}">${escapeHtml(sideNode.title || '侧边对话')}</span>
        <button type="button" class="sp-chat-new" data-sp-switch title="切换 / 新建侧边对话">↺</button>
      </div>
      <div class="sp-chat-list" data-sp-list></div>
      <div class="sp-chat-status" data-sp-status hidden></div>
      <div class="sp-chat-compose">
        <button type="button" class="sp-chat-attach" data-sp-attach title="引用本地文件">＋</button>
        <textarea data-sp-input rows="1" placeholder="在侧边对话里问点别的…（Enter 发送）"></textarea>
        <button type="button" class="sp-chat-model" data-sp-model title="切换这个侧边会话的模型">
          <span data-sp-modelname>模型</span>${icon('chevronDown', 10)}
        </button>
        <button type="button" class="sp-chat-send" data-sp-send>发送</button>
      </div>
    </div>`;
  const listEl = body.querySelector('[data-sp-list]');
  const statusEl = body.querySelector('[data-sp-status]');
  const ta = body.querySelector('[data-sp-input]');
  const sendBtn = body.querySelector('[data-sp-send]');
  const attachBtn = body.querySelector('[data-sp-attach]');

  const nearBottom = () => listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 60;
  const toBottom = () => { listEl.scrollTop = listEl.scrollHeight; };
  const cot = createCotTimeline(listEl, {
    node: sideNode,
    isFirstBatch: () => false,
    nearBottom,
    toBottom,
    scheduleStreamUi: () => {},
    isTerminalRunning: () => false,
    isHeadlessRunning: () => spChat.busy,
    headlessElapsed: () => (spChat.busy ? Date.now() - spChat.startedAt : 0),
    scrollEl: listEl,
    hideSeed: true,     // 上下文种子隐式继承，不占对话流
    hideBranch: true,   // 侧边里的回答不给分支按钮，避免到处开枝散叶
  });
  spChat.cot = cot;
  cot.showEmpty('侧边对话已就绪，直接问就行。');
  cot.setConnected(true);

  const es = new EventSource(`/api/stream?tool=${encodeURIComponent(sideNode.tool)}&file=${encodeURIComponent(sideNode.file)}&tail=120`);
  spChat.es = es;
  es.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    cot.setConnected(true);
    cot.handle(evt);
    if (nearBottom() || evt.kind === 'user') toBottom();
  };
  es.onerror = () => cot.setConnected(false);
  spChat.tick = setInterval(() => cot.tick(), 500);

  /* 模型：和主对话共用接口（数据源就是各 CLI 自己的配置），切换只影响这条侧边会话 */
  const modelBtn = body.querySelector('[data-sp-model]');
  const modelNameEl = body.querySelector('[data-sp-modelname]');
  const composeEl = body.querySelector('.sp-chat-compose');
  const shortModel = (s) => String(s || '').replace(/\[[^\]]+\]$/, '');
  const modelSyncOn = () => userSettings.syncModel !== false;
  let modelPop = null;
  let modelData = { current: '', options: [] };
  const closeModelPop = () => { if (modelPop) { modelPop.remove(); modelPop = null; } };
  const setModelLabel = (m) => {
    if (!modelNameEl) return;
    modelNameEl.textContent = shortModel(m) || '模型';
    if (modelBtn) modelBtn.title = m ? `当前模型：${m}（点击切换）` : '切换这个侧边会话的模型';
  };
  const loadModel = async () => {
    try {
      const d = await api(`/api/tasks/${currentTask.id}/nodes/${sideNode.id}/model?sync=${modelSyncOn() ? 1 : 0}`);
      modelData = d;
      setModelLabel(d.current);
    } catch { /* 读不到就保持原样 */ }
  };
  const applyModel = async (opt) => {
    if (!opt) return;
    closeModelPop();
    try {
      const r = await api(`/api/tasks/${currentTask.id}/nodes/${sideNode.id}/model`, {
        method: 'POST',
        body: { model: opt.id, provider: opt.provider || null, sync: modelSyncOn() },
      });
      modelData.current = opt.id;
      setModelLabel(opt.id);
      toast(r.applied === 'term'
        ? `已切换模型：${shortModel(opt.id)}（终端已同步）`
        : `已切换模型：${shortModel(opt.id)}（下条消息生效）`);
    } catch (err) { toast(err.message); }
  };
  const openModelPop = async () => {
    if (modelPop) { closeModelPop(); return; }
    await loadModel();
    modelPop = document.createElement('div');
    modelPop.className = 'model-pop';
    modelPop.innerHTML = `
      <input class="model-search" data-role="spmodelsearch" placeholder="搜索模型…" autocomplete="off" />
      <div class="model-list" data-role="spmodellist"></div>
      <div class="model-foot">${modelSyncOn() ? '与终端同步：开' : '与终端同步：关（在设置里改）'}</div>`;
    composeEl.appendChild(modelPop);
    const listEl2 = modelPop.querySelector('[data-role="spmodellist"]');
    const input = modelPop.querySelector('[data-role="spmodelsearch"]');
    const paint = (q) => {
      const kw = String(q || '').trim().toLowerCase();
      const opts = (modelData.options || []).filter((o) => !kw
        || String(o.id).toLowerCase().includes(kw)
        || String(o.label || '').toLowerCase().includes(kw));
      listEl2.innerHTML = opts.length ? opts.slice(0, 200).map((o, i) => `
        <button type="button" class="model-item ${o.id === modelData.current ? 'active' : ''}" data-mi="${i}">
          <span class="model-item-label">${escapeHtml(o.label || o.id)}</span>
          <span class="model-item-note">${escapeHtml(o.note || '')}</span>
        </button>`).join('') : '<div class="model-empty">没有匹配的模型</div>';
      listEl2.querySelectorAll('[data-mi]').forEach((b) => {
        b.onclick = () => applyModel(opts[Number(b.dataset.mi)]);
      });
    };
    paint('');
    input.addEventListener('input', () => paint(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeModelPop(); }
    });
    input.focus();
    setTimeout(() => {
      const outside = (e) => {
        if (modelPop && !modelPop.contains(e.target) && !modelBtn.contains(e.target)) closeModelPop();
      };
      document.addEventListener('click', outside, { once: true });
    }, 0);
  };
  modelBtn?.addEventListener('click', (e) => { e.stopPropagation(); openModelPop(); });
  loadModel();

  /* 「＋」菜单：上传文件 / 当前工具支持的斜杠命令 */
  attachBtn?.addEventListener('click', () => {
    openPlusMenu({
      anchor: attachBtn,
      tool: sideNode.tool,
      stacked: true,
      onFiles: async () => {
        if (attachBtn.disabled) return;
        attachBtn.disabled = true;
        try {
          const paths = await pickLocalFiles();
          if (paths.length) {
            appendFileRefs(ta, paths);
            toast(`已引用 ${paths.length} 个文件`);
          }
        } finally { attachBtn.disabled = false; }
      },
      onCommand: (cmd) => {
        ta.value = `/${cmd} `;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* ignore */ }
      },
    });
  });

  const setBusy = (v) => {
    spChat.busy = v;
    sendBtn.disabled = v;
    sendBtn.textContent = v ? '执行中' : '发送';
    statusEl.hidden = !v;
    if (v) statusEl.textContent = '● AI 正在执行…';
  };

  const pollStatus = () => {
    clearTimeout(spChat.poll);
    const tick = async () => {
      if (!spChat.busy) return;
      let st = null;
      try { st = (await api(`/api/tasks/${currentTask.id}/headless-status?nodeId=${sideNode.id}`)).status; } catch { /* 下轮再试 */ }
      if (st && !st.running) {
        setBusy(false);
        if (st.canceled) toast('已取消执行');
        else if (st.timedOut) toast('执行超时，已终止');
        else if (st.exitCode !== 0 && st.stderrTail) toast('执行失败: ' + st.stderrTail.slice(-140));
        cot.refresh();
        return;
      }
      spChat.poll = setTimeout(tick, 2000);
    };
    tick();
  };

  const send = async () => {
    const text = ta.value.trim();
    if (!text || spChat.busy) return;
    ta.value = '';
    ta.style.height = 'auto';
    spChat.startedAt = Date.now();
    setBusy(true);
    cot.addLocalUser(text);
    toBottom();
    try {
      await api(`/api/tasks/${currentTask.id}/send-headless`, { method: 'POST', body: { nodeId: sideNode.id, message: text } });
    } catch (err) {
      setBusy(false);
      cot.refresh();
      toast(err.message);
      return;
    }
    pollStatus();
  };
  sendBtn.addEventListener('click', send);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(120, ta.scrollHeight)}px`;
  });
  body.querySelector('[data-sp-switch]')?.addEventListener('click', () => {
    spChat.nodeId = null;
    spLastKey = '';
    spRender();
  });
  setTimeout(() => { ta.focus(); toBottom(); }, 30);
}

/* ---------- 改动 ---------- */
async function spRenderDiff(body, node) {
  if (spState.file) {
    const data = await api(`${spApiBase(node)}/changes?path=${encodeURIComponent(spState.file)}`);
    const lines = String(data.diff || '').split('\n').slice(0, 2000);
    body.innerHTML = `
      <div class="sp-file-head">
        <button type="button" class="sp-link" data-sp-back>← 改动列表</button>
        <span class="sp-file-name" title="${escapeHtml(data.file)}">${escapeHtml(data.file)}</span>
      </div>
      <div class="sp-meta">+${data.added || 0} / -${data.deleted || 0}${data.truncated ? ' · 已截断' : ''}</div>
      <pre class="sp-diff">${lines.map((l) => {
        const cls = l.startsWith('+++') || l.startsWith('---') ? 'diff-head'
          : l.startsWith('+') ? 'diff-add'
            : l.startsWith('-') ? 'diff-del'
              : l.startsWith('@@') ? 'diff-hunk' : '';
        return `<span class="dl-line ${cls}">${escapeHtml(l) || ' '}</span>`;
      }).join('')}</pre>`;
    body.querySelector('[data-sp-back]')?.addEventListener('click', () => {
      spState.file = null;
      spLastKey = '';
      spRender();
    });
    return;
  }

  const data = await api(`${spApiBase(node)}/changes`);
  if (!data.isGit) {
    body.innerHTML = `<div class="sp-empty">${escapeHtml(data.reason || '这个会话目录不是 git 仓库')}<br /><span class="sp-dim">${escapeHtml(data.cwd || '')}</span></div>`;
    return;
  }
  const files = data.files || [];
  body.innerHTML = `
    <div class="sp-meta">
      <span class="chip ${node.tool}">${toolLabel(node.tool)}</span>
      <span class="sp-branch">${escapeHtml(data.branch || '?')}</span>
      <span class="sp-dim">${files.length ? `${files.length} 个改动` : '工作区干净'}</span>
    </div>
    ${files.length ? `<div class="sp-list">${files.map((f) => {
      const kind = f.code === '??' ? 'N' : f.code.includes('D') ? 'D' : 'M';
      return `
      <button type="button" class="sp-file" data-file="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
        <span class="sp-file-status s-${kind}">${escapeHtml(f.label)}</span>
        <span class="sp-file-path">${escapeHtml(f.path)}</span>
      </button>`;
    }).join('')}</div>` : '<div class="sp-empty">没有未提交的改动</div>'}
    ${data.stat ? `<pre class="sp-stat">${escapeHtml(data.stat)}</pre>` : ''}`;
  body.querySelectorAll('[data-file]').forEach((btn) => {
    btn.addEventListener('click', () => {
      spState.file = btn.dataset.file;
      spLastKey = '';
      spRender();
    });
  });
}

/* ---------- 文件 ---------- */
async function spRenderFiles(body, node) {
  if (spState.file) {
    const data = await api(`${spApiBase(node)}/files?read=1&path=${encodeURIComponent(spState.file)}`);
    const text = data.binary
      ? '（二进制文件，无法预览）'
      : data.truncated ? `（文件 ${(data.size / 1024).toFixed(0)}KB，超出预览上限）` : String(data.text || '');
    body.innerHTML = `
      <div class="sp-file-head">
        <button type="button" class="sp-link" data-sp-back>← ${escapeHtml(spState.dir || '根目录')}</button>
        <span class="sp-file-name" title="${escapeHtml(data.path)}">${escapeHtml(data.path.split('/').pop())}</span>
      </div>
      <pre class="sp-code">${escapeHtml(text)}</pre>`;
    body.querySelector('[data-sp-back]')?.addEventListener('click', () => {
      spState.file = null;
      spLastKey = '';
      spRender();
    });
    return;
  }

  const data = await api(`${spApiBase(node)}/files?path=${encodeURIComponent(spState.dir)}`);
  const parts = String(data.dir || '').split('/').filter(Boolean);
  const crumbs = [`<button type="button" class="sp-crumb" data-go="">根目录</button>`]
    .concat(parts.map((p, i) => `<span class="sp-sep">/</span><button type="button" class="sp-crumb" data-go="${escapeHtml(parts.slice(0, i + 1).join('/'))}">${escapeHtml(p)}</button>`));
  body.innerHTML = `
    <div class="sp-crumbs">${crumbs.join('')}</div>
    <div class="sp-list">${(data.entries || []).map((e) => `
      <button type="button" class="sp-file" data-entry="${escapeHtml(e.name)}" data-type="${e.type}">
        <span class="sp-item-icon">${e.type === 'dir' ? icon('folder', 14) : icon('file', 14)}</span>
        <span class="sp-file-path">${escapeHtml(e.name)}</span>
        ${e.type === 'file' ? `<span class="sp-dim">${e.size > 1024 ? `${Math.round(e.size / 1024)}KB` : `${e.size}B`}</span>` : ''}
      </button>`).join('') || '<div class="sp-empty">空目录</div>'}</div>`;
  body.querySelectorAll('[data-crumb], [data-go]').forEach((btn) => {
    btn.addEventListener('click', () => {
      spState.dir = btn.dataset.go || '';
      spLastKey = '';
      spRender();
    });
  });
  body.querySelectorAll('[data-entry]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.entry;
      const next = spState.dir ? `${spState.dir}/${name}` : name;
      if (btn.dataset.type === 'dir') spState.dir = next;
      else spState.file = next;
      spLastKey = '';
      spRender();
    });
  });
}

/* ---------- 上下文 ---------- */
async function spRenderContext(body, node) {
  if (typeof renderCtxInto === 'function') {
    await renderCtxInto(body, node);
    return;
  }
  const data = await api(`/api/tasks/${currentTask.id}/context`);
  body.innerHTML = `<pre class="sp-code">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
}

/* ---------- Worktree ---------- */
async function spRenderWorktree(body, node) {
  const data = await api(`/api/tasks/${currentTask.id}/worktrees`);
  const info = (data.worktrees || []).find((w) => w.nodeId === node.id);
  if (!info) {
    body.innerHTML = `<div class="sp-empty">这个会话没有独立的 sbridge worktree<br /><span class="sp-dim">非 git 仓库，或创建会话时主工作区不干净</span></div>`;
    return;
  }
  const base = `/api/tasks/${currentTask.id}/nodes/${node.id}/worktree-changes`;

  // 单文件 diff：从这里能直接看 worktree 里改了什么（不只是状态数字）
  if (spState.wtFile) {
    const d = await api(`${base}?path=${encodeURIComponent(spState.wtFile)}`);
    const lines = String(d.diff || '').split('\n').slice(0, 2000);
    body.innerHTML = `
      <div class="sp-file-head">
        <button type="button" class="sp-link" data-wt-back>← worktree</button>
        <span class="sp-file-name" title="${escapeHtml(d.file || '')}">${escapeHtml(d.file || '')}</span>
      </div>
      <div class="sp-meta">+${d.added || 0} / -${d.deleted || 0}${d.truncated ? ' · 已截断' : ''}</div>
      <pre class="sp-diff">${lines.map((l) => {
        const cls = l.startsWith('+++') || l.startsWith('---') ? 'diff-head'
          : l.startsWith('+') ? 'diff-add'
            : l.startsWith('-') ? 'diff-del'
              : l.startsWith('@@') ? 'diff-hunk' : '';
        return `<span class="dl-line ${cls}">${escapeHtml(l) || ' '}</span>`;
      }).join('')}</pre>`;
    body.querySelector('[data-wt-back]')?.addEventListener('click', () => {
      spState.wtFile = null;
      spLastKey = '';
      spRender();
    });
    return;
  }

  let changes = null;
  try { changes = await api(base); } catch { /* 读不到改动就只展示状态 */ }
  const files = changes?.files || [];
  body.innerHTML = `
    <div class="sp-meta">
      <span class="sp-branch">${escapeHtml(info.branch)}</span>
      <span class="sp-dim">→ ${escapeHtml(info.base || '?')}</span>
    </div>
    <div class="sp-kv"><span>领先</span><b>${info.ahead}</b><span>落后</span><b>${info.behind}</b></div>
    <div class="sp-kv"><span>状态</span><b class="${info.dirtyCount ? 'sp-warn' : ''}">${info.merged ? '已合并' : info.dirtyCount ? `${info.dirtyCount} 个未提交改动` : '工作区干净'}</b></div>
    <div class="sp-kv"><span>路径</span><code class="sp-path">${escapeHtml(info.path)}</code></div>
    <div class="sp-actions">
      <button type="button" class="btn-primary" data-sp-merge ${info.merged || info.dirtyCount || !info.ahead ? 'disabled' : ''}>合并到 ${escapeHtml(info.base || '主分支')}</button>
      <button type="button" class="btn-ghost" data-sp-open>打开完整弹窗</button>
    </div>
    <div class="sp-subtitle">worktree 里的改动${files.length ? ` · ${files.length}` : ''}</div>
    ${files.length ? `<div class="sp-list">${files.map((f) => {
      const kind = f.code === '??' ? 'N' : f.code.includes('D') ? 'D' : 'M';
      return `
      <button type="button" class="sp-file" data-wt-file="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
        <span class="sp-file-status s-${kind}">${escapeHtml(f.label)}</span>
        <span class="sp-file-path">${escapeHtml(f.path)}</span>
      </button>`;
    }).join('')}</div>` : `<div class="sp-empty">${info.dirtyCount ? '改动列表读取失败，可打开完整弹窗查看' : '没有未提交改动'}</div>`}`;
  body.querySelectorAll('[data-wt-file]').forEach((btn) => {
    btn.addEventListener('click', () => {
      spState.wtFile = btn.dataset.wtFile;
      spLastKey = '';
      spRender();
    });
  });
  body.querySelector('[data-sp-open]')?.addEventListener('click', () => openWorktreeModal(node));
  body.querySelector('[data-sp-merge]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api(`/api/tasks/${currentTask.id}/worktrees/merge`, { method: 'POST', body: { nodeId: node.id } });
      toast(`已合并 ${info.branch} → ${info.base}`);
      spLastKey = '';
      spRender();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
}

/* ---------- 绑定 ---------- */
function initSidePanel() {
  $('btn-panel')?.addEventListener('click', () => toggleSidePanel());
  $('sp-close')?.addEventListener('click', () => toggleSidePanel(false));
  $('sp-back')?.addEventListener('click', spBack);
  initSideResizer();
}
