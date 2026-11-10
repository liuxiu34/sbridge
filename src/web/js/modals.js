/* sbridge · 弹窗与流程：通用弹窗、新建任务/项目、接入会话、上下文用量 */

/* ---------------- 弹窗 ---------------- */
function openModal({ title, bodyHtml, submitLabel = '确定', onSubmit }) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  // submitLabel 为空 = 只展示内容，不放提交按钮
  $('modal-foot').innerHTML = `<button class="btn-ghost" id="modal-cancel">取消</button>
    ${submitLabel ? `<button class="btn-primary" id="modal-submit">${submitLabel}</button>` : ''}`;
  $('modal').hidden = false;

  const close = () => { $('modal').hidden = true; $('modal-body').innerHTML = ''; };
  $('btn-close-modal').onclick = close;
  $('modal-cancel').onclick = close;
  const submitBtn = $('modal-submit');
  if (submitBtn) submitBtn.onclick = async () => {
    try {
      await onSubmit();
      close();
    } catch (err) {
      toast(err.message);
    }
  };
  $('modal').onclick = (e) => { if (e.target === $('modal')) close(); };
  return close;
}

function createProjectFlow() {
  openModal({
    title: '新建项目文件夹',
    bodyHtml: `
      <div class="field"><label>名称</label><input id="f-name" placeholder="留空则用目录名" autocomplete="off" /></div>
      <div class="field"><label>目录（可选）</label><input id="f-cwd" placeholder="例如：D:\\code\\my-app" autocomplete="off" /></div>
      <div class="hint" style="color:#9a9aa4;margin-top:6px">填了目录后，自动获取项目会复用这个文件夹，不会为同一目录再建一个；同一目录不允许建两个项目。</div>`,
    submitLabel: '创建',
    onSubmit: async () => {
      const name = $('f-name').value.trim();
      const cwd = $('f-cwd').value.trim();
      if (!name && !cwd) throw new Error('名称和目录至少填一个');
      await api('/api/projects', { method: 'POST', body: { name: name || undefined, cwd: cwd || undefined } });
      await loadState();
      toast('项目已创建');
    },
  });
  setTimeout(() => $('f-name')?.focus(), 30);
}

function createTaskFlow(projectId = null) {
  const options = state.projects
    .map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
    .join('');
  openModal({
    title: '新建任务',
    bodyHtml: `
      <div class="field"><label>任务标题</label><input id="f-title" placeholder="例如：修复 3D 卡片消失问题" autocomplete="off" /></div>
      <div class="field"><label>归属</label>
        <select id="f-project" style="width:100%;padding:9px 11px;border:1px solid var(--line-strong);border-radius:9px;font:inherit;font-size:13px">
          <option value="">独立任务（不放进项目文件夹）</option>
          ${options}
        </select>
      </div>`,
    submitLabel: '创建',
    onSubmit: async () => {
      const title = $('f-title').value.trim();
      if (!title) throw new Error('请输入任务标题');
      const task = await api('/api/tasks', {
        method: 'POST',
        body: { title, projectId: $('f-project').value || null },
      });
      await loadState();
      await openTask(task.id);
      toast('任务已创建，先接入一条已有会话');
    },
  });
  setTimeout(() => $('f-title')?.focus(), 30);
}

function launchFlow() {
  let tool = 'codex';
  const taskId = currentTask.id;
  const cwd = currentTask?.nodes?.find((n) => n.cwd)?.cwd || '';

  openModal({
    title: '新开会话',
    bodyHtml: `
      <div class="segmented" id="launch-switch">
        ${toolButtonsHtml('codex')}
      </div>
      <div class="field"><label>工作目录</label><input id="f-launch-cwd" value="${escapeHtml(cwd)}" placeholder="例如 D:\\projects\\demo" autocomplete="off" /></div>
      <div class="hint" id="launch-hint" style="color:#9a9aa4"></div>`,
    submitLabel: '启动',
    onSubmit: async () => {
      const dir = $('f-launch-cwd').value.trim();
      if (!dir) throw new Error('请填写工作目录');
      const r = await api(`/api/tasks/${taskId}/launch`, { method: 'POST', body: { tool, cwd: dir, embed: true } });
      await refreshTerms();
      const runCwd = r.cwd || dir;
      if (r.worktree?.path) {
        toast(`${toolLabel(tool)} 已在独立 worktree 启动：${r.worktree.path}（分支 ${r.worktree.branch}）`);
      } else {
        toast(`${toolLabel(tool)} 已在内嵌终端启动${r.worktree?.reason ? `（${r.worktree.reason}）` : ''}，首轮对话后自动接入…`);
      }
      pollNewSession(taskId, r.since, tool, runCwd);
    },
  });

  const hintEl = () => $('launch-hint');
  const updateHint = () => {
    if (hintEl()) hintEl().textContent = `会在 sbridge 内嵌终端里启动 ${toolLabel(tool)}（agent 挂在服务上，关页面不中断）；git 仓库且工作区干净时会自动建独立 worktree，多个 agent 并行互不覆盖；发出第一条消息后自动接入看板。`;
  };
  updateHint();
  $('launch-switch').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      tool = btn.dataset.tool;
      $('launch-switch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      updateHint();
    });
  });
  setTimeout(() => $('f-launch-cwd')?.focus(), 30);
}

async function pollNewSession(taskId, since, tool, cwd) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const data = await api(`/api/tasks/${taskId}/scan-new?tool=${tool}&since=${encodeURIComponent(since)}&cwd=${encodeURIComponent(cwd)}`);
      if (data.node) {
        if (currentTaskId === taskId) {
          openSessionTab(data.node.id); // 就地打开会话标签，自动接上实时流
        } else {
          await loadState();
        }
        toast(`已自动接入 ${toolLabel(tool)} 会话`);
        return;
      }
    } catch {
      // 网络抖动或任务被删，下一轮重试
    }
  }
  toast('3 分钟内未检测到新会话；开始对话后可用「接入已有会话」手动接入');
}

function attachFlow() {
  let tool = 'codex';
  let selected = null;
  let showAll = false;
  const cwd = currentTask?.nodes?.find((n) => n.cwd)?.cwd || '';

  const close = openModal({
    title: '接入已有会话',
    bodyHtml: `
      <div class="segmented" id="tool-switch">
        ${toolButtonsHtml('codex')}
      </div>
      <div class="hint" id="avail-hint" style="color:#9a9aa4;margin-bottom:10px">正在读取本机会话…</div>
      <div class="pick-list" id="pick-list"></div>`,
    submitLabel: '接入',
    onSubmit: async () => {
      if (!selected) throw new Error('请选择一条会话');
      const attach = (allowCreateProject) => api(`/api/tasks/${currentTask.id}/nodes`, {
        method: 'POST',
        body: { tool, file: selected.file, allowCreateProject },
      });
      let r = await attach(false);
      if (r.needsProject) {
        if (!confirm(`这个会话所在目录还没有项目文件夹：\n${r.cwd}\n\n要新建项目文件夹「${r.name}」并把它放进去吗？`)) {
          throw new Error('已取消，未创建项目文件夹');
        }
        r = await attach(true);
      }
      if (!r.ok) throw new Error('接入失败');

      const targetId = r.taskId || currentTask.id;
      await loadState();
      if (targetId !== currentTask?.id) await openTask(targetId);
      else await refreshTask();
      const nodeId = r.kind === 'attached' ? r.node?.id : r.nodeId;
      if (nodeId) openSessionTab(nodeId);

      if (r.kind === 'exists') toast(`该会话已在任务「${r.taskTitle}」里，已为你打开`);
      else if (r.kind === 'restored') toast(`已从归档恢复，回到任务「${r.taskTitle}」`);
      else if (r.createdProject) toast(`已创建项目文件夹「${r.createdProject.name}」，会话已放进去`);
      else toast(`已接入到任务「${r.taskTitle}」`);
    },
  });

  const loadList = async () => {
    $('pick-list').innerHTML = '<div class="empty-tree">读取中…</div>';
    try {
      const params = new URLSearchParams({ tool });
      if (cwd && !showAll) params.set('cwd', cwd);
      if (showAll) params.set('all', '1');
      const data = await api(`/api/available?${params}`);
      const toolName = toolLabel(tool);
      let hint;
      if (data.filtered) {
        hint = `${toolName} 本机共 ${data.totalAll} 条，按当前任务目录过滤后 ${data.totalFiltered} 条`;
      } else {
        hint = `${toolName} 本机共 ${data.totalAll} 条，全部显示`;
      }
      if (data.items.length < data.totalFiltered) hint += `（仅显示最近 ${data.items.length} 条）`;
      $('avail-hint').innerHTML = `${escapeHtml(hint)}${data.filtered ? ` · <a href="#" id="show-all-link" style="color:var(--accent)">显示全部</a>` : ''}`;
      $('show-all-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        showAll = true;
        loadList();
      });
      // 按目录分组：目录名取路径末段（即项目文件夹名）
      const dirLabel = (cwdPath) => {
        if (!cwdPath) return '(未知目录)';
        const norm = cwdPath.replace(/[\\/]+$/, '');
        return norm.split(/[\\/]/).pop() || norm;
      };
      const groups = new Map();
      data.items.forEach((it, i) => {
        const key = it.cwd || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ it, i });
      });
      const groupHtml = [...groups.entries()].map(([dir, list]) => `
        <div class="pick-group">
          <div class="pick-group-head" title="${escapeHtml(dir)}">
            <span class="pick-group-name">${escapeHtml(dirLabel(dir))}</span>
            <span class="pick-group-path">${escapeHtml(dir)}</span>
          </div>
          ${list.map(({ it, i }) => {
            // 已导入的默认不给接（减少重复卡片）；已归档的可以接，走的是「恢复」
            const imported = it.status === 'imported';
            const badge = imported
              ? `<span class="pick-badge">已导入</span>`
              : it.status === 'archived' ? `<span class="pick-badge archived">已归档</span>` : '';
            return `
          <div class="pick${imported ? ' is-disabled' : ''}" data-idx="${i}">
            <span class="pick-radio"></span>
            <div class="pick-main">
              <div class="pick-title">${escapeHtml(it.title)}</div>
              <div class="pick-sub">${fmtTime(it.updatedAt)} · ${it.messageCount} 条 · ${escapeHtml((it.id || '').slice(0, 8))}${it.taskTitle ? ` · 已在「${escapeHtml(it.taskTitle)}」` : ''}</div>
            </div>${badge}
          </div>`;
          }).join('')}
        </div>`).join('');
      $('pick-list').innerHTML = data.items.length ? groupHtml : `<div class="empty-tree">没有可接入的会话（${toolName} 本机共 ${data.totalAll} 条）</div>`;
      $('pick-list').querySelectorAll('[data-idx]').forEach((el) => {
        const it = data.items[Number(el.dataset.idx)];
        el.addEventListener('click', () => {
          if (it.status === 'imported') {
            toast(`该会话已在任务「${it.taskTitle || '看板'}」里，无需重复接入`);
            return;
          }
          $('pick-list').querySelectorAll('.pick').forEach((x) => x.classList.remove('selected'));
          el.classList.add('selected');
          selected = it;
        });
      });
    } catch (err) {
      $('pick-list').innerHTML = `<div class="empty-tree">读取失败：${escapeHtml(err.message)}</div>`;
    }
  };

  $('tool-switch').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      tool = btn.dataset.tool;
      selected = null;
      showAll = false;
      $('tool-switch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      loadList();
    });
  });
  loadList();
  return close;
}

/* ---------------- 面板工具弹窗：任务上下文 / 智能接力 ---------------- */

function openCtxModal(node) {
  openModal({
    title: `任务上下文 · ${toolLabel(node.tool)} 面板`,
    bodyHtml: '<div id="modal-usage"></div><div class="ctx-panel" id="modal-ctx"><div class="empty-tree">加载中…</div></div>',
    submitLabel: '',
  });
  renderCtxInto($('modal-ctx'), node);
  showNodeUsage(node);
}

/* 上下文用量：直接展示工具自己记录的数字与来源（pi 还会带上状态栏原文） */
async function showNodeUsage(node) {
  const el = $('modal-usage');
  if (!el) return;
  const labels = {
    'codex-token-count': 'Codex token_count',
    'claude-usage': 'Claude 会话 usage',
    'pi-status': 'Pi 状态栏',
    'pi-usage': 'Pi 会话 usage',
  };
  try {
    const r = await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/usage`);
    const c = r.ctx;
    if (!c) {
      el.innerHTML = '<div class="ctx-label">上下文用量</div><div class="empty-tree">这个工具没有留下可读的用量记录（工作轨迹里的环为估算值）。</div>';
      return;
    }
    const pct = c.pct ?? (c.used / c.window) * 100;
    el.innerHTML = `<div class="ctx-label">上下文用量</div>
      <div class="ctx-row">
        <span class="ctx-item">已用 ${Math.round(pct)}%（${fmtTokens(c.used)} / ${Math.round(c.window / 1000)}k 窗口）</span>
        ${c.model ? `<span class="ctx-item" title="模型">${escapeHtml(c.model)}</span>` : ''}
        <span class="ctx-item">来源：${escapeHtml(labels[c.source] || c.source || '未知')}</span>
      </div>
      ${c.raw ? `<div class="ctx-raw" title="工具状态栏原文">${escapeHtml(c.raw)}</div>` : ''}`;
  } catch { el.innerHTML = ''; }
}

function openHandoffModal(node) {
  const others = (state.tools?.length ? state.tools : DEFAULT_TOOLS).filter((t) => t.id !== node.tool);
  let sel = others[0]?.id || null;
  openModal({
    title: `智能接力：${toolLabel(node.tool)} → ?`,
    bodyHtml: `
      <div class="hint" style="color:#9a9aa4;margin-bottom:10px">生成检查点（含增量捕获与 LLM 加工，约 10-60 秒），写入目标工具原生新会话并在 sbridge 内直接打开。</div>
      <div class="pick-list">${others.map((t, i) => `
        <div class="pick ${i === 0 ? 'selected' : ''}" data-to="${t.id}">
          <span class="pick-radio"></span>
          <div class="pick-main"><div class="pick-title">${escapeHtml(t.label)}</div>
          <div class="pick-sub">检查点注入其原生会话，接力链 +1</div></div>
        </div>`).join('')}</div>`,
    submitLabel: '开始接力',
    onSubmit: async () => {
      if (!sel) throw new Error('请选择目标工具');
      await smartHandoff(node, sel);
    },
  });
  $('modal-body').querySelectorAll('[data-to]').forEach((el) => {
    el.addEventListener('click', () => {
      sel = el.dataset.to;
      $('modal-body').querySelectorAll('.pick').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
    });
  });
}

async function handoff(node, toTool, btn = null) {
  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在复制…';
  }
  try {
    const data = await api(`/api/tasks/${currentTask.id}/handoff`, {
      method: 'POST',
      body: { nodeId: node.id, toTool },
    });
    await refreshTask();
    await refreshTerms();
    openSessionTab(data.node.id);
    toast(`已生成 ${toolLabel(toTool)} 会话：${data.resumeCommand}`);
  } catch (err) {
    toast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

/* ---------------- 会话导出 / 全局搜索 / 环境诊断 ---------------- */

/** 导出会话为 Markdown（只读会话文件，不影响会话本身） */
async function exportNodeMarkdown(node) {
  if (!node || !currentTask) return;
  try {
    const res = await fetch(`/api/tasks/${currentTask.id}/nodes/${node.id}/export`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `导出失败 (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(node.title || '会话').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || '会话'}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('已导出 Markdown');
  } catch (err) { toast(err.message); }
}

/** 全局搜索：标题/摘要即时搜，勾选后再扫正文；点结果直接打开会话 */
function openSearchModal() {
  let debounce = 0;
  let reqSeq = 0;
  const close = openModal({
    title: '全局搜索',
    bodyHtml: `
      <div class="search-box">
        <input id="search-q" placeholder="搜索任务、会话标题与摘要…" autocomplete="off" />
        <label class="search-deep"><input type="checkbox" id="search-deep" /> 同时搜索会话正文（较慢，最多约 4 秒）</label>
      </div>
      <div class="hint" id="search-hint" style="color:#9a9aa4;margin-bottom:8px">输入关键词开始搜索</div>
      <div class="search-results" id="search-results"></div>`,
    submitLabel: '',
  });
  const $q = () => $('search-q');
  const $hint = () => $('search-hint');
  const $results = () => $('search-results');

  const renderResults = (results) => {
    if (!results.length) { $results().innerHTML = '<div class="empty-tree">没有匹配的会话</div>'; return; }
    $results().innerHTML = results.map((r, i) => (r.type === 'task'
      ? `<button type="button" class="search-row" data-sr="${i}">
          <span class="chip">任务</span>
          <span class="search-main">
            <span class="search-title">${escapeHtml(r.title)}</span>
            <span class="search-sub">${escapeHtml(r.projectName || '独立任务')} · ${r.nodeCount} 个会话</span>
          </span>
        </button>`
      : `<button type="button" class="search-row" data-sr="${i}">
          <span class="chip ${r.tool}">${escapeHtml(toolLabel(r.tool))}</span>
          <span class="search-main">
            <span class="search-title">${escapeHtml(r.title)}</span>
            <span class="search-sub">${escapeHtml(r.taskTitle || '')} · ${escapeHtml(r.where || '')} · ${fmtTime(r.updatedAt)}</span>
            <span class="search-snippet">${escapeHtml(r.snippet || '')}</span>
          </span>
        </button>`)).join('');
    $results().querySelectorAll('[data-sr]').forEach((btn) => {
      btn.onclick = async () => {
        const r = results[Number(btn.dataset.sr)];
        close();
        if (r.type === 'task') { openTask(r.taskId); return; }
        try {
          await openTask(r.taskId);
          openSessionTab(r.nodeId);
        } catch (err) { toast(err.message); }
      };
    });
  };

  const run = async () => {
    const q = $q().value.trim();
    const deep = $('search-deep').checked;
    const seq = ++reqSeq;
    if (!q) { $results().innerHTML = ''; $hint().textContent = '输入关键词开始搜索'; return; }
    $hint().textContent = deep ? '深度搜索中（最多约 4 秒）…' : '搜索中…';
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}&deep=${deep ? 1 : 0}&limit=50`);
      if (seq !== reqSeq) return;
      $hint().textContent = data.results.length
        ? `${data.results.length} 条结果${data.truncated ? '（结果较多，已截断）' : ''}`
        : '没有找到匹配';
      renderResults(data.results);
    } catch (err) {
      if (seq === reqSeq) $hint().textContent = `搜索失败: ${err.message}`;
    }
  };

  $q().addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(run, 400); });
  $q().addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounce); run(); } });
  setTimeout(() => $q().focus(), 30);
  return close;
}

/** 编程工具安装/更新：缺的装、旧的更新，Pi 扩展一键装；默认定时自动保持最新 */
function openToolchainModal() {
  const PI_PKGS = [
    { pkg: '@dreki-gg/pi-plan-mode', label: '计划模式', note: '给 Pi 提供 /plan' },
    { pkg: '@narumitw/pi-goal', label: '目标模式', note: '给 Pi 提供 /goal' },
    { pkg: 'pi-web-access', label: '网页搜索', note: '联网搜索与抓取' },
  ];
  const close = openModal({
    title: '编程工具安装与更新',
    submitLabel: '',
    bodyHtml: `
      <div class="hint" id="tc-hint" style="color:#9a9aa4;margin-bottom:10px">正在读取版本…</div>
      <div class="set-row" style="margin-bottom:12px">
        <span class="set-text"><span class="pick-title">自动保持最新</span>
        <span class="pick-sub">启动后检查一次，之后每 12 小时检查；发现新版本就自动更新</span></span>
        <span class="switch"><input type="checkbox" id="tc-auto" checked /><i></i></span>
      </div>
      <div id="tc-list"></div>
      <div class="ctx-label" style="margin-top:14px">Pi 扩展</div>
      <div id="tc-pi"></div>`,
  });
  const render = async () => {
    const hint = $('tc-hint');
    const list = $('tc-list');
    try {
      const data = await api('/api/tools/versions');
      $('tc-auto').checked = data.autoUpdate !== false;
      const rows = data.tools.map((t) => `
        <div class="env-row">
          <div class="env-head">
            <span class="chip ${t.tool}">${escapeHtml(t.label)}</span>
            <span class="env-badge ${t.installed ? 'ok' : 'bad'}">${t.installed ? `已安装 ${escapeHtml(t.version || '')}` : '未安装'}</span>
            ${t.latest ? `<span class="env-badge ${t.outdated ? 'bad' : 'ok'}">npm ${escapeHtml(t.latest)}${t.outdated ? ' · 有新版' : ''}</span>` : ''}
            <button type="button" class="btn-ghost" data-update="${t.tool}" ${t.outdated || !t.installed ? '' : 'disabled'}>
              ${t.installed ? (t.outdated ? '更新' : '已最新') : '安装'}
            </button>
          </div>
        </div>`).join('');
      list.innerHTML = rows;
      const pi = data.pi || {};
      $('tc-pi').innerHTML = PI_PKGS.map((p) => {
        const on = p.pkg.includes('plan-mode') ? pi.plan : p.pkg.includes('goal') ? pi.goal : pi.search;
        return `<div class="env-row">
          <div class="env-head">
            <span class="env-badge ${on ? 'ok' : 'bad'}">${on ? '已装' : '未装'}</span>
            <b style="font-size:12.5px">${escapeHtml(p.label)}</b>
            <span class="env-line" style="margin:0">${escapeHtml(p.note)}</span>
            <button type="button" class="btn-ghost" data-pi="${escapeHtml(p.pkg)}" ${on ? 'disabled' : ''}>${on ? '已安装' : '安装'}</button>
          </div>
        </div>`;
      }).join('');
      hint.textContent = '安装/更新会调用 npm 或 pi，可能需要几十秒；完成后自动重新检测。';
      list.querySelectorAll('[data-update]').forEach((btn) => {
        btn.onclick = async () => {
          const tool = btn.dataset.update;
          btn.disabled = true;
          const old = btn.textContent;
          btn.textContent = '安装中…';
          try {
            const r = await api('/api/tools/update', { method: 'POST', body: { tool } });
            toast(`${toolLabel(tool)} 已更新到 ${r.version || '最新版'}`);
            hint.textContent = String(r.output || '').slice(-200);
            await render();
          } catch (err) {
            toast(err.message);
            btn.disabled = false;
            btn.textContent = old;
          }
        };
      });
      $('tc-pi').querySelectorAll('[data-pi]').forEach((btn) => {
        btn.onclick = async () => {
          btn.disabled = true;
          const old = btn.textContent;
          btn.textContent = '安装中…';
          try {
            await api('/api/pi/install', { method: 'POST', body: { pkg: btn.dataset.pi } });
            toast('扩展已安装');
            await render();
          } catch (err) {
            toast(err.message);
            btn.disabled = false;
            btn.textContent = old;
          }
        };
      });
    } catch (err) {
      hint.textContent = `读取失败：${err.message}`;
    }
  };
  $('tc-auto').onchange = async (e) => {
    try {
      const r = await api('/api/tools/auto-update', { method: 'POST', body: { enabled: e.target.checked } });
      toast(r.autoUpdate ? '已开启自动更新' : '已关闭自动更新');
    } catch (err) { toast(err.message); }
  };
  render();
  return close;
}

/** 环境诊断：CLI 安装 / 会话目录 / 登录与密钥配置（只读检测） */
function openEnvCheckModal() {
  const close = openModal({
    title: '环境诊断',
    bodyHtml: `
      <div class="hint" style="display:flex;align-items:center;gap:8px;color:#9a9aa4;margin-bottom:10px">
        <span id="env-hint">正在检测…（每个工具执行一次 --version，最多约 15 秒）</span>
        <button type="button" class="btn-ghost" id="env-refresh">${icon('refresh')} 重新检测</button>
      </div>
      <div id="env-results"></div>`,
    submitLabel: '',
  });

  const render = async () => {
    $('env-hint').textContent = '正在检测…';
    $('env-results').innerHTML = '';
    try {
      const data = await api('/api/env-check');
      $('env-hint').textContent = `共检测 ${data.results.length} 个工具（只读，不改任何配置）`;
      $('env-results').innerHTML = data.results.map((r) => {
        const verOk = !!r.versionProbe?.ok;
        const verText = verOk
          ? (r.versionProbe.output || '命令可用')
          : (r.versionProbe?.timeout ? '检测超时' : (r.versionProbe?.error || '未检测到命令'));
        return `<div class="env-row">
          <div class="env-head">
            <span class="chip ${r.tool}">${escapeHtml(r.label)}</span>
            <span class="env-badge ${verOk ? 'ok' : 'bad'}">${verOk ? '已安装' : '未检测到'}</span>
            <span class="env-badge ${r.auth?.ok ? 'ok' : 'bad'}">${r.auth?.ok ? '凭证就绪' : '缺少登录/密钥'}</span>
          </div>
          <div class="env-line">版本：${escapeHtml(truncate(verText, 180))}</div>
          <div class="env-line">会话目录：${escapeHtml(r.sessionsRoot || '(未知)')}${r.sessionsRootExists ? '' : '（不存在）'}</div>
          <div class="env-line">凭证：${escapeHtml(r.auth?.detail || '')}</div>
        </div>`;
      }).join('');
    } catch (err) {
      $('env-hint').textContent = '检测失败';
      $('env-results').innerHTML = `<div class="empty-tree">${escapeHtml(err.message)}</div>`;
    }
  };
  $('env-refresh').onclick = render;
  render();
  return close;
}

/** 设置 → 归档：列出全部已归档会话，可恢复到原任务（归档只隐藏，不删会话文件） */
function openArchiveModal() {
  const close = openModal({
    title: '归档',
    bodyHtml: `
      <div class="hint" id="arc-hint" style="color:#9a9aa4;margin-bottom:8px">正在读取…</div>
      <div id="arc-list"><div class="empty-tree">加载中…</div></div>`,
    submitLabel: '',
  });

  const render = async () => {
    const list = $('arc-list');
    if (!list) return;
    let items = [];
    try {
      items = (await api('/api/archive')).items || [];
    } catch (err) {
      list.innerHTML = `<div class="empty-tree">读取失败：${escapeHtml(err.message)}</div>`;
      return;
    }
    if ($('arc-hint')) {
      $('arc-hint').textContent = items.length
        ? `共 ${items.length} 个归档会话，恢复后回到原任务`
        : '还没有归档的会话';
    }
    if (!items.length) {
      list.innerHTML = '<div class="empty-tree">暂无归档会话。在白板里右键会话选「归档」，就会收在这里。</div>';
      return;
    }
    list.innerHTML = items.map((it, i) => `
      <div class="set-row">
        <span class="set-text">
          <span class="pick-title"><span class="chip ${escapeHtml(it.tool)}">${escapeHtml(toolLabel(it.tool))}</span> ${escapeHtml(it.title)}</span>
          <span class="pick-sub">${escapeHtml(it.taskTitle || '')} · 归档于 ${escapeHtml(fmtTime(it.archivedAt))}</span>
        </span>
        <button type="button" class="btn-ghost" data-restore="${i}">恢复</button>
      </div>`).join('');
    list.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.onclick = async () => {
        const it = items[Number(btn.dataset.restore)];
        btn.disabled = true;
        try {
          await api(`/api/tasks/${it.taskId}/nodes/${it.nodeId}/restore`, { method: 'POST' });
          toast(`已恢复「${truncate(it.title, 24)}」`);
          await render();
          await loadState();
          if (currentTask) await refreshTask();
        } catch (err) {
          btn.disabled = false;
          toast(err.message);
        }
      };
    });
  };
  render();
  return close;
}
