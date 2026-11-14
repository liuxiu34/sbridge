/* sbridge · 会话面板：createSessionPane（工作轨迹 + 终端 + 输入 + 进度提示） */

/* 一个会话面板：默认终端（主视图）+ 工作轨迹（⌁ 切换查看）+ 输入 + 工具条 */
/* 子代理修复记录弹窗：展示 .sbridge-fix 的 prompt/日志，并一键打开/接入子代理会话 */
function openSubagentModal(parentNode, data) {
  const fix = data.fix || {};
  const sessions = data.sessions || [];
  const logTxt = (fix.logs || []).map((l) => `${l.name}（${Math.round(l.size / 1024)}KB）`).join(' · ');
  const bodyHtml = `
    <div class="sub-fix-meta">
      ${fix.worker ? `worker：${escapeHtml(toolLabel(fix.worker))} · ` : ''}
      ${fix.startedAt ? `开始：${escapeHtml(fmtTime(fix.startedAt))} · ` : ''}
      日志：${escapeHtml(logTxt || '无')}
    </div>
    ${fix.prompt ? `<pre class="sub-prompt">${escapeHtml(fix.prompt)}</pre>` : '<div class="sub-fix-meta">未读取到 prompt.md</div>'}
    <div class="sub-fix-meta" style="margin-top:12px">修复窗口内的子代理会话（点击打开；未接入的会自动挂到当前会话下面）：</div>
    ${sessions.length ? sessions.map((s, i) => `
      <button type="button" class="sub-session" data-i="${i}">
        <span class="chip ${s.tool}">${escapeHtml(toolLabel(s.tool))}</span>
        <span class="t">${escapeHtml(truncate(s.title || '(子代理会话)', 70))}</span>
        <span class="sub-time">${escapeHtml(fmtTime(s.updatedAt))}</span>
        ${s.imported ? '<span class="sub-tag">已在看板</span>' : '<span class="sub-tag">接入</span>'}
      </button>`).join('') : '<div class="sub-fix-meta">没有识别到本次修复窗口内的新会话（可能还没开始，或 worker 会话未落盘）</div>'}`;
  const close = openModal({ title: '子代理修复记录', bodyHtml, submitLabel: '' });
  $('modal-body').querySelectorAll('.sub-session').forEach((btn) => {
    btn.onclick = async () => {
      const s = sessions[Number(btn.dataset.i)];
      if (!s) return;
      close();
      if (s.nodeId) { openSessionTab(s.nodeId); return; }
      try {
        const n = await api(`/api/tasks/${currentTask.id}/nodes`, {
          method: 'POST',
          body: { tool: s.tool, file: s.file, parentNodeId: parentNode.id },
        });
        currentTask.nodes.push(n);
        renderMiniChain();
        renderBoard();
        openSessionTab(n.id);
        toast('子代理会话已接入当前接力链');
      } catch (err) { toast(err.message); }
    };
  });
}

function createSessionPane(host, node, { active = true, caption } = {}) {
  const lastTs = { v: null };
  host.innerHTML = `
    <div class="session-pane ${active ? 'active' : 'idle'}">
      <div class="pane-head">
        <span class="chip ${node.tool}">${toolLabel(node.tool)}</span>
        <span class="pane-caption" title="${escapeHtml(node.title || '')}">${escapeHtml(caption || node.title || '(会话)')}</span>
        <span class="pane-status" data-role="status"></span>
        <span class="pane-tools">
          <button type="button" class="pbtn" data-pact="stream" aria-pressed="false" title="查看 AI 工作轨迹（步骤、查询、结果与来源）">${icon('timeline')} 工作轨迹</button>
          <button type="button" class="pbtn" data-pact="selfcheck" title="让这个会话自检：确认是否掌握项目最新、完整进度（只检查、不改文件）">${icon('radar')} 自检</button>
          <button type="button" class="pbtn ctx-btn" data-pact="ctx" title="会话上下文用量"><svg class="ctx-ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="ctx-ring-track" cx="10" cy="10" r="8"/><circle class="ctx-ring-val" cx="10" cy="10" r="8"/></svg><span class="ctx-ring-text" data-role="ctxtext">–</span></button>
          <button type="button" class="pbtn" data-pact="handoff" title="智能接力到其他工具">${icon('handoff')} 接力</button>
          <button type="button" class="pbtn" data-pact="worktree" title="在右侧面板查看独立 worktree 的改动并合并到主分支">${icon('git')} Worktree</button>
          <button type="button" class="pbtn" data-pact="export" title="导出该会话为 Markdown（只读）">${icon('download')}</button>
          <button type="button" class="pbtn danger" data-pact="cancelheadless" title="取消正在执行的无头任务" hidden>${icon('stop')} 取消执行</button>
          <button type="button" class="pbtn danger" data-pact="stopterm" title="停止该会话的终端进程（相当于在终端里输入退出命令）" hidden>${icon('stop')} 停止</button>
          <button type="button" class="pbtn danger" data-pact="close" title="关闭标签" aria-label="关闭标签">${icon('x', 13)}</button>
        </span>
      </div>
      <div class="fork-alert" data-role="forkalert" hidden></div>
      <div class="subagent-bar" data-role="subagentbar" hidden></div>
      <div class="term-view" data-role="termview">
        <button type="button" class="tui-overlay-close" data-role="tuioverlayclose" hidden title="收起终端面板，返回工作轨迹">收起 ✕</button>
        <div class="term-mount" data-role="termmount"></div>
        <div class="term-loading" data-role="termloading" hidden>终端正在启动…</div>
        <button type="button" class="term-start" data-role="termstart" hidden>${icon('play')} 启动此会话的终端</button>
        <button type="button" class="term-history" data-role="termhistory" hidden title="这个终端是刚恢复的新进程，之前的内容在工作轨迹里">${icon('history')} 本会话历史在工作轨迹里 →</button>
        <button type="button" class="term-bottom" data-role="termbottom" title="滚到最新输出" hidden>${icon('down')} 最新</button>
      </div>
      <div class="sev-scroll" data-role="streamscroll" hidden><div class="sev-list" data-role="list"></div></div>
      <button type="button" class="stream-bottom" data-role="streambottom" title="滚到最新工作轨迹" hidden>${icon('down')} 回到最新</button>
      <div class="dock-row" data-role="dockrow" hidden>
        <div class="queue-bar" data-role="queuebar" hidden></div>
        <div class="dock-actions" data-role="dockactions" hidden>
          <button type="button" data-role="steersend" title="不中断当前任务，把输入框内容作为引导注入（模型在本轮工具结束后就能看到，仅 Pi/OMP）" hidden>⚡ 引导</button>
          <button type="button" data-role="interruptsend" title="中断当前执行，立刻发送输入框里的消息">中断并发送</button>
          <button type="button" data-role="cancelrun" title="停止当前无头执行（待发队列保留，之后自动继续）">取消执行</button>
        </div>
      </div>
      <div class="sess-input" data-role="composer">
        <div class="composer composer-v2">
          <div class="comp-chips" data-role="chips" hidden></div>
          <textarea rows="1" data-role="input" placeholder="问点什么，或输入 / 命令、@ 文件…（Enter 发送，Shift+Enter 换行）"></textarea>
          <div class="composer-bar">
            <button type="button" class="tbtn" data-role="attach" title="引用本地文件">＋</button>
            <button type="button" class="tbtn" data-role="at" title="@ 文件：搜索并引用工作目录里的文件">@</button>
            <button type="button" class="tbtn" data-role="slash" title="命令菜单">/</button>
            <span class="perm-pill l-normal" data-role="perm" title="无头执行权限档位（点击切换）"><span class="pd"></span><span data-role="permname">常规</span></span>
            <span class="composer-grow"></span>
            <span class="composer-note" data-role="checkout"></span>
            <button type="button" class="model-btn" data-role="model" title="切换这个会话使用的模型">
              <span class="model-name" data-role="modelname">模型</span>${icon('chevronDown', 12)}
            </button>
            <button type="button" class="btn-send" data-role="send" title="发送（Enter）">${icon('arrowUp', 15)}</button>
          </div>
        </div>
      </div>
    </div>`;

  host.addEventListener('click', () => setFocusedPane(node.id), true);
  const listEl = host.querySelector('[data-role="list"]');
  const scrollEl = host.querySelector('[data-role="streamscroll"]');
  const statusEl = host.querySelector('[data-role="status"]');
  const termViewEl = host.querySelector('[data-role="termview"]');
  const termMountEl = host.querySelector('[data-role="termmount"]');
  const termStartBtn = host.querySelector('[data-role="termstart"]');
  const termBottomBtn = host.querySelector('[data-role="termbottom"]');
  const termHistoryBtn = host.querySelector('[data-role="termhistory"]');
  const streamBottomBtn = host.querySelector('[data-role="streambottom"]');
  const cancelHeadlessBtn = host.querySelector('[data-pact="cancelheadless"]');
  // 输入卡片底部：当前分支 · 目录尾名（对应 T3 的 Current checkout 行）
  const checkoutEl = host.querySelector('[data-role="checkout"]');
  if (checkoutEl) {
    const dirName = String(node.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
    const branch = currentTask?.project?.branch || '';
    checkoutEl.textContent = [branch, dirName].filter(Boolean).join(' · ');
  }

  /* ---------- 模型切换（和终端 /model 等价，默认两边同步） ---------- */
  const modelBtn = host.querySelector('[data-role="model"]');
  const modelNameEl = host.querySelector('[data-role="modelname"]');
  const composerEl = host.querySelector('.composer');
  let modelPop = null;
  let modelData = { current: '', options: [] };
  let modelRefreshedAt = 0;
  const modelSync = () => userSettings.syncModel !== false;
  const shortModel = (s) => String(s || '').replace(/\[[^\]]+\]$/, '');
  const setModelLabel = (m) => {
    if (!modelNameEl) return;
    modelNameEl.textContent = shortModel(m) || '模型';
    modelBtn.title = m ? `当前模型：${m}（点击切换）` : '切换这个会话使用的模型';
  };
  const loadModel = async () => {
    if (!modelBtn) return;
    try {
      const d = await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/model?sync=${modelSync() ? 1 : 0}`);
      modelData = d;
      setModelLabel(d.current);
    } catch { /* 读不到就保持原样 */ }
  };
  let mpOutside = null; // 弹层「点外部关闭」监听（弹层存活期间常驻，关闭时移除）
  const closeModelPop = () => {
    if (modelPop) { modelPop.remove(); modelPop = null; }
    if (mpOutside) { document.removeEventListener('click', mpOutside); mpOutside = null; }
  };
  const applyModel = async (opt) => {
    if (!opt) return;
    closeModelPop();
    try {
      const r = await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/model`, {
        method: 'POST',
        body: { model: opt.id, provider: opt.provider || null, sync: modelSync() },
      });
      modelData.current = opt.id;
      setModelLabel(opt.id);
      toast(r.applied === 'term'
        ? `已切换模型：${shortModel(opt.id)}（终端已同步）`
        : `已切换模型：${shortModel(opt.id)}（下次终端/发送生效）`);
    } catch (err) { toast(err.message); }
  };
  const effortLabel = (id) => (modelData.effort?.levels || []).find((l) => l.id === id)?.label || id;
  const applyEffort = async (level, { keepOpen = false } = {}) => {
    try {
      const r = await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/effort`, {
        method: 'POST',
        body: { level, sync: modelSync() },
      });
      modelData.effortCurrent = r.effort || '';
      if (!keepOpen) closeModelPop();
      const label = r.effort ? effortLabel(r.effort) : '默认';
      if (r.applied === 'term') toast(`思考强度：${label}（终端已同步）`);
      else if (r.applied === 'restart') toast(`思考强度：${label}（重开这个会话的终端后生效）`);
      else toast(`思考强度：${label}（下次启动生效）`);
    } catch (err) { toast(err.message); }
  };
  const openModelPop = async () => {
    if (!modelBtn || !composerEl) return;
    if (modelPop) { closeModelPop(); return; }
    await loadModel();
    const all = modelData.options || [];
    const cur = modelData.current || '';
    const curOpt = all.find((o) => o.id === cur) || null;
    const providers = [...new Set(all.map((o) => o.provider).filter(Boolean))];
    let provFilter = curOpt?.provider || '';
    // 思考强度：档位逐模型算（Codex/Pi 每个模型不一样），用滑块调，松手才写
    const eff = modelData.effort || { supported: false, levels: [] };
    const levels = eff.levels || [];
    const effCur = modelData.effortCurrent || '';
    const curIdx = levels.findIndex((l) => l.id === effCur);
    const defIdx = levels.findIndex((l) => l.id === eff.defaultLevel);
    const effIdx = curIdx >= 0 ? curIdx : (defIdx >= 0 ? defIdx : Math.max(0, Math.floor((levels.length - 1) / 2)));
    const effText = !levels.length ? ''
      : curIdx >= 0 ? levels[curIdx].label
        : defIdx >= 0 ? `${levels[defIdx].label}（默认）` : '默认';
    modelPop = document.createElement('div');
    modelPop.className = 'model-pop';
    modelPop.innerHTML = `
      <div class="mp-head">
        <span class="mp-cube">${icon('cube', 15)}</span>
        <div class="mp-prov-wrap">
          <button type="button" class="mp-prov" data-role="provbtn" title="按供应商/密钥筛选">
            <span data-role="provname">${escapeHtml(provFilter || (providers.length ? '全部模型' : '全部'))}</span>${icon('chevronDown', 12)}
          </button>
          <div class="mp-prov-menu" data-role="provmenu" hidden>
            ${providers.length ? '<button type="button" class="mp-prov-item" data-pv="">全部模型</button>' : ''}
            ${providers.map((p) => `<button type="button" class="mp-prov-item" data-pv="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('')}
          </div>
        </div>
        <span class="mp-badge" data-role="badge">${all.length}</span>
      </div>
      <div class="mp-sub">
        <span>模型</span>
        <input class="model-search" data-role="modelsearch" placeholder="搜索…" autocomplete="off" />
      </div>
      <div class="model-list" data-role="modellist"></div>
      <div class="mp-effort">
        <div class="mp-effort-head">
          <span>思考强度</span>
          <span class="mp-effort-val" data-role="effval">${escapeHtml(levels.length ? effText : '当前模型不支持')}</span>
          <span class="mp-kbd">Ctrl+T</span>
        </div>
        ${levels.length ? `
        <div class="effort-slider" data-role="effslider">
          <div class="effort-fill" data-role="efffill"></div>
          <div class="effort-knob" data-role="effknob"></div>
          <input type="range" class="effort-range" data-role="effrange" aria-label="思考强度"
            min="0" max="${Math.max(0, levels.length - 1)}" step="1" value="${effIdx}" />
        </div>` : ''}
      </div>
      <div class="model-foot">${modelSync() ? '与终端同步：开' : '与终端同步：关（在设置里改）'}</div>`;
    composerEl.appendChild(modelPop);
    const listEl = modelPop.querySelector('[data-role="modellist"]');
    const input = modelPop.querySelector('[data-role="modelsearch"]');
    const badge = modelPop.querySelector('[data-role="badge"]');
    const paint = (q) => {
      const kw = String(q || '').trim().toLowerCase();
      const list = all.filter((o) => (!provFilter || o.provider === provFilter) && (!kw
        || String(o.id).toLowerCase().includes(kw)
        || String(o.label || '').toLowerCase().includes(kw)));
      if (badge) badge.textContent = String(list.length);
      listEl.innerHTML = list.length ? list.slice(0, 300).map((o, i) => `
        <button type="button" class="model-item ${o.id === cur ? 'active' : ''}" data-mi="${i}" title="${escapeHtml(o.label || o.id)}">
          <span class="model-item-label">${escapeHtml(o.id)}</span>
          ${o.vision ? '<span class="model-tag">视觉</span>' : ''}
          ${o.id === cur ? `<span class="model-check">${icon('check', 13)}</span>` : ''}
        </button>`).join('') : '<div class="model-empty">没有匹配的模型</div>';
      listEl.querySelectorAll('[data-mi]').forEach((b) => {
        b.onclick = () => applyModel(list[Number(b.dataset.mi)]);
      });
    };
    paint('');
    // 供应商（密钥）筛选：自绘下拉（原生 select 在 Electron 主题下弹层显示不出来）
    const provBtn = modelPop.querySelector('[data-role="provbtn"]');
    const provMenu = modelPop.querySelector('[data-role="provmenu"]');
    const provName = modelPop.querySelector('[data-role="provname"]');
    const provLabelText = () => provFilter || (providers.length ? '全部模型' : '全部');
    provBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!provMenu) return;
      provMenu.hidden = !provMenu.hidden;
      if (!provMenu.hidden) {
        provMenu.querySelectorAll('[data-pv]').forEach((b) => b.classList.toggle('active', (b.dataset.pv || '') === provFilter));
        const act = provMenu.querySelector('.active');
        if (act) act.scrollIntoView({ block: 'nearest' });
      }
    });
    provMenu?.addEventListener('click', (e) => {
      const item = e.target.closest('[data-pv]');
      if (!item) return;
      provFilter = item.dataset.pv || '';
      if (provName) provName.textContent = provLabelText();
      provMenu.hidden = true;
      paint(input.value);
    });
    input.addEventListener('input', () => paint(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeModelPop(); }
    });
    const range = modelPop.querySelector('[data-role="effrange"]');
    const valEl = modelPop.querySelector('[data-role="effval"]');
    const knob = modelPop.querySelector('[data-role="effknob"]');
    const fill = modelPop.querySelector('[data-role="efffill"]');
    const slider = modelPop.querySelector('[data-role="effslider"]');
    if (range) {
      // 自己画滑块：灰轨道 + 绿色已选段 + 白色圆点（照 T3 的样式）
      const syncKnob = () => {
        if (!knob || !slider) return;
        const max = Number(range.max) || 1;
        const pct = Math.max(0, Math.min(100, (Number(range.value) / max) * 100));
        const w = slider.clientWidth || 0;
        const x = (pct / 100) * Math.max(0, w - 20) + 10;
        knob.style.left = `${x}px`;
        if (fill) fill.style.width = `${x}px`;
      };
      syncKnob();
      range.addEventListener('input', () => {
        const l = levels[Number(range.value)];
        if (l && valEl) valEl.textContent = l.label;
        syncKnob();
      });
      range.addEventListener('change', () => {
        const l = levels[Number(range.value)];
        if (l) applyEffort(l.id, { keepOpen: true });
      });
      range.addEventListener('click', (e) => e.stopPropagation());
    }
    input.focus();
    // 点面板外收起（弹层存活期间常驻监听；closeModelPop 负责移除）
    setTimeout(() => {
      mpOutside = (e) => {
        if (modelPop && !modelPop.contains(e.target) && !modelBtn.contains(e.target)) closeModelPop();
      };
      document.addEventListener('click', mpOutside);
    }, 0);
  };
  modelBtn?.addEventListener('click', (e) => { e.stopPropagation(); openModelPop(); });
  loadModel();
  // 进度分叉提示，两个按钮时机不同：
  //   跳转到最新会话 = 仅链内有更新的后代时出现（同链新会话取代了本会话）
  //   合并全部进度并继续 = 只要本会话不是全任务最新就出现（它没掌握全部最新进度，跨链动态也算）
  // 本会话已是全任务最新 → 都不出
  const forkAlertEl = host.querySelector('[data-role="forkalert"]');
  const renderForkAlert = () => {
    try {
      if (!forkAlertEl) return;
      if (!currentTask) { forkAlertEl.hidden = true; return; }
      // 跨会话比「谁更新」仍只看实质代码活动（闲聊不参与）；
      // 链上后代取三个时间戳里最新的那个：fork/接力生成的新会话会把父会话的历史一起带过来，
      // 解析出的 lastCodeActivity 可能与父会话完全相同（甚至更早），只看它会把新会话误判成「没更新」。
      const nodes = currentTask.nodes || [];
      const nodeKey = (n) => [n.lastCodeActivity, n.lastActivity, n.createdAt]
        .map((v) => String(v || ''))
        .sort((a, b) => b.localeCompare(a))[0] || '';
      const myCode = node.lastCodeActivity || '';
      const myKey = nodeKey(node);
      // 链内：只看「本会话的后代」（接力链上有继承关系的新会话才谈得上「跳过去」）
      const children = new Map();
      for (const n of nodes) {
        // 侧边对话是并行的独立会话：不算接力链后代，否则会误报「本会话未掌握最新进度」
        if (n.parentNodeId && n.id !== node.id && n.edgeKind !== 'side') {
          if (!children.has(n.parentNodeId)) children.set(n.parentNodeId, []);
          children.get(n.parentNodeId).push(n);
        }
      }
      const chainNewer = [];
      const stack = [node.id];
      while (stack.length) {
        const cur = stack.pop();
        for (const c of children.get(cur) || []) {
          if (nodeKey(c) > myKey) chainNewer.push(c);
          stack.push(c.id);
        }
      }
      chainNewer.sort((a, b) => nodeKey(b).localeCompare(nodeKey(a)));
      const hasAnyCode = nodes.some((n) => n.lastCodeActivity);
      if (!myCode && !hasAnyCode && !chainNewer.length) { forkAlertEl.hidden = true; return; }
      // 全任务：有更晚代码活动的会话（跨链提醒）
      const anyNewer = nodes
        .filter((n) => n.id !== node.id && n.lastCodeActivity && String(n.lastCodeActivity) > myCode)
        .sort((a, b) => String(b.lastCodeActivity).localeCompare(String(a.lastCodeActivity)));
      // 磁盘/ git 上的改动是否比本会话新（可能来自我们不解析的工具）
      const externalNewer = typeof projectExternalNewer === 'function' && projectExternalNewer(myCode);
      if (!anyNewer.length && !externalNewer && !chainNewer.length) { forkAlertEl.hidden = true; return; }
      const top = anyNewer[0] || null;
      // 跳转目标：接力链上更新的后代优先；没有同链后代时退到「全任务最新会话」。
      // 跨链会话只跳过去查看（不继承上下文），按钮 title 里写清楚。
      const jumpTarget = chainNewer[0] || top;
      forkAlertEl.hidden = false;
      const chainNote = chainNewer.length
        ? `接力链上有更新的会话 ${toolLabel(chainNewer[0].tool)}「${escapeHtml(truncate(chainNewer[0].title || '(会话)', 28))}」· ${fmtTime(nodeKey(chainNewer[0]) || chainNewer[0].createdAt)}${chainNewer.length > 1 ? `（链上另有 ${chainNewer.length - 1} 个更新会话）` : ''}`
        : anyNewer.length
          ? `其他会话有更新的代码改动（可能来自不同功能方向）：${toolLabel(top.tool)}「${escapeHtml(truncate(top.title || '(会话)', 28))}」· ${fmtTime(top.lastCodeActivity)}${anyNewer.length > 1 ? `（另有 ${anyNewer.length - 1} 个更新会话）` : ''}`
          : `项目里有比本会话更新的磁盘改动（可能来自其他工具）：${fmtTime(currentTask?.project?.lastChangeAt)}${currentTask?.project?.dirtyCount ? ` · ${currentTask.project.dirtyCount} 个未提交文件` : ''}。这里只看工作区事实，不受工具限制`;
      forkAlertEl.innerHTML = `<span class="fork-warn">${icon('history', 13)} 本会话可能未掌握项目最新进度：${chainNote}</span>
        ${jumpTarget ? `<button type="button" class="btn-primary small" data-role="jumplatest" title="${chainNewer.length ? '跳到接力链上更新的会话（完整继承历史）' : '跳到全任务最新的会话（跨链只跳转查看，不继承上下文）'}">${icon('handoff', 12)} 跳转到最新会话</button>` : ''}
        <button type="button" class="pbtn" data-role="forkclose" title="关闭提示">×</button>`;
      forkAlertEl.querySelector('[data-role="jumplatest"]')?.addEventListener('click', () => {
        forkAlertEl.hidden = true;
        openSessionTab(jumpTarget.id); // 跳链上最新的；若它之后还有更新，它自己的提醒条会继续指路
      });
      forkAlertEl.querySelector('[data-role="forkclose"]').onclick = () => { forkAlertEl.hidden = true; };
    } catch { /* ignore */ }
  };
  renderForkAlert();
  /* 子代理修复记录条（Paseo 式可视化）：只在项目下存在 .sbridge-fix 时出现 */
  const subagentBarEl = host.querySelector('[data-role="subagentbar"]');
  const renderSubagents = async () => {
    if (!subagentBarEl) return;
    try {
      const r = await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/subagents`);
      if (!r.fix?.exists) { subagentBarEl.hidden = true; return; }
      const n = r.sessions?.length || 0;
      const worker = r.fix.worker ? ` · worker: ${toolLabel(r.fix.worker)}` : '';
      subagentBarEl.hidden = false;
      subagentBarEl.innerHTML = `
        <button type="button" class="btn-ghost small" data-role="subagentopen">${icon('handoff', 13)} 子代理修复记录${n ? ` · ${n} 个会话` : ''}${escapeHtml(worker)}</button>
        <span class="sub-note">${r.fix.startedAt ? `开始于 ${escapeHtml(fmtTime(r.fix.startedAt))}` : '项目下有 .sbridge-fix 记录'}</span>`;
      subagentBarEl.querySelector('[data-role="subagentopen"]').onclick = () => openSubagentModal(node, r);
    } catch { subagentBarEl.hidden = true; }
  };
  renderSubagents();
  let firstBatch = true;
  let gone = false;
  let rawTerm = null; // { dispose, refit }
  let showingStream = true; // 默认显示工作轨迹（终端退居「TUI 交互层」，检测到确认框自动切过去）
  let streamRevealed = false;
  let streamUiFrame = 0;
  let cotTimer = 0;

  const nearBottom = () => scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
  const toBottom = () => { scrollEl.scrollTop = scrollEl.scrollHeight; scheduleStreamUi(); };
  const syncStreamUi = () => {
    streamUiFrame = 0;
    const scrollable = scrollEl.scrollHeight > scrollEl.clientHeight + 48;
    streamBottomBtn.hidden = !showingStream || !scrollable || nearBottom();
  };
  const scheduleStreamUi = () => {
    if (streamUiFrame) return;
    streamUiFrame = requestAnimationFrame(syncStreamUi);
  };
  const touch = (ts) => { if (ts) lastTs.v = ts; };
  const isTerminalRunning = () => !!boundRunningTerm(node);
  /* 无头执行状态：工作轨迹主路径下，CLI 在后台跑、终端不挂载，界面靠这个状态
     给出「正在执行」反馈；执行结束（成功/失败）再刷新一次。 */
  let headlessRunning = false;
  let headlessStartedAt = 0;
  let headlessPollTimer = 0;
  const isHeadlessRunning = () => headlessRunning;
  const headlessElapsed = () => (headlessStartedAt ? Date.now() - headlessStartedAt : 0);
  /* 无头执行进度轮询：发完消息后每 2 秒查一次 headless-status。
     成功 → 结束「正在执行」状态；失败 → 立刻把 stderr 尾部用 toast 提示
     （模型失效/账号问题/代理问题都会在这里暴露，而不是静默等 30 秒）。 */
  const startHeadlessStatusPoll = () => {
    clearTimeout(headlessPollTimer);
    const tick = async () => {
      if (!headlessRunning) return;
      let r = null;
      try { r = await api(`/api/tasks/${currentTask.id}/headless-status?nodeId=${node.id}`); } catch { headlessPollTimer = setTimeout(tick, 2000); return; }
      renderQueue(r?.queue || []);
      const st = r?.status;
      if (st && !st.running) {
        // 刚结束：把结局注入工作轨迹（折叠回合并显示 ✓/✗/已取消 行）
        cot.setHeadlessOutcome({ exitCode: st.exitCode, canceled: !!st.canceled, timedOut: !!st.timedOut, stderrTail: st.stderrTail || '' });
        if (st.canceled) toast('已取消执行');
        else if (st.timedOut) toast('执行超时（10 分钟），已终止');
        else if (st.exitCode !== 0 && st.stderrTail) {
          toast('执行失败: ' + String(st.stderrTail).slice(-140));
        }
        if (!(r?.queue || []).length) {
          headlessRunning = false;
          updateDockRow();
          cot.setConnected(true);
          cot.refresh();
          try { renderSubagents(); } catch { /* ignore */ }
          return;
        }
        // 队列还有消息：服务端稍候自动开始下一条，继续轮询
        headlessPollTimer = setTimeout(tick, 2000);
        return;
      }
      headlessPollTimer = setTimeout(tick, 2000);
    };
    tick();
  };

  /* ---------- 底部 dock：待发队列条 + 执行操作按钮 ---------- */
  const dockRowEl = host.querySelector('[data-role="dockrow"]');
  const queueBarEl = host.querySelector('[data-role="queuebar"]');
  const dockActionsEl = host.querySelector('[data-role="dockactions"]');
  let lastQueue = [];
  const steersendBtn = host.querySelector('[data-role="steersend"]');
  const updateDockRow = () => {
    if (!dockRowEl) return;
    dockRowEl.hidden = !(headlessRunning || lastQueue.length > 0);
    if (dockActionsEl) {
      dockActionsEl.hidden = !headlessRunning;
      // 引导目前只有 pi 支持（RPC steer）；omp 方言待适配,claude/codex 单发无注入点
      if (steersendBtn) steersendBtn.hidden = !(headlessRunning && node.tool === 'pi');
    }
  };
  const renderQueue = (queue) => {
    lastQueue = Array.isArray(queue) ? queue : [];
    if (!queueBarEl) return;
    if (!lastQueue.length) {
      queueBarEl.hidden = true;
      queueBarEl.innerHTML = '';
    } else {
      queueBarEl.hidden = false;
      queueBarEl.innerHTML = `<span class="queue-label">⏳ ${lastQueue.length} 条待发</span>`
        + lastQueue.map((it) => `
          <span class="queue-chip" title="${escapeHtml(it.message)}"><span class="qt">${escapeHtml(truncate(it.message, 26))}</span><button type="button" class="x" data-unqueue="${escapeHtml(it.id)}" title="撤回这条消息">✕</button></span>`).join('')
        + `<span class="queue-note">完成后自动依次发送</span>`;
    }
    updateDockRow();
  };
  queueBarEl?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-unqueue]');
    if (!btn) return;
    try {
      await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/unqueue`, { method: 'POST', body: { itemId: btn.dataset.unqueue } });
      renderQueue(lastQueue.filter((it) => it.id !== btn.dataset.unqueue));
    } catch (err) { toast(err.message); }
  });
  host.querySelector('[data-role="cancelrun"]')?.addEventListener('click', () => cancelHeadless());
  host.querySelector('[data-role="steersend"]')?.addEventListener('click', async () => {
    const text = (inputTa?.value || '').trim();
    if (!text) { toast('先在输入框里写好要引导的内容'); return; }
    try {
      await api(`/api/tasks/${currentTask.id}/send-headless`, { method: 'POST', body: { nodeId: node.id, message: text, mode: 'steer' } });
      cot.addLocalUser(text);
      if (inputTa) inputTa.value = '';
      toast('已作为引导注入：模型不中断，本轮工具结束后就能看到');
    } catch (err) { toast(err.message); }
  });
  host.querySelector('[data-role="interruptsend"]')?.addEventListener('click', async () => {
    const text = (inputTa?.value || '').trim();
    if (!text) { toast('先在输入框里写好要发送的内容，再点「中断并发送」'); return; }
    try {
      await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/interrupt-send`, { method: 'POST', body: { nodeId: node.id, message: text } });
      cot.addLocalUser(text);
      if (inputTa) inputTa.value = '';
      headlessRunning = true;
      headlessStartedAt = Date.now();
      startHeadlessStatusPoll();
      toast('已中断当前执行，新消息已发送');
    } catch (err) { toast(err.message); }
  });
  // 面板重开时接上既有状态：这个会话可能已经有正在跑的无头任务/待发队列
  (async () => {
    try {
      const r = await api(`/api/tasks/${currentTask.id}/headless-status?nodeId=${node.id}`);
      renderQueue(r?.queue || []);
      if (r?.status?.running && !headlessRunning) {
        headlessRunning = true;
        headlessStartedAt = Date.parse(r.status.startedAt) || Date.now();
        updateDockRow();
        startHeadlessStatusPoll();
        cot.refresh();
      } else {
        updateDockRow();
      }
    } catch { /* 服务暂时不可达，忽略 */ }
  })();
  scrollEl.addEventListener('scroll', scheduleStreamUi, { passive: true });

  let inputTa = null; // 输入框引用（在下方 if (active) 里赋值；「编辑重发」等回调要用）
  const cot = createCotTimeline(listEl, {
    node,
    isFirstBatch: () => firstBatch,
    nearBottom,
    toBottom,
    scheduleStreamUi,
    isTerminalRunning,
    isHeadlessRunning,
    headlessElapsed,
    scrollEl,
    onResend: (text) => {
      if (!inputTa) return;
      inputTa.value = text;
      inputTa.dispatchEvent(new Event('input', { bubbles: true }));
      inputTa.focus();
      try { inputTa.setSelectionRange(inputTa.value.length, inputTa.value.length); } catch { /* ignore */ }
    },
  });
  cot.showEmpty('正在载入工作轨迹…');

  /* 统一发送通道：输入框与「一键自检」共用。
     该会话终端正在跑 → 写 PTY；否则无头执行（回复由工作轨迹 SSE 呈现）。 */
  const deliverMessage = async (text) => {
    if (!text) return;
    if (boundRunningTerm(node)) { await sendToAgent(node, text); return; }
    const wasRunning = headlessRunning;
    if (!wasRunning) { headlessRunning = true; headlessStartedAt = Date.now(); }
    cot.addLocalUser(text);
    try {
      // 服务端忙时不再 409：直接进待发队列并立即 ACK，当前执行结束后自动依次发送
      const r = await api(`/api/tasks/${currentTask.id}/send-headless`, { method: 'POST', body: { nodeId: node.id, message: text } });
      if (r?.queued) toast(`已加入待发队列（第 ${r.queueLen} 条），当前任务完成后自动发送`);
    } catch (err) {
      if (!wasRunning) { headlessRunning = false; cot.refresh(); }
      throw err;
    }
    startHeadlessStatusPoll();
  };

  /** 取消正在跑的无头任务（服务端会杀掉整棵进程树） */
  const cancelHeadless = async () => {
    try {
      await api(`/api/tasks/${currentTask.id}/cancel-headless`, { method: 'POST', body: { nodeId: node.id } });
    } catch (err) { toast(err.message); }
  };

  /** 一键自检：把磁盘事实交给当前会话，让它确认自己是否掌握最新/完整进度（只读，不改代码） */
  async function buildSelfCheckMessage() {
    let proj = null;
    try {
      proj = (await api(`/api/tasks/${currentTask.id}/project-state`)).project;
    } catch { /* 扫描失败也继续：让 agent 自己看目录 */ }
    const lines = ['【项目进度自检】只做检查，不要修改任何文件。'];
    if (proj) {
      lines.push('sbridge 刚扫描到的项目现状（磁盘事实，优先于对话记忆）：');
      lines.push(`- 目录：${proj.cwd}`);
      if (proj.isGit) {
        lines.push(`- Git：${proj.branch || '?'} @ ${proj.head || '?'}${proj.headAt ? `（最后提交 ${fmtTime(proj.headAt)}）` : ''}`);
      } else {
        lines.push('- 非 git 目录，只能按文件修改时间判断。');
      }
      if (proj.dirtyCount) {
        lines.push(`- 未提交改动 ${proj.dirtyCount} 个文件：`);
        for (const d of (proj.dirty || []).slice(0, 10)) lines.push(`  ${d.code} ${d.path}`);
        if (proj.dirtyCount > 10) lines.push(`  …另有 ${proj.dirtyCount - 10} 个`);
      }
      if (proj.recentFiles?.length) {
        lines.push(`- 最近修改文件：${proj.recentFiles.slice(0, 6).map((f) => f.path).join('、')}`);
      }
    } else {
      lines.push('sbridge 没扫描到项目目录，请按你当前的工作目录自行判断。');
    }
    lines.push(
      '请检查并简短回答：',
      '1) 你当前掌握的进度是否覆盖上面这些改动？列出你确认已处理的文件/需求。',
      '2) 哪些改动或需求你不确定、没掌握？请现在读取相关文件确认，并在回答里说明读了什么。',
      '3) 没有缺口就明确说「已掌握最新进度」；有缺口就说明下一步该做什么。',
    );
    return lines.join('\n');
  }

  const selfCheckBtn = host.querySelector('[data-pact="selfcheck"]');
  selfCheckBtn?.addEventListener('click', async () => {
    if (selfCheckBtn.disabled) return;
    selfCheckBtn.disabled = true;
    selfCheckBtn.classList.add('active');
    try {
      const msg = await buildSelfCheckMessage();
      await deliverMessage(msg);
      toast('已发送自检请求，回复会出现在工作轨迹里');
    } catch (err) {
      toast(`自检失败: ${err.message}`);
    } finally {
      setTimeout(() => { selfCheckBtn.disabled = false; selfCheckBtn.classList.remove('active'); }, 1200);
    }
  });

  /* 会话上下文用量环：优先用工具自己记录的数字（node.ctx：codex token_count / claude usage /
     pi 状态栏，服务端从会话文件与终端输出里读），读不到才退回按事件估算 */
  const CTX_WINDOWS = { codex: 272000, claude: 200000, pi: 200000 };
  const CTX_SOURCE_LABEL = {
    'codex-token-count': 'Codex token_count',
    'claude-usage': 'Claude 会话 usage',
    'pi-status': 'Pi 状态栏',
    'pi-usage': 'Pi 会话 usage',
  };
  const RING_LEN = 50.27; // 2πr, r=8
  const ctxInit = node.ctx || null;
  let ctxTokens = ctxInit?.used ?? (Number(node.summary?.tokens) || 0);
  let ctxWindow = ctxInit?.window || CTX_WINDOWS[node.tool] || 200000;
  let ctxSource = ctxInit?.source || null;
  let ctxModel = ctxInit?.model || null;
  let ctxRaw = ctxInit?.raw || '';
  const ctxBtn = host.querySelector('[data-pact="ctx"]');
  const ctxVal = ctxBtn.querySelector('.ctx-ring-val');
  const ctxText = ctxBtn.querySelector('.ctx-ring-text');
  const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g;
  const estTokens = (text) => {
    const s = typeof text === 'string' ? text : text == null ? '' : JSON.stringify(text);
    if (!s) return 0;
    const cjk = (s.match(CJK_RE) || []).length;
    return Math.ceil(cjk / 1.15 + (s.length - cjk) / 3.6);
  };
  const updateCtxRing = () => {
    const pct = Math.min(1, ctxTokens / Math.max(1, ctxWindow));
    ctxVal.style.strokeDashoffset = String(RING_LEN * (1 - pct));
    ctxBtn.classList.toggle('ctx-warn', pct > 0.7);
    ctxBtn.classList.toggle('ctx-danger', pct >= 0.9);
    // 圆环中间直接写占比：不用悬浮也能一眼看到
    if (ctxText) {
      const n = pct * 100;
      ctxText.textContent = n > 0 && n < 1 ? '<1%' : `${Math.min(100, Math.round(n))}%`;
    }
    const src = ctxSource
      ? ` · 来源：${CTX_SOURCE_LABEL[ctxSource] || ctxSource}${ctxModel ? `（${ctxModel}）` : ''}`
      : ' · 估算（未读到工具用量）';
    ctxBtn.title = `本会话上下文：已用 ${Math.round(pct * 100)}%（${Math.round(ctxTokens / 1000)}k / ${Math.round(ctxWindow / 1000)}k 窗口）${src}${ctxRaw ? `\n${ctxRaw}` : ''}`;
  };
  updateCtxRing();

  // 工具自己更新用量后异步刷新（读不到准确值时才继续用事件估算）
  let usageTimer = null;
  const refreshUsage = (delay = 1200) => {
    clearTimeout(usageTimer);
    usageTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/usage`);
        const c = r.ctx;
        if (!c || !c.used) return;
        ctxTokens = c.used;
        ctxWindow = c.window || ctxWindow;
        ctxSource = c.source || ctxSource;
        ctxModel = c.model || null;
        ctxRaw = c.raw || '';
        updateCtxRing();
      } catch { /* 服务暂时不可达，保留原值 */ }
    }, delay);
  };
  // 面板一打开就拉一次准确用量（taskDetail 不再为所有节点预读）
  refreshUsage(0);

  const handle = (evt) => {
    if (!evt) return;
    // 有工具原生用量时不再估算，只等 refreshUsage 覆盖
    if (!ctxSource) {
      if (evt.kind === 'user' || evt.kind === 'assistant') ctxTokens += estTokens(evt.text);
      else if (evt.kind === 'tool_call') ctxTokens += estTokens(evt.args);
      else if (evt.kind === 'tool_result') ctxTokens += estTokens(evt.outcome);
    }
    updateCtxRing();
    if (evt.kind === 'assistant' || evt.kind === 'tool_result') refreshUsage();
    if (evt.type === 'gone') {
      statusEl.textContent = '会话文件已不存在';
      gone = true;
    }
    cot.handle(evt);
    touch(evt.ts);
  };

  const es = new EventSource(`/api/stream?tool=${encodeURIComponent(node.tool)}&file=${encodeURIComponent(node.file)}&tail=300`);
  es.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    cot.setConnected(true);
    statusEl.textContent = '';
    handle(evt);
    if (firstBatch && evt.kind) {
      // 历史回放是突发的一串：250ms 无新事件后一次性渲染，避免逐条重绘
      clearTimeout(handle._t);
      handle._t = setTimeout(() => {
        firstBatch = false;
        if (cot.isEmpty()) cot.showEmpty('会话还没有可展示的工作轨迹；在下方输入框发第一条消息吧。');
        else cot.finishBatch();
        if (showingStream) toBottom();
        scheduleStreamUi();
      }, 250);
    }
  };
  // 无历史会话时不让「正在载入…」一直停留
  es.onopen = () => {
    cot.setConnected(true);
    setTimeout(() => {
      if (!firstBatch || !cot.isEmpty()) return;
      cot.showEmpty('会话还没有可展示的工作轨迹；在下方输入框发第一条消息吧。');
      scheduleStreamUi();
    }, 1200);
  };
  es.onerror = () => {
    statusEl.textContent = '流已断开';
    cot.setConnected(false);
  };

  // 状态条
  const statusTimer = setInterval(() => {
    if (gone) return;
    const running = isTerminalRunning();
    if (stopBtn) stopBtn.hidden = !running; // 有活终端才显示「⏹ 停止」
    if (cancelHeadlessBtn) cancelHeadlessBtn.hidden = !headlessRunning; // 无头执行中才显示「取消执行」
    if (headlessRunning) {
      const sec = Math.max(0, Math.round(headlessElapsed() / 1000));
      statusEl.textContent = `● 正在执行 · ${sec}s`;
      return;
    }
    if (!lastTs.v) { statusEl.textContent = running ? '● 运行中' : '待活动'; return; }
    const sec = Math.max(0, Math.round((Date.now() - new Date(lastTs.v).getTime()) / 1000));
    statusEl.textContent = `${running ? '● 运行中 · ' : ''}最后活动 ${sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`} 前`;
  }, 2000);
  cotTimer = setInterval(() => cot.tick(), 500);

  // 输入
  if (active) {
    const ta = host.querySelector('[data-role="input"]');
    const btn = host.querySelector('[data-role="send"]');
    inputTa = ta;

    /* ---------- 附件 chips / @ 文件 / / 命令 / 权限档位 ---------- */
    const chipsEl = host.querySelector('[data-role="chips"]');
    let chips = [];
    const renderChips = () => {
      if (!chipsEl) return;
      chipsEl.hidden = !chips.length;
      chipsEl.innerHTML = chips.map((p, i) => `
        <span class="comp-chip" title="${escapeHtml(p)}"><span class="qt">${escapeHtml(truncate(p.split(/[\\/]/).pop(), 26))}</span><button type="button" class="x" data-chip-x="${i}" title="移除">✕</button></span>`).join('');
    };
    const addChip = (p) => {
      const v = String(p || '').trim();
      if (!v || chips.includes(v)) return;
      chips.push(v);
      renderChips();
    };
    chipsEl?.addEventListener('click', (e) => {
      const bx = e.target.closest('[data-chip-x]');
      if (!bx) return;
      chips.splice(Number(bx.dataset.chipX), 1);
      renderChips();
    });

    // @ 文件菜单：搜索当前工作目录（server 端浅层遍历），点击变成 chip
    const sessInput = host.querySelector('.sess-input');
    const fileMenu = document.createElement('div');
    fileMenu.className = 'slash-menu file-menu';
    fileMenu.hidden = true;
    sessInput.appendChild(fileMenu);
    let fileMenuTimer = null;
    const closeFileMenu = () => { fileMenu.hidden = true; };
    const openFileMenu = async (q) => {
      try {
        const r = await api(`/api/tasks/${currentTask.id}/files?cwd=${encodeURIComponent(node.cwd || '')}&q=${encodeURIComponent(q || '')}`);
        const files = r.files || [];
        fileMenu.innerHTML = files.length
          ? files.slice(0, 12).map((f) => `<button type="button" class="slash-item" data-fref="${escapeHtml(f)}"><span class="slash-cmd">@${escapeHtml(f)}</span></button>`).join('')
            + `<div class="slash-more">点击引用到消息 · Esc 关闭</div>`
          : `<div class="slash-more">没有匹配的文件（只搜工作目录浅层）</div>`;
        fileMenu.hidden = false;
      } catch { closeFileMenu(); }
    };
    const scheduleFileMenu = (q) => {
      clearTimeout(fileMenuTimer);
      fileMenuTimer = setTimeout(() => openFileMenu(q), 180);
    };
    atmenu: {
      const atBtn = host.querySelector('[data-role="at"]');
      atBtn?.addEventListener('click', () => { if (fileMenu.hidden) openFileMenu(''); else closeFileMenu(); ta.focus(); });
      fileMenu.addEventListener('mousedown', (e) => {
        const item = e.target.closest('[data-fref]');
        if (!item) return;
        e.preventDefault();
        addChip(item.dataset.fref);
        // 把输入框里未完成的 @词删掉
        const pos = ta.selectionStart ?? ta.value.length;
        const before = ta.value.slice(0, pos).replace(/(?:^|\s)@([^\s@]*)$/, (m0, pre) => (pre || '') );
        ta.value = before + ta.value.slice(pos);
        closeFileMenu();
        ta.focus();
      });
    }
    host.querySelector('[data-role="slash"]')?.addEventListener('click', () => {
      ta.value = '/';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      try { ta.setSelectionRange(1, 1); } catch { /* ignore */ }
    });

    // 权限档位 pill：点击循环 只读 → 常规 → 全自动
    const permBtn = host.querySelector('[data-role="perm"]');
    const permNameEl = host.querySelector('[data-role="permname"]');
    const PERM_META = [
      { id: 'ro', name: '只读', hint: '只允许读取与分析，不改文件不跑命令（claude/codex 支持）' },
      { id: 'normal', name: '常规', hint: '允许改文件与常规命令（默认）' },
      { id: 'yolo', name: '全自动', hint: '跳过确认由模型自行决定（谨慎使用）' },
    ];
    const applyPermUI = (level) => {
      if (!permBtn || !permNameEl) return;
      const meta = PERM_META.find((m) => m.id === level) || PERM_META[1];
      permBtn.className = `perm-pill l-${meta.id}`;
      permNameEl.textContent = meta.name;
      permBtn.title = `无头执行权限：${meta.name} — ${meta.hint}（点击切换）`;
    };
    applyPermUI(node.perm || 'normal');
    permBtn?.addEventListener('click', async () => {
      const cur = node.perm || 'normal';
      const next = PERM_META[(PERM_META.findIndex((m) => m.id === cur) + 1) % PERM_META.length];
      try {
        await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/perm`, { method: 'POST', body: { level: next.id } });
        node.perm = next.id === 'normal' ? null : next.id;
        applyPermUI(next.id);
        toast(`权限档位：${next.name}${next.id === 'ro' && (node.tool === 'pi' || node.tool === 'omp') ? '（注意：Pi/OMP 无头模式暂不支持只读）' : ''}`);
      } catch (err) { toast(err.message); }
    });

    // 「＋」菜单：上传文件 / 当前工具支持的斜杠命令
    const attachBtn = host.querySelector('[data-role="attach"]');
    attachBtn?.addEventListener('click', () => {
      openPlusMenu({
        anchor: attachBtn,
        tool: node.tool,
        stacked: false,
        onFiles: async () => {
          if (attachBtn.disabled) return;
          attachBtn.disabled = true;
          try {
            const paths = await pickLocalFiles();
            if (paths.length) {
              paths.forEach(addChip);
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
    /* 斜杠命令菜单 + 历史命令（PgUp/PgDn）：让工作轨迹输入框的手感对齐终端。
       命令表是静态精选（CLI 的完整清单未暴露 API；菜单只做辅助，手输任意命令照常发送）。 */
    const slashList = toolCommands(node.tool);
    const menu = document.createElement('div');
    menu.className = 'slash-menu';
    menu.hidden = true;
    sessInput.appendChild(menu);
    let menuItems = [];
    let menuIdx = 0;
    let historyIdx = -1;
    const HISTORY_KEY = 'sbridge-input-history';
    const loadHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}'); } catch { return {}; } };
    const pushHistory = (text) => {
      const all = loadHistory();
      const arr = all[node.tool] || [];
      if (arr[arr.length - 1] !== text) arr.push(text);
      all[node.tool] = arr.slice(-100);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(all)); } catch { /* ignore */ }
      historyIdx = -1;
    };
    const renderMenu = (filter) => {
      const q = (filter || '').replace(/^\//, '').toLowerCase();
      menuItems = slashList.filter(([cmd]) => !q || cmd.toLowerCase().startsWith(q) || cmd.toLowerCase().includes(q));
      menuIdx = 0;
      if (!menuItems.length || !filter.startsWith('/')) { menu.hidden = true; menu.innerHTML = ''; return; }
      menu.innerHTML = menuItems.map(([cmd, desc], i) => `
        <button type="button" class="slash-item ${i === menuIdx ? 'selected' : ''}" data-cmd="${cmd}">
          <span class="slash-cmd">${cmd}</span><span class="slash-desc">${desc}</span>
        </button>`).join('') + `<div class="slash-more">↑↓ 选择 · Tab/Enter 补全或发送 · Esc 关闭 (${menuItems.length})</div>`;
      menu.hidden = false;
    };
    menu.addEventListener('mousedown', (e) => {
      const item = e.target.closest('[data-cmd]');
      if (!item) return;
      e.preventDefault(); // mousedown 抢在 textarea 失焦前处理
      ta.value = '/' + item.dataset.cmd + ' ';
      menu.hidden = true;
      ta.focus();
    });
    ta.addEventListener('input', () => {
      renderMenu(ta.value);
      // 输入 @ 触发文件搜索（光标前的 @词 作为过滤条件）
      const pos = ta.selectionStart ?? ta.value.length;
      const m = ta.value.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/);
      if (m) scheduleFileMenu(m[1]);
      else closeFileMenu();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !fileMenu.hidden) { fileMenu.hidden = true; }
    });
    ta.addEventListener('keydown', (e) => {
      if (!menu.hidden && menuItems.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); menuIdx = (menuIdx + 1) % menuItems.length; renderMenu(ta.value); const sel = menu.querySelector('.selected'); sel?.scrollIntoView({ block: 'nearest' }); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); menuIdx = (menuIdx - 1 + menuItems.length) % menuItems.length; renderMenu(ta.value); const sel = menu.querySelector('.selected'); sel?.scrollIntoView({ block: 'nearest' }); return; }
        if (e.key === 'Tab') { e.preventDefault(); ta.value = '/' + menuItems[menuIdx][0] + ' '; menu.hidden = true; return; }
        if (e.key === 'Enter' && !e.shiftKey) {
          const cmd = menuItems[menuIdx][0];
          const typed = ta.value.replace(/^\//, '').trim();
          // 输入与选中项完全一致（带参数的命令由用户自行补全）才直接发送，否则先补全
          if (typed === cmd) {
            e.preventDefault();
            e.stopImmediatePropagation(); // 阻断后面的 onkeydown，防止双发
            menu.hidden = true;
            doSend();
            return;
          }
          e.preventDefault();
          ta.value = '/' + cmd + ' ';
          menu.hidden = true;
          return;
        }
        if (e.key === 'Escape') { e.preventDefault(); menu.hidden = true; return; }
      }
      // PgUp/PgDn 历史命令（与终端一致的回溯手感）
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        const arr = loadHistory()[node.tool] || [];
        if (!arr.length) return;
        e.preventDefault();
        if (historyIdx === -1) { historyIdx = arr.length; historyDraft = ta.value; }
        historyIdx += e.key === 'PageUp' ? -1 : 1;
        if (historyIdx < 0) historyIdx = 0;
        if (historyIdx >= arr.length) { historyIdx = -1; ta.value = historyDraft || ''; return; }
        ta.value = arr[historyIdx];
        setTimeout(() => ta.setSelectionRange(ta.value.length, ta.value.length), 0);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && ta.value.trim()) pushHistory(ta.value.trim());
    });
    let historyDraft = '';
    const doSend = async () => {
      const text = ta.value.trim();
      if (!text && !chips.length) return;
      menu.hidden = true;
      closeFileMenu();
      btn.disabled = true;
      try {
        const refs = chips.length ? chips.map((p) => `@${p}`).join(' ') + '\n' : '';
        const full = (refs + text).trim();
        if (!refs && text.startsWith('/')) {
          // 斜杠命令 = TUI 指令：确保终端运行并发送，切到终端视图交互
          await sendToAgent(node, text);
          applyStreamView(false);
          await ensureTerminal();
          slashSwitched = true;
        } else {
          // 终端在跑就写 PTY，否则无头执行（忙时服务端自动排队）
          await deliverMessage(full);
        }
        ta.value = '';
        chips = [];
        renderChips();
      } catch (err) {
        toast(err.message);
      } finally { btn.disabled = false; ta.focus(); }
    };
    btn.onclick = doSend;
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    };
  }

  // 工具条
  host.querySelector('[data-pact="close"]')?.addEventListener('click', () => closeTab(node.id));
  host.querySelector('[data-pact="ctx"]')?.addEventListener('click', () => openCtxModal(node));
  host.querySelector('[data-pact="handoff"]')?.addEventListener('click', () => openHandoffModal(node));
  host.querySelector('[data-pact="export"]')?.addEventListener('click', () => exportNodeMarkdown(node));
  host.querySelector('[data-pact="worktree"]')?.addEventListener('click', () => openSidePanel('worktree'));
  cancelHeadlessBtn?.addEventListener('click', () => cancelHeadless());
  // ⏹ 停止：杀掉该会话挂着的 PTY（等效在终端输入退出命令）；确认一次防误触
  const stopBtn = host.querySelector('[data-pact="stopterm"]');
  stopBtn?.addEventListener('click', () => stopNodeTerm(node));
  // 📜 会话动态 ⇄ 终端 切换（不销毁终端）
  const streamBtn = host.querySelector('[data-pact="stream"]');
  let slashSwitched = false; // 斜杠命令切到终端交互后置位：对话框结束自动回工作轨迹
  const applyStreamView = (v) => {
    showingStream = v;
    termViewEl.hidden = v;
    scrollEl.hidden = !v;
    streamBtn.innerHTML = v ? (icon('terminal') + ' 终端') : (icon('timeline') + ' 工作轨迹');
    streamBtn.title = v ? '返回原始终端' : '查看 AI 工作轨迹（步骤、查询、结果与来源）';
    streamBtn.classList.toggle('active', v);
    streamBtn.setAttribute('aria-pressed', String(v));
    if (!v) {
      streamBottomBtn.hidden = true;
      rawTerm?.refit();
      ensureTerminal(); // 首次进入终端视图：按需挂载（容器此刻可见，一切正常）
    } else {
      // 首次显示前流容器是 display:none，历史回放的 scrollTop 不会生效；这里补一次定位
      requestAnimationFrame(() => {
        if (!streamRevealed) { streamRevealed = true; toBottom(); }
        scheduleStreamUi();
      });
      try { renderSubagents(); } catch { /* ignore */ }
      // 回到工作轨迹时刷一次模型标签：终端里 /model 改过也能跟上
      if (Date.now() - modelRefreshedAt > 5000) { modelRefreshedAt = Date.now(); loadModel(); }
    }
  };
  const setStreamView = (v) => { if (showingStream !== v) applyStreamView(v); };
  streamBtn?.addEventListener('click', () => applyStreamView(!showingStream));
  applyStreamView(true); // 默认显示工作轨迹（模板初始态是终端，这里纠正）
  /* TUI 交互提醒：终端出现确认框/选择框（信任、恢复选择、/model 之类的 picker）时，
     工作轨迹里脉冲提示「终端」按钮——用户点一下即进入终端视图（此刻才按需挂载，容器
     可见，挂载与显示都正常）。不做自动切换、不做内嵌弹层：隐藏挂载会丢内容，这是
     反复出问题的根源；工作轨迹为主界面 + 终端按需挂载 = 各自都稳定。 */
  const tuiHooks = {
    onTuiDialog: (active) => {
      const paneEl = host.querySelector('.session-pane');
      if (active && paneEl?.classList.contains('active')) {
        streamBtn.classList.add('attn');
        toast('终端有待处理的确认框：点「终端」查看处理');
      } else if (!active) {
        streamBtn.classList.remove('attn');
        if (slashSwitched) { slashSwitched = false; setStreamView(true); }
      }
    },
  };
  nodeTuiHandlers.set(node.id, tuiHooks.onTuiDialog);
  /* 终端按需挂载（工作轨迹为主界面）：隐藏容器里挂载/写入 xterm 会丢内容（fit=0 尺寸
     resize 清 buffer），所以终端只在终端视图可见时才挂载。聊天消息不依赖挂载
     （sendToAgent 自己会 spawn/写 PTY），工作轨迹完全自洽。 */
  let mounting = false;
  const ensureTerminal = async () => {
    if (rawTerm || mounting) { rawTerm?.refit(); return rawTerm; }
    mounting = true;
    try {
      await refreshTerms();
      if (nodeTermFor(node)) {
        rawTerm = await mountTerm(termMountEl, node, 0, tuiHooks);
      } else {
        rawTerm = await mountTerm(termMountEl, node, 0, tuiHooks); // mountTerm 内部会 spawn
      }
      termStartBtn.hidden = true;
      refreshTermIndicators();
      return rawTerm;
    } catch (err) {
      toast(err.message);
      termStartBtn.hidden = false;
      return null;
    } finally { mounting = false; }
  };
  const autoMount = async () => {
    // 默认工作轨迹视图：不自动挂载（隐藏挂载会丢内容）。终端在用户切到终端视图时按需挂载。
    await refreshTerms();
    termStartBtn.hidden = true; // 工作轨迹下无需启动按钮
    termBottomBtn.hidden = true;
  };
  autoMount();
  termStartBtn.addEventListener('click', async () => {
    termStartBtn.disabled = true;
    termStartBtn.innerHTML = icon('play') + ' 启动中…';
    try {
      rawTerm = await mountTerm(termMountEl, node, 0, tuiHooks);
      termStartBtn.hidden = true;
      refreshTermIndicators();
      // resume 的终端不会回放历史对话（Pi/Codex TUI 只画新交互），
      // 会话有历史时自动切到「工作轨迹」让用户先看到之前的对话；
      // 想直接对话再点「⌨ 终端」切回来即可。
      if (node.summary?.messageCount > 0) {
        const streamBtn = host.querySelector('[data-pact="stream"]');
        if (streamBtn && streamBtn.getAttribute('aria-pressed') !== 'true') streamBtn.click();
      }
    } catch (err) {
      toast(err.message);
      termStartBtn.hidden = false; // 自动启动失败时按钮要重新出现（手动路径本就可见）
      termStartBtn.disabled = false;
      termStartBtn.innerHTML = icon('play') + ' 启动此会话的终端';
    }
  });
  termBottomBtn.addEventListener('click', () => rawTerm?.scrollToBottom());
  // 终端无本地回滚时（resume 新进程），引导用户到工作轨迹查看历史
  termHistoryBtn.addEventListener('click', () => {
    const streamBtn = host.querySelector('[data-pact="stream"]');
    if (streamBtn && streamBtn.getAttribute('aria-pressed') !== 'true') streamBtn.click();
  });
  streamBottomBtn.addEventListener('click', () => { toBottom(); scheduleStreamUi(); });

  return {
    close() {
      es.close();
      clearInterval(statusTimer);
      clearInterval(cotTimer);
      clearTimeout(handle._t);
      clearTimeout(headlessPollTimer);
      clearTimeout(usageTimer);
      cot.destroy();
      if (streamUiFrame) cancelAnimationFrame(streamUiFrame);
      if (rawTerm) { try { rawTerm.dispose(); } catch { /* ignore */ } rawTerm = null; }
    },
    refit() { if (!showingStream) rawTerm?.refit(); },
    // 任务数据刷新后（新建了分支/接入了新会话）立刻重算「跳转到最新会话」提示条
    refreshForkAlert: renderForkAlert,
    node,
  };
}

/* Ctrl+T：打开焦点面板的模型弹层（思考强度也在这个弹层里）。
   终端里按 Ctrl+T 可能被 shell/TUI 用掉，这里不拦，留给终端。 */
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || (e.key || '').toLowerCase() !== 't') return;
  if (e.target?.closest?.('.xterm, .term-view')) return;
  if (document.querySelector('.modal-mask:not([hidden])')) return;
  const btn = document.querySelector('.pane-host.focused [data-role="model"]')
    || document.querySelector('[data-role="model"]');
  if (!btn) return;
  e.preventDefault();
  btn.click();
});


