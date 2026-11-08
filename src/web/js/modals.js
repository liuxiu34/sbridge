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
    bodyHtml: `<div class="field"><label>名称</label><input id="f-name" placeholder="例如：游戏原型 / API 代理" autocomplete="off" /></div>`,
    submitLabel: '创建',
    onSubmit: async () => {
      const name = $('f-name').value.trim();
      if (!name) throw new Error('请输入名称');
      await api('/api/projects', { method: 'POST', body: { name } });
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
      await api(`/api/tasks/${currentTask.id}/nodes`, {
        method: 'POST',
        body: { tool, file: selected.file },
      });
      await refreshTask();
      toast('已接入会话');
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
          ${list.map(({ it, i }) => `
          <div class="pick" data-idx="${i}">
            <span class="pick-radio"></span>
            <div class="pick-main">
              <div class="pick-title">${escapeHtml(it.title)}</div>
              <div class="pick-sub">${fmtTime(it.updatedAt)} · ${it.messageCount} 条 · ${escapeHtml((it.id || '').slice(0, 8))}</div>
            </div>
          </div>`).join('')}
        </div>`).join('');
      $('pick-list').innerHTML = data.items.length ? groupHtml : `<div class="empty-tree">没有可接入的会话（${toolName} 本机共 ${data.totalAll} 条）</div>`;
      $('pick-list').querySelectorAll('[data-idx]').forEach((el) => {
        el.addEventListener('click', () => {
          $('pick-list').querySelectorAll('.pick').forEach((x) => x.classList.remove('selected'));
          el.classList.add('selected');
          selected = data.items[Number(el.dataset.idx)];
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

