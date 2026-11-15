/* sbridge · 会话标签与布局：打开/关闭标签、分屏、焦点、面板渲染 */

/* ---------------- 会话标签页管理（主战场 / 支持左右分屏） ---------------- */
let openTabs = [];        // 已打开会话的 nodeId（有序）
let activeTabId = null;   // 当前焦点槽位的 nodeId
let paneHandles = new Map(); // nodeId -> pane handle
let boardMode = false;    // 主区显示完整白板
let boardSel = new Set(); // 白板框选中的会话 id（仅白板视图内生效）
let layout = { mode: 'single', slots: [null, null], focused: 0 };

/* ---------------- 跨任务会话（分屏不再限定同一任务） ----------------
 * 整个前端以 currentTask 为「当前任务」，但分屏/标签要能承载其他任务的会话：
 * 这里维护 taskId→任务详情、nodeId→taskId 两张索引，findNode 先查当前任务再查缓存。
 * 任务详情只从 /api/tasks/:id 拿（node id 是 12 位随机 hex，全局唯一）。 */
const taskCache = new Map();
const nodeTask = new Map();
function cacheTask(task) {
  if (!task?.id) return task;
  taskCache.set(task.id, task);
  for (const n of task.nodes || []) nodeTask.set(n.id, task.id);
  return task;
}
function taskForNode(nodeId) {
  const tid = nodeTask.get(nodeId);
  if (!tid) return null;
  return tid === currentTask?.id ? currentTask : taskCache.get(tid) || null;
}
function taskIdForNode(nodeId) { return taskForNode(nodeId)?.id || nodeTask.get(nodeId) || currentTask?.id || null; }
async function ensureTaskDetail(taskId) {
  if (!taskId) return null;
  if (taskId === currentTask?.id) return currentTask;
  const hit = taskCache.get(taskId);
  if (hit) return hit;
  const detail = await api(`/api/tasks/${taskId}`);
  return cacheTask(detail);
}

function findNode(nodeId) {
  const own = currentTask?.nodes?.find((n) => n.id === nodeId);
  if (own) return own;
  return taskForNode(nodeId)?.nodes?.find((n) => n.id === nodeId) || null;
}

/* 聚焦会话属于别的任务时，把「当前任务」上下文切过去（侧栏会话链、白板、任务标题随之更新），
   但绝不销毁已打开的面板/标签：会话视图的生命周期与任务切换解耦。
   只做侧栏/白板的刷新，不调用 openTask()（那会重建面板）。 */
let syncingTaskContext = null;
function syncTaskContextTo(nodeId) {
  const tid = nodeTask.get(nodeId);
  if (!tid || !currentTask || tid === currentTask.id) return Promise.resolve();
  const detail = taskCache.get(tid);
  if (!detail) return Promise.resolve(); // 详情还没进来（跨任务首次打开），由 openSessionTabInTask 负责
  currentTask = detail;
  currentTaskId = tid;
  if (syncingTaskContext === tid) return Promise.resolve();
  syncingTaskContext = tid;
  try {
    if (typeof renderTree === 'function') renderTree();
    if (typeof renderBoard === 'function') renderBoard();
    const actions = $('task-actions');
    if (actions) actions.hidden = false;
    boardSel.clear();
    if (typeof closeBoardMenu === 'function') closeBoardMenu();
    // 侧栏会话链与 Git 胶囊跟当前任务走
    if (typeof renderMiniChain === 'function') renderMiniChain();
  } catch { /* 侧栏未初始化时忽略 */ }
  syncingTaskContext = null;
  return Promise.resolve();
}

function validTabIds() { return openTabs.filter((id) => findNode(id)); }
function visiblePaneIds() {
  return layout.mode === 'split' ? layout.slots.filter(Boolean) : [layout.slots[0]].filter(Boolean);
}
function syncActiveTabId() {
  const ids = visiblePaneIds();
  activeTabId = layout.slots[layout.focused] || ids[ids.length - 1] || null;
}
function normalizeLayout() {
  const valid = new Set(validTabIds());
  layout.slots = layout.slots.map((id) => (valid.has(id) ? id : null));
  if (layout.mode === 'split') {
    if (!layout.slots[0] || !layout.slots[1]) {
      const rest = [...valid].filter((id) => !layout.slots.includes(id));
      if (!layout.slots[0]) layout.slots[0] = rest.shift() || null;
      if (!layout.slots[1]) layout.slots[1] = rest.shift() || null;
    }
    if (!layout.slots[0] || !layout.slots[1] || layout.slots[0] === layout.slots[1]) {
      layout.mode = 'single';
      layout.slots[1] = null;
      layout.focused = 0;
    }
  } else {
    if (!layout.slots[0]) layout.slots[0] = [...valid][0] || null;
    layout.slots[1] = null;
    layout.focused = 0;
  }
  syncActiveTabId();
}

function openSessionTab(nodeId, { activate = true, slot = null, split = false } = {}) {
  if (!findNode(nodeId)) return;
  if (!openTabs.includes(nodeId)) openTabs.push(nodeId);
  boardMode = false;
  // 聚焦的会话属于别的任务时，让「当前任务」跟过去（侧栏会话链/白板随之切换），
  // 但已打开的面板与标签一律保留——切任务不再销毁会话视图。
  void syncTaskContextTo(nodeId);
  if (split) layout.mode = 'split';
  if (layout.mode === 'split') {
    const target = slot === 0 || slot === 1 ? slot : layout.focused;
    if (!layout.slots[0]) {
      layout.slots[0] = activeTabId && activeTabId !== nodeId && findNode(activeTabId)
        ? activeTabId
        : openTabs.find((id) => id !== nodeId && findNode(id)) || null;
    }
    const existing = layout.slots.indexOf(nodeId);
    if (existing !== -1 && existing !== target) {
      layout.focused = existing; // 同一会话不重复占两个槽位
    } else {
      layout.slots[target] = nodeId;
      layout.focused = target;
    }
    if (layout.slots[0] === layout.slots[1]) {
      layout.slots[1] = openTabs.find((id) => id !== layout.slots[0] && findNode(id)) || null;
      layout.focused = 0;
    }
  } else {
    layout.slots[0] = nodeId;
    layout.slots[1] = null;
    layout.focused = 0;
  }
  normalizeLayout();
  renderTabs();
  renderPanes();
}

/* 其他任务的会话：先把任务详情装进缓存，再走同一条打开路径（分屏/单栏都适用） */
async function openSessionTabInTask(nodeId, taskId, opts = {}) {
  if (!findNode(nodeId)) {
    try { await ensureTaskDetail(taskId); } catch (err) { toast(err.message); return; }
  }
  openSessionTab(nodeId, opts);
}
function closeTab(nodeId) {
  const h = paneHandles.get(nodeId);
  if (h) { try { h.close(); } catch { /* ignore */ } paneHandles.delete(nodeId); }
  openTabs = openTabs.filter((id) => id !== nodeId);
  if (layout.mode === 'split') {
    const closedSlot = layout.slots.indexOf(nodeId);
    if (closedSlot !== -1) layout.slots[closedSlot] = null;
    const rest = openTabs.filter((id) => findNode(id) && !layout.slots.includes(id));
    for (let i = 0; i < 2; i++) {
      if (!layout.slots[i] && rest.length) layout.slots[i] = rest.shift();
    }
    if (!layout.slots[0] || !layout.slots[1] || layout.slots[0] === layout.slots[1]) {
      layout.mode = 'single';
      layout.slots[1] = null;
      if (!layout.slots[0]) layout.slots[0] = rest[0] || openTabs[openTabs.length - 1] || null;
      layout.focused = 0;
    } else if (layout.focused === closedSlot) {
      layout.focused = closedSlot === 0 ? 1 : 0;
    }
  } else {
    layout.slots[0] = openTabs[openTabs.length - 1] || null;
    layout.slots[1] = null;
    layout.focused = 0;
  }
  normalizeLayout();
  renderTabs();
  renderPanes();
}

function toggleBoardView(force) {
  boardMode = force !== undefined ? force : !boardMode;
  if (!boardMode) { boardSel.clear(); closeBoardMenu(); }
  renderTabs();
  renderPanes();
  if (boardMode) renderBoard();
}

function renderTabs() {
  $('workspace-project').textContent = currentTask?.project?.name || state.projects.find((p) => p.id === currentTask?.projectId)?.name || '独立任务';
  $('workspace-task').textContent = currentTask?.title || '开始新的工作';
  const el = $('sess-tabs');
  const visible = visiblePaneIds();
  el.innerHTML = openTabs.map((id) => {
    const n = findNode(id);
    if (!n) return '';
    const run = nodeTermFor(n);
    const owner = taskForNode(id);
    // 跨任务标签在标题前加任务名，防止两个任务里的同名会话混淆；任务名与会话名相同时不重复
    const crossTask = owner && currentTask && owner.id !== currentTask.id;
    const sameTitle = crossTask && String(owner.title || '') === String(n.title || '');
    return `<div class="stab ${visible.includes(id) && !boardMode ? 'active' : ''} ${id === activeTabId && !boardMode ? 'focused' : ''}" data-tab="${id}" title="${escapeHtml(n.title || '')}${crossTask && !sameTitle ? ` · 任务：${escapeHtml(owner.title || '')}` : ''}">
      <span class="chip ${n.tool}">${toolLabel(n.tool)}</span>
      ${crossTask && !sameTitle ? `<span class="stab-task">${escapeHtml(truncate(owner.title || '任务', 10))}</span>` : ''}
      <span class="stab-title">${escapeHtml(truncate(n.title || '(会话)', 22))}</span>
      ${run ? '<span class="run-dot"></span>' : ''}
      <button class="stab-x" data-close="${id}" title="关闭标签" aria-label="关闭 ${escapeHtml(n.title || '会话')}">${icon('x', 11)}</button>
    </div>`;
  }).join('') || '<div class="tabs-empty">没有打开的会话</div>';
  updateSplitControls();
  // 侧栏高亮跟顶部标签同源（activeTabId/slots）——挂在这里保证打开/关闭/切换标签时
  // 左侧会话链立刻跟上。此前只在全量 render() 里刷新，点卡片切换时侧栏高亮慢几拍。
  renderMiniChain();
  // 右侧面板跟随当前聚焦会话（面板未打开时内部直接 return）
  if (typeof refreshSidePanel === 'function') refreshSidePanel();
}

function renderPanes() {
  const area = $('pane-area');
  normalizeLayout();
  // 清理已关闭标签的面板句柄
  for (const [id, h] of [...paneHandles]) {
    if (!openTabs.includes(id)) {
      try { h.close(); } catch { /* ignore */ }
      paneHandles.delete(id);
    }
  }
  // closeTab() 会先删句柄再调用这里；必须按 openTabs 清理全部孤儿宿主，
  // 否则残留的 .pane-host 仍可见，但按钮监听已经失效。
  area.querySelectorAll('.pane-host').forEach((host) => {
    if (!openTabs.includes(host.dataset.paneHost)) host.remove();
  });
  $('board-wrap').hidden = !boardMode;
  const boardHint = $('board-hint');
  if (boardHint) boardHint.hidden = !boardMode;
  area.classList.toggle('hidden', boardMode);
  area.classList.toggle('split', layout.mode === 'split' && !boardMode);
  if (boardMode) return;

  const visible = visiblePaneIds();
  // 确保每个打开的 tab 都有常驻面板（后台 SSE 持续积累，切走不中断）
  for (const id of openTabs) {
    const node = findNode(id);
    if (!node) continue;
    let host = area.querySelector(`[data-pane-host="${id}"]`);
    if (host && !paneHandles.has(id)) host.remove(); // 有 DOM 没句柄的空壳，重建
    if (!host || !paneHandles.has(id)) {
      host = document.createElement('div');
      host.dataset.paneHost = id;
      host.className = 'pane-host';
      area.appendChild(host);
      paneHandles.set(id, createSessionPane(host, node, { active: true, taskId: taskIdForNode(id) }));
    }
    host.hidden = !visible.includes(id);
    host.classList.toggle('focused', id === activeTabId && !boardMode);
    // 所属任务标记：面板会话不在当前任务下时显示（切任务后仍能看出这栏来自哪里）
    const taskEl = host.querySelector('[data-role="panetask"]');
    if (taskEl) {
      const owner = taskForNode(id);
      const cross = owner && currentTask && owner.id !== currentTask.id;
      taskEl.hidden = !cross;
      taskEl.textContent = cross ? (owner.title || '其他任务') : '';
      taskEl.title = cross ? `所属任务：${owner.title || ''}` : '';
    }
  }
  // flex 顺序必须跟 slots 一致；openTabs 的创建顺序不能决定左右位置。
  const ordered = [...visible, ...openTabs.filter((id) => !visible.includes(id))];
  for (const id of ordered) {
    const host = area.querySelector(`[data-pane-host="${id}"]`);
    if (host) area.appendChild(host);
  }
  for (const id of visible) setTimeout(() => paneHandles.get(id)?.refit(), 60);
  area.querySelector('#ws-empty')?.remove();
  if (!openTabs.length && !area.querySelector('.workspace-empty')) {
    const taskEmpty = currentTask && !currentTask.nodes?.length;
    const extra = taskEmpty
      ? `<button class="btn-primary" id="ws-empty-launch" style="margin-top:14px">▶ 发起第一场对话（Pi / Codex / Claude）</button>`
      : '';
    area.insertAdjacentHTML('beforeend', `<div class="workspace-empty" id="ws-empty"><div class="empty-icon">⌨</div><h2>${taskEmpty ? '这个任务还没有会话' : '选择或新建一个会话'}</h2><p>${taskEmpty ? '选一个工具、指定工作目录，开一场全新对话。' : '点侧栏「会话链」里的卡片，或顶栏「接入已有会话」。'}</p>${extra}</div>`);
    if (taskEmpty) {
      area.querySelector('#ws-empty-launch')?.addEventListener('click', () => {
        if (!currentTask) { toast('先在左侧选中一个任务，再新开会话'); return; }
        const cwd = currentTask?.nodes?.find((n) => n.cwd)?.cwd || currentTask?.cwd || '';
        newSessionFlow(cwd);
      });
    }
  } else {
    area.querySelector('#ws-empty')?.remove();
  }
}

function updateFocusClasses() {
  document.querySelectorAll('.pane-host').forEach((host) => {
    host.classList.toggle('focused', host.dataset.paneHost === activeTabId && !boardMode);
  });
}

function setFocusedPane(nodeId) {
  const slot = layout.slots.indexOf(nodeId);
  if (slot === -1) return;
  if (layout.mode === 'single' && slot !== 0) return;
  layout.focused = slot;
  syncActiveTabId();
  renderTabs(); // 侧栏高亮由 renderTabs 内部的 renderMiniChain 同步刷新
  updateFocusClasses();
}

function openInOtherSlot(nodeId) {
  if (!findNode(nodeId)) return;
  const existing = layout.slots.indexOf(nodeId);
  if (existing !== -1) {
    setFocusedPane(nodeId);
    return;
  }
  const target = layout.focused === 0 ? 1 : 0;
  layout.mode = 'split';
  if (!layout.slots[0]) layout.slots[0] = activeTabId || openTabs.find((id) => id !== nodeId) || null;
  openSessionTab(nodeId, { slot: target, split: true });
}

/* 其他任务里「最近更新」的一个会话，作为分屏右侧候选（当前任务不够用时兜底） */
async function pickRemoteSplitNode(excludeId) {
  const others = (state.tasks || [])
    .filter((t) => t.id !== currentTask?.id && (t.nodeCount ?? 1) > 0)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  for (const t of others) {
    try {
      const detail = await ensureTaskDetail(t.id);
      const nodes = (detail?.nodes || []).filter((n) => n.id !== excludeId);
      if (nodes.length) return nodes[nodes.length - 1];
    } catch { /* 换下一个任务 */ }
  }
  return null;
}

async function toggleSplit(force) {
  const enable = force !== undefined ? force : layout.mode !== 'split';
  if (!enable) {
    layout.mode = 'single';
    layout.slots[1] = null;
    layout.focused = 0;
    normalizeLayout();
    renderTabs();
    renderPanes();
    return;
  }
  const leftNode = findNode(layout.slots[0] || activeTabId || openTabs[0]) || currentTask?.nodes?.at(-1) || null;
  if (!leftNode) { toast('先在左侧打开一个会话，再开分屏'); return; }
  // 右侧候选：同任务优先（不同工具更佳），当前任务没有第二个会话就退到其他任务最近的会话
  const ownCandidates = (currentTask?.nodes || []).filter((n) => n.id !== leftNode.id);
  let rightNode = ownCandidates.find((n) => n.tool !== leftNode.tool) || ownCandidates[0] || null;
  if (!rightNode) rightNode = await pickRemoteSplitNode(leftNode.id);
  if (!rightNode) {
    toast('没有可放到另一侧的会话');
    return;
  }
  layout.mode = 'split';
  layout.slots[0] = leftNode.id;
  layout.slots[1] = null;
  layout.focused = 0;
  if (!openTabs.includes(leftNode.id)) openTabs.push(leftNode.id);
  await openSessionTabInTask(rightNode.id, taskIdForNode(rightNode.id), { slot: 1, split: true });
}

/* 分屏右侧下拉：按任务分组列出所有任务的会话（其他任务详情按需拉取） */
let splitOptionsLoading = false;
const splitOptionsTried = new Set(); // 拉取失败的任务不再重试，避免下拉反复请求
function splitTaskList() {
  const list = [];
  if (currentTask) list.push(currentTask);
  for (const t of state.tasks || []) {
    if (t.id === currentTask?.id) continue;
    list.push(taskCache.get(t.id) || t);
  }
  return list;
}
async function loadSplitOptions() {
  if (splitOptionsLoading || layout.mode !== 'split' || boardMode) return;
  const pending = (state.tasks || []).filter((t) => t.id !== currentTask?.id && !taskCache.has(t.id) && (t.nodeCount ?? 1) > 0 && !splitOptionsTried.has(t.id));
  if (!pending.length) return;
  splitOptionsLoading = true;
  try {
    for (const t of pending) {
      splitOptionsTried.add(t.id);
      try { await ensureTaskDetail(t.id); } catch { /* 该任务稍后可在任务列表里打开 */ }
    }
  } finally { splitOptionsLoading = false; }
  updateSplitControls();
}

function updateSplitControls() {
  const btn = $('btn-split');
  const wrap = $('split-right-wrap');
  const select = $('split-right');
  if (!btn || !wrap || !select) return;
  const isSplit = layout.mode === 'split' && !!currentTask;
  btn.classList.toggle('active', isSplit);
  btn.setAttribute('aria-pressed', String(isSplit));
  btn.innerHTML = isSplit ? (icon('split') + ' 退出分屏') : (icon('split') + ' 分屏');
  wrap.hidden = !isSplit || boardMode;
  if (!isSplit || !currentTask) return;
  const left = layout.slots[0];
  const groups = splitTaskList().map((t) => {
    const nodes = (t.nodes || []).filter((n) => n.id !== left);
    if (!nodes.length) return '';
    return `<optgroup label="${escapeHtml(t.title || '任务')}">${nodes.map((n) =>
      `<option value="${escapeHtml(n.id)}">${escapeHtml(`${toolLabel(n.tool)} · ${truncate(n.title || '(会话)', 24)}`)}</option>`).join('')}</optgroup>`;
  }).join('');
  const pendingCount = (state.tasks || []).filter((t) => t.id !== currentTask?.id && !taskCache.has(t.id) && (t.nodeCount ?? 1) > 0 && !splitOptionsTried.has(t.id)).length;
  select.innerHTML = groups || (pendingCount ? '<option value="">正在读取其他任务的会话…</option>' : '<option value="">没有其他会话</option>');
  select.value = layout.slots[1] || '';
  if (pendingCount) void loadSplitOptions();
}

/* 侧栏迷你会话链（白板收敛到侧栏的形态）
 * 排序与白板视觉一致：先按行（y），再按列（x）——白板上一行的节点在链里连续 */
function renderMiniChain() {
  const el = $('mini-chain');
  if (!currentTask || !currentTask.nodes.length) {
    el.innerHTML = '<div class="empty-tree">选择任务后显示接力链</div>';
    return;
  }
  const visible = visiblePaneIds();
  const { positions } = computeLayout(currentTask.nodes);
  const items = [...currentTask.nodes].sort((a, b) => {
    const pa = positions.get(a.id) || { x: 0, y: 0 };
    const pb = positions.get(b.id) || { x: 0, y: 0 };
    return pa.y - pb.y || pa.x - pb.x || String(a.createdAt).localeCompare(String(b.createdAt));
  });
  el.innerHTML = items.map((n) => {
    const depth = Math.round((positions.get(n.id)?.x || 0) / 318);
    const run = nodeTermFor(n);
    const parent = findNode(n.parentNodeId);
    const phase = paneHandles.get(n.id)?.getStatus?.();
    const relation = parent ? `${n.edgeKind === 'branch' ? '分支自' : n.edgeKind === 'side' ? '侧聊自' : '接力自'} ${toolLabel(parent.tool)}` : '起始会话';
    const status = phase?.running ? (phase.phase === 'waiting-input' ? '待回答' : '执行中') : run ? '终端运行' : n.id === activeTabId && !boardMode ? '当前' : '';
    return `<button type="button" class="mini-card ${visible.includes(n.id) && !boardMode ? 'active' : ''} ${n.id === activeTabId && !boardMode ? 'focused' : ''}" data-mnode="${n.id}" style="--chain-indent:${Math.min(depth, 3) * 10}px" title="${escapeHtml(n.title || '')}${parent ? ` · ${escapeHtml(parent.title || '')}` : ''}">
      <span class="mini-content"><span class="mini-title">${escapeHtml(n.title || '(会话)')}</span>
      <span class="mini-meta"><span class="chip ${n.tool}">${toolLabel(n.tool)}</span><span>${escapeHtml(relation)}</span></span></span>
      ${status ? `<span class="mini-state ${phase?.running ? 'busy' : ''}">${status}</span>` : ''}
    </button>`;
  }).join('');
  el.querySelectorAll('[data-mnode]').forEach((c) => c.addEventListener('click', (e) => {
    if (e.shiftKey) openInOtherSlot(c.dataset.mnode);
    else openSessionTab(c.dataset.mnode);
  }));
}

function closeAllPanes() {
  for (const [, h] of paneHandles) { try { h.close(); } catch { /* ignore */ } }
  paneHandles.clear();
  // 同步移除已销毁的 DOM 宿主；否则再次打开同一任务会复用空壳，终端不会重新挂载
  $('pane-area').querySelectorAll('.pane-host').forEach((host) => host.remove());
  openTabs = [];
  activeTabId = null;
  boardMode = false;
  layout = { mode: 'single', slots: [null, null], focused: 0 };
  $('sess-tabs').innerHTML = '';
  updateSplitControls();
}

