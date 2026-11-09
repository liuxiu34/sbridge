/* sbridge · 会话标签与布局：打开/关闭标签、分屏、焦点、面板渲染 */

/* ---------------- 会话标签页管理（主战场 / 支持左右分屏） ---------------- */
let openTabs = [];        // 已打开会话的 nodeId（有序）
let activeTabId = null;   // 当前焦点槽位的 nodeId
let paneHandles = new Map(); // nodeId -> pane handle
let boardMode = false;    // 主区显示完整白板
let boardSel = new Set(); // 白板框选中的会话 id（仅白板视图内生效）
let layout = { mode: 'single', slots: [null, null], focused: 0 };

function findNode(nodeId) { return currentTask?.nodes.find((n) => n.id === nodeId) || null; }

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
  const el = $('sess-tabs');
  const visible = visiblePaneIds();
  el.innerHTML = openTabs.map((id) => {
    const n = findNode(id);
    if (!n) return '';
    const run = nodeTermFor(n);
    return `<div class="stab ${visible.includes(id) && !boardMode ? 'active' : ''} ${id === activeTabId && !boardMode ? 'focused' : ''}" data-tab="${id}" title="${escapeHtml(n.title || '')}">
      <span class="chip ${n.tool}">${toolLabel(n.tool)}</span>
      <span class="stab-title">${escapeHtml(truncate(n.title || '(会话)', 22))}</span>
      ${run ? '<span class="run-dot"></span>' : ''}
      <span class="stab-x" data-close="${id}" title="关闭标签">×</span>
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
      paneHandles.set(id, createSessionPane(host, node, { active: true }));
    }
    host.hidden = !visible.includes(id);
    host.classList.toggle('focused', id === activeTabId && !boardMode);
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
    area.insertAdjacentHTML('beforeend', `<div class="workspace-empty" id="ws-empty"><div class="empty-icon">⌨</div><h2>选择或新建一个会话</h2><p>点侧栏「会话链」里的卡片，或「新开会话 / 接入已有会话」。</p></div>`);
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
  if (!currentTask || currentTask.nodes.length < 2) {
    toast('当前任务至少要有两个会话才能分屏');
    return;
  }
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

function toggleSplit(force) {
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
  if (!currentTask || currentTask.nodes.length < 2) {
    toast('当前任务至少要有两个会话才能分屏');
    return;
  }
  const fallback = currentTask.nodes[currentTask.nodes.length - 1];
  const leftNode = findNode(layout.slots[0] || activeTabId || openTabs[0]) || fallback;
  const candidates = currentTask.nodes.filter((n) => n.id !== leftNode.id);
  const rightNode = candidates.find((n) => n.tool !== leftNode.tool) || candidates[0];
  if (!rightNode) {
    toast('没有可放到另一侧的会话');
    return;
  }
  layout.mode = 'split';
  layout.slots[0] = leftNode.id;
  layout.slots[1] = null;
  layout.focused = 0;
  if (!openTabs.includes(leftNode.id)) openTabs.push(leftNode.id);
  openSessionTab(rightNode.id, { slot: 1, split: true });
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
  const options = currentTask.nodes.filter((n) => n.id !== left);
  select.innerHTML = options.map((n) => `<option value="${escapeHtml(n.id)}">${escapeHtml(`${toolLabel(n.tool)} · ${truncate(n.title || '(会话)', 24)}`)}</option>`).join('');
  select.value = layout.slots[1] || '';
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
    return `<div class="mini-card ${visible.includes(n.id) && !boardMode ? 'active' : ''} ${n.id === activeTabId && !boardMode ? 'focused' : ''}" data-mnode="${n.id}" style="margin-left:${Math.min(depth, 6) * 14}px" title="${escapeHtml(n.title || '')}">
      <span class="chip ${n.tool}">${toolLabel(n.tool)}</span>
      <span class="mini-title">${escapeHtml(truncate(n.title || '(会话)', 16))}</span>
      ${run ? '<span class="run-dot"></span>' : ''}
    </div>`;
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

