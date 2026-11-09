/* sbridge · 右侧面板（T3 Code 风格 surface）：
   工作区共用一个，内容跟随当前聚焦会话；只读，不挂终端，开合不影响工作轨迹/终端切换。 */

const SP_ITEMS = [
  { id: 'diff', icon: 'diff', label: '改动', key: 'D', hint: '当前会话目录的 git 改动与逐文件 diff' },
  { id: 'files', icon: 'folder', label: '文件', key: 'F', hint: '浏览会话目录，点文件看文本内容' },
  { id: 'context', icon: 'context', label: '上下文', key: 'C', hint: '这个任务已被捕获的认知与证据' },
  { id: 'worktree', icon: 'git', label: 'Worktree', key: 'W', hint: '独立工作区的分支状态与合并' },
];

const spState = { open: false, surface: null, dir: '', file: null };
let spLastKey = '';

function currentPanelNode() {
  if (typeof findNode !== 'function') return null;
  return findNode(activeTabId) || findNode(layout?.slots?.[0]) || (currentTask?.nodes || [])[0] || null;
}

function spApiBase(node) {
  return `/api/tasks/${currentTask.id}/nodes/${node.id}`;
}

function refreshSidePanel(force = false) {
  if (!spState.open) return;
  const key = `${activeTabId || ''}|${spState.surface || ''}|${spState.dir}|${spState.file || ''}`;
  if (!force && key === spLastKey) return;
  spLastKey = key;
  spRender();
}

function toggleSidePanel(force) {
  const panel = $('side-panel');
  if (!panel) return;
  const want = force === undefined ? !spState.open : !!force;
  spState.open = want;
  panel.hidden = !want;
  const btn = $('btn-panel');
  btn?.classList.toggle('active', want);
  btn?.setAttribute('aria-pressed', String(want));
  if (want) {
    spLastKey = '';
    spRender();
  }
  // 面板改变 pane 宽度：让当前终端的 xterm 重新量尺寸（refit 内部只在终端视图生效）
  setTimeout(() => {
    const id = activeTabId || layout?.slots?.[0];
    const handle = id && typeof paneHandles !== 'undefined' ? paneHandles.get(id) : null;
    try { handle?.refit(); } catch { /* ignore */ }
  }, 60);
}

function openSidePanel(id) {
  spState.surface = id || null;
  spState.dir = '';
  spState.file = null;
  spLastKey = '';
  toggleSidePanel(true);
  spRender();
}

function spBack() {
  spState.surface = null;
  spState.dir = '';
  spState.file = null;
  spLastKey = '';
  spRender();
}

async function spRender() {
  const body = $('sp-body');
  if (!body) return;
  // 记录本次渲染的签名：renderTabs 频繁触发 refreshSidePanel，签名一致就不再重绘（防闪烁）
  spLastKey = `${activeTabId || ''}|${spState.surface || ''}|${spState.dir}|${spState.file || ''}`;
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
    </div>`;
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
}
