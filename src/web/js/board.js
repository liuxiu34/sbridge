/* sbridge · 白板：布局计算、卡片/连线渲染、框选与右键操作 */

/* ---------------- 白板 ---------------- */
const CARD_W = 262;
const COL_GAP = 318;
const ROW_GAP = 176;
const MIN_GAP = 20;

/**
 * 树形紧凑布局：
 * - 接力链（单子节点链）保持同一 y，呈水平一条直线
 * - 分支（一个卡片多个子卡片）纵向展开，父卡片对齐第一个子卡片
 * - 独立新会话作为新根，排在下方
 */
function computeLayout(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenMap = new Map();
  const roots = [];
  for (const n of nodes) {
    if (n.parentNodeId && byId.has(n.parentNodeId)) {
      if (!childrenMap.has(n.parentNodeId)) childrenMap.set(n.parentNodeId, []);
      childrenMap.get(n.parentNodeId).push(n);
    } else {
      roots.push(n);
    }
  }
  const byTime = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
  for (const list of childrenMap.values()) list.sort(byTime);
  // 根节点（独立会话/独立链）按「链内最新代码活动」降序排：最新进度的会话/链在白板最上面。
  // 用 lastCodeActivity（编辑/命令/commit），纯聊天的 mtime 不参与排序。
  const recency = (n) => String(n.lastCodeActivity || n.lastActivity || n.createdAt || '');
  const chainRecency = (n) => {
    let m = recency(n);
    for (const c of childrenMap.get(n.id) || []) {
      const cr = chainRecency(c);
      if (cr > m) m = cr;
    }
    return m;
  };
  roots.sort((a, b) => chainRecency(b).localeCompare(chainRecency(a)));

  const positions = new Map();
  const depthOf = new Map();

  const layoutSubtree = (node, depth, yStart) => {
    positions.set(node.id, { x: 36 + depth * COL_GAP, y: yStart });
    depthOf.set(node.id, depth);
    const children = childrenMap.get(node.id) || [];
    if (!children.length) return yStart + ROW_GAP;
    let y = yStart;
    let firstChildY = null;
    for (const c of children) {
      y = layoutSubtree(c, depth + 1, y);
      if (firstChildY === null) firstChildY = positions.get(c.id).y;
    }
    // 父卡片与第一个子卡片对齐，保证单链水平
    positions.get(node.id).y = firstChildY;
    return y;
  };

  let y = 40;
  let maxDepth = 0;
  for (const root of roots) {
    y = layoutSubtree(root, 0, y) + MIN_GAP;
  }
  for (const d of depthOf.values()) maxDepth = Math.max(maxDepth, d);

  return {
    positions,
    width: 36 + maxDepth * COL_GAP + CARD_W + 36,
    height: y + 60,
  };
}

/** 渲染后同列冲突消除：按实测卡片高度依次下移，保证不重叠 */
function resolveCollisions(positions, cardsEl) {
  const cols = new Map();
  for (const [id, pos] of positions) {
    if (!cols.has(pos.x)) cols.set(pos.x, []);
    cols.get(pos.x).push(id);
  }
  for (const ids of cols.values()) {
    ids.sort((a, b) => positions.get(a).y - positions.get(b).y);
    let prevBottom = -Infinity;
    for (const id of ids) {
      const el = cardsEl.querySelector(`[data-node="${id}"]`);
      const h = el ? el.offsetHeight : 160;
      const p = positions.get(id);
      if (p.y < prevBottom + MIN_GAP) p.y = prevBottom + MIN_GAP;
      prevBottom = p.y + h;
    }
  }
}

function renderBoard() {
  const cardsEl = $('cards');
  const svg = $('edges');
  const nodes = currentTask?.nodes || [];

  $('empty').style.display = nodes.length ? 'none' : 'flex';
  $('task-actions').hidden = !currentTask;
  $('btn-status').innerHTML = currentTask?.status === 'done' ? (icon('play') + ' 恢复进行中') : (icon('check') + ' 标记完成');

  if (!currentTask || !nodes.length) {
    cardsEl.innerHTML = '';
    svg.innerHTML = '';
    $('board').style.width = '100%';
    $('board').style.height = '100%';
    renderTabs(); // 空任务也要刷新顶部标签/侧栏，清掉上一个任务的残留链
    return;
  }

  const { positions, width, height } = computeLayout(nodes);
  const visible = visiblePaneIds();
  $('board').style.width = `${width}px`;
  $('board').style.height = `${height}px`;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  cardsEl.innerHTML = nodes.map((n) => {
    const pos = positions.get(n.id);
    const meta = n.summary || {};
    const branch = n.parentNodeId ? '<span class="chip branch">复制</span>' : '';
    const running = nodeTermFor(n) ? '<span class="run-dot" title="终端运行中"></span>' : '';
    return `<div class="card ${visible.includes(n.id) && !boardMode ? 'selected' : ''} ${n.id === activeTabId && !boardMode ? 'focused' : ''} ${boardMode && boardSel.has(n.id) ? 'sel' : ''}" data-node="${n.id}"
      style="left:${pos.x}px;top:${pos.y}px">
      <div class="card-head">
        <span class="chip ${n.tool}">${toolLabel(n.tool)}</span>
        ${branch}
        ${running}
        <span class="time">${fmtTime(n.createdAt)}</span>
      </div>
      <div class="card-title">${escapeHtml(n.title || '(无提问)')}</div>
      <div class="card-meta">
        <span>${meta.messageCount || 0} 条消息</span>
        <span>·</span>
        <span>${fmtTokens(meta.tokens || 0)} tokens</span>
        ${n.trimmedCount ? `<span>·</span><span>省略 ${n.trimmedCount} 条</span>` : ''}
      </div>
      <div class="card-foot">${escapeHtml(n.sessionId || '')}</div>
    </div>`;
  }).join('');

  // 实测高度消除同列重叠，再应用最终位置
  resolveCollisions(positions, cardsEl);
  for (const [id, pos] of positions) {
    const el = cardsEl.querySelector(`[data-node="${id}"]`);
    if (el) el.style.top = `${pos.y}px`;
  }

  // 连线（用最终位置与实测高度）
  const paths = [];
  for (const n of nodes) {
    if (!n.parentNodeId || !positions.has(n.parentNodeId)) continue;
    const parentEl = cardsEl.querySelector(`[data-node="${n.parentNodeId}"]`);
    const childEl = cardsEl.querySelector(`[data-node="${n.id}"]`);
    if (!parentEl || !childEl) continue;
    const p = positions.get(n.parentNodeId);
    const c = positions.get(n.id);
    const ph = parentEl.offsetHeight;
    const ch = childEl.offsetHeight;
    const x1 = p.x + CARD_W;
    const y1 = p.y + ph / 2;
    const x2 = c.x;
    const y2 = c.y + ch / 2;
    const dx = Math.max(48, (x2 - x1) / 2);
    paths.push(`<path d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"
      fill="none" stroke="#b6b6c6" stroke-width="2" />
      <circle cx="${x1}" cy="${y1}" r="3" fill="#b6b6c6" />
      <circle cx="${x2}" cy="${y2}" r="3" fill="#fff" stroke="#b6b6c6" stroke-width="2" />`);
  }
  svg.innerHTML = paths.join('');

  // 交互统一在 setupBoardInteractions 里用事件委托（重绘后监听不会丢）
  // 顶部标签页与侧栏会话链同步刷新（renderTabs 内部会刷新 mini-chain）
  renderTabs();
}

/* ---------------- 白板交互：左键框选 / 右键拖动 / 右键卡片操作 ---------------- */
let boardMenuEl = null;

function applyBoardSelection() {
  const cardsEl = $('cards');
  if (!cardsEl) return;
  cardsEl.querySelectorAll('.card[data-node]').forEach((el) => {
    el.classList.toggle('sel', boardSel.has(el.dataset.node));
  });
}
function setBoardSelection(ids, additive = false) {
  if (!additive) boardSel.clear();
  for (const id of ids) boardSel.add(id);
  applyBoardSelection();
}
function clearBoardSelection() { boardSel.clear(); applyBoardSelection(); }

function closeBoardMenu() {
  if (boardMenuEl) { boardMenuEl.remove(); boardMenuEl = null; }
}

/** 会话的终端停止（面板上的「停止」与白板右键菜单共用） */
async function stopNodeTerm(node) {
  const term = boundRunningTerm(node);
  if (!term) { toast('该会话当前没有运行中的终端'); return; }
  if (!confirm(`停止 ${toolLabel(node.tool)} 的终端进程？（未保存的对话进度保留在会话文件里，可重新启动终端恢复）`)) return;
  try {
    await api('/api/terms/kill', { method: 'POST', body: { id: term.id } });
    toast('终端已停止');
    refreshTermIndicators();
  } catch (err) { toast(err.message); }
}

/** 白板卡片右键操作菜单：接力在最上面，其余是这个会话的全部操作 */
function openBoardMenu(nodeId, x, y) {
  closeBoardMenu();
  const node = findNode(nodeId);
  if (!node) return;
  const running = !!boundRunningTerm(node);
  const opened = openTabs.includes(node.id);
  const items = [
    { icon: 'handoff', label: '接力（生成检查点，换工具继续）', run: () => openHandoffModal(node) },
    { icon: 'timeline', label: '打开工作轨迹', run: () => openSessionTab(node.id) },
    { icon: 'split', label: '分屏打开', run: () => openInOtherSlot(node.id) },
    { icon: 'context', label: '会话上下文', run: () => openCtxModal(node) },
    running ? { icon: 'stop', label: '停止终端', danger: true, run: () => stopNodeTerm(node) } : null,
    opened ? { icon: 'x', label: '关闭标签', run: () => closeTab(node.id) } : null,
  ].filter(Boolean);
  const el = document.createElement('div');
  el.className = 'board-menu';
  el.innerHTML = `<div class="board-menu-head">已选 ${boardSel.size || 1} 个 · ${escapeHtml(truncate(node.title || '(会话)', 22))}</div>` +
    items.map((it, i) => `<button type="button" class="board-menu-item${it.danger ? ' danger' : ''}" data-mi="${i}"${i === 0 ? ' data-primary="1"' : ''}>${icon(it.icon, 14)}<span>${escapeHtml(it.label)}</span></button>`).join('');
  el.querySelectorAll('[data-mi]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeBoardMenu();
      try { items[Number(b.dataset.mi)].run(); } catch (err) { toast(err.message); }
    });
  });
  document.body.appendChild(el);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
  boardMenuEl = el;
}

/** 左键空白处拉框选卡片；右键任意位置拖动白板，右键单击卡片弹操作菜单 */
function setupBoardInteractions() {
  const wrap = $('board-wrap');
  if (!wrap) return;

  // 白板里不弹浏览器原生右键菜单（右键用于拖动/操作）
  wrap.addEventListener('contextmenu', (e) => e.preventDefault());

  const marquee = (down) => {
    down.preventDefault();
    const base = down.shiftKey ? [...boardSel] : [];
    if (!down.shiftKey) setBoardSelection([]);
    const rect0 = wrap.getBoundingClientRect();
    const sx = down.clientX - rect0.left + wrap.scrollLeft; // 起点（内容坐标）
    const sy = down.clientY - rect0.top + wrap.scrollTop;
    const ox = down.clientX;
    const oy = down.clientY;
    const box = document.createElement('div');
    box.className = 'board-marquee';
    wrap.appendChild(box);
    let moved = false;
    const onMove = (ev) => {
      if (Math.abs(ev.clientX - ox) > 3 || Math.abs(ev.clientY - oy) > 3) moved = true;
      const cx = ev.clientX - rect0.left + wrap.scrollLeft;
      const cy = ev.clientY - rect0.top + wrap.scrollTop;
      box.style.left = `${Math.min(sx, cx)}px`;
      box.style.top = `${Math.min(sy, cy)}px`;
      box.style.width = `${Math.abs(cx - sx)}px`;
      box.style.height = `${Math.abs(cy - sy)}px`;
      // 用视口坐标求与卡片的交集（只选可见范围内的卡片）
      const r = {
        left: Math.min(ox, ev.clientX), right: Math.max(ox, ev.clientX),
        top: Math.min(oy, ev.clientY), bottom: Math.max(oy, ev.clientY),
      };
      const hits = [];
      wrap.querySelectorAll('.card[data-node]').forEach((el) => {
        const c = el.getBoundingClientRect();
        if (c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top) hits.push(el.dataset.node);
      });
      setBoardSelection([...base, ...hits], true);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      box.remove();
      if (!moved && !down.shiftKey) clearBoardSelection(); // 空白处单击 = 取消选择
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const pan = (down, cardEl) => {
    down.preventDefault();
    const ox = down.clientX;
    const oy = down.clientY;
    const sl = wrap.scrollLeft;
    const st = wrap.scrollTop;
    let moved = false;
    wrap.classList.add('panning');
    const onMove = (ev) => {
      const dx = ev.clientX - ox;
      const dy = ev.clientY - oy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      wrap.scrollLeft = sl - dx;
      wrap.scrollTop = st - dy;
    };
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      wrap.classList.remove('panning');
      if (moved) return; // 拖动了就是平移，不弹菜单
      if (cardEl) {
        const id = cardEl.dataset.node;
        if (!boardSel.has(id)) setBoardSelection([id]);
        openBoardMenu(id, ev.clientX, ev.clientY);
      } else {
        closeBoardMenu();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  wrap.addEventListener('mousedown', (e) => {
    if (!boardMode) return;
    const cardEl = e.target.closest('.card[data-node]');
    if (e.button === 0) {
      if (cardEl) {
        // 左键点卡片 = 选中（Shift 加选/减选）；双击才打开会话
        const id = cardEl.dataset.node;
        if (e.shiftKey) {
          if (boardSel.has(id)) boardSel.delete(id); else boardSel.add(id);
          applyBoardSelection();
        } else {
          setBoardSelection([id]);
        }
        return;
      }
      marquee(e);
    } else if (e.button === 2) {
      pan(e, cardEl);
    }
  });

  wrap.addEventListener('dblclick', (e) => {
    const cardEl = e.target.closest('.card[data-node]');
    if (cardEl && boardMode) openSessionTab(cardEl.dataset.node);
  });

  document.addEventListener('mousedown', (e) => {
    if (boardMenuEl && !e.target.closest('.board-menu')) closeBoardMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBoardMenu(); });
}

