/* sbridge · 接力与上下文面板：检查点生成、任务上下文展示 */

/* ---------------- 智能接力与上下文面板 ---------------- */

async function smartHandoff(node, toTool, btn = null) {
  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在生成检查点…（含增量捕获与 LLM 加工，约 10-60 秒）';
  }
  try {
    const data = await api(`/api/tasks/${currentTask.id}/handoff-smart`, {
      method: 'POST',
      body: { nodeId: node.id, toTool, cwd: node.cwd || undefined, embed: true },
    });
    await refreshTask();
    await refreshTerms();
    const how = data.llmUsed ? 'LLM 加工' : '规则生成';
    const loss = data.lossReport;
    const lossTxt = loss
      ? `；纳入 ${loss.knowledgeIncluded}/${loss.knowledgeTotal} 认知 · 证据 ${loss.evidenceIncluded}/${loss.evidenceTotal}${loss.dedupMerged ? ` · 去重合并 ${loss.dedupMerged} 条` : ''}`
      : '';
    const wtTxt = data.worktree?.path ? ` · 独立 worktree: ${data.worktree.path}` : '';
    const truthTxt = data.truthScan ? ' · 含项目现状扫描' : '';
    toast(`检查点 v${data.checkpointVersion} 已注入 ${toolLabel(toTool)} 新会话（${data.injectedTokens} tokens，${how}${lossTxt}${truthTxt}${wtTxt}），已在新标签打开，直接继续开发`);
    // 新会话作为新标签就地打开（旧会话标签保留，随时切回回看）
    openSessionTab(data.node.id);
  } catch (err) {
    toast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

const CTX_BADGE = { verified: '已验证', open: '待验证', refuted: '已排除', stale: '已过期', error: '错误', test: '测试', command: '命令', diff: '修改' };

async function renderCtxInto(el, node) {
  if (!el) return;
  try {
    const data = await api(`/api/tasks/${currentTask.id}/context`);
    if (data.unbound || !data.summary) {
      el.innerHTML = '<div class="empty-tree">任务尚未绑定动态上下文；点「智能接力」时会自动绑定并捕获。</div>';
      return;
    }
    const s = data.summary;
    const c = s.counts || {};
    const costs = data.costs || null;
    const latest = s.latestCheckpoint || null;
    const section = (label, items) => {
      if (!items.length) return '';
      return `<div class="ctx-label">${label}</div>${items.map((h) => h).join('')}`;
    };
    const changed = s.codeRefs.filter((r) => (r.note || '').includes('已变化'));
    el.innerHTML = `
      <div class="ctx-row" style="margin-bottom:10px">
        <span class="ctx-item" style="margin:0">知识 ${c.knowledge}${c.knowledgeStale ? `（过期 ${c.knowledgeStale}）` : ''}</span>
        <span class="ctx-item" style="margin:0">证据 ${c.evidence}</span>
        <span class="ctx-item" style="margin:0">假设 ${c.hypothesesOpen} 开放 / ${c.hypothesesRefuted} 已排除</span>
        <span class="ctx-item" style="margin:0">文件追踪 ${c.codeRefs}</span>
        ${latest ? `<span class="ctx-item" style="margin:0">检查点 v${latest.version} · ${latest.injectedTokens} tokens${latest.llmUsed ? ' · LLM' : ''}${latest.loss ? ` · 纳入 ${latest.loss.knowledgeIncluded}/${latest.loss.knowledgeTotal} 认知` : ''}</span>` : ''}
      </div>
      ${section('项目认知（跨任务沉淀）', s.projectKnowledge.slice(0, 6).map((k) => `<div class="ctx-item"><span class="badge ${k.status}">${CTX_BADGE[k.status] || k.status}</span>${escapeHtml(k.content.length > 150 ? k.content.slice(0, 150) + '…' : k.content)}</div>`))}
      ${section('任务认知', s.knowledge.slice(0, 6).map((k) => `<div class="ctx-item"><span class="badge ${k.status}">${CTX_BADGE[k.status] || k.status}</span>${escapeHtml(k.content.length > 150 ? k.content.slice(0, 150) + '…' : k.content)}</div>`))}
      ${section('判断与假设', s.hypotheses.slice(0, 6).map((h) => `<div class="ctx-item"><span class="badge ${h.status}">${CTX_BADGE[h.status] || h.status}</span>${escapeHtml(h.content.length > 150 ? h.content.slice(0, 150) + '…' : h.content)}</div>`))}
      ${section('关键证据', s.evidence.slice(0, 6).map((e) => `<div class="ctx-item"><span class="badge ${e.kind}">${CTX_BADGE[e.kind] || e.kind}</span>${e.count > 1 ? `<b>×${e.count}</b> ` : ''}${escapeHtml(e.summary.length > 130 ? e.summary.slice(0, 130) + '…' : e.summary)}</div>`))}
      ${changed.length ? section('已变化文件（相关认知需重读）', changed.slice(0, 5).map((r) => `<div class="ctx-item"><span class="badge stale">已变化</span><span class="mono" style="font-size:11px">${escapeHtml(r.path)}</span></div>`)) : ''}
      ${costs ? section('切换成本', [
        `<div class="ctx-item">接力 ${costs.handoffCount} 次（平均 ${(costs.avgHandoffMs / 1000).toFixed(1)}s） · 累计注入 ${fmtTokens(costs.injectedTokens)} tokens · LLM 加工 ${costs.llmUsedCount || 0} 次共 ${fmtTokens(costs.llmTokens)} tokens</div>`,
        `<div class="ctx-item">规则去重已合并重复证据 ${costs.duplicatedEvidenceMerged} 条（零 Token）</div>`,
      ]) : ''}
      ${costs && costs.handoffCount ? '<button class="btn-ghost small" id="ctx-history">检查点历史 / 回退</button>' : ''}
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-tree">上下文读取失败：${escapeHtml(err.message)}</div>`;
    return;
  }
  $('ctx-history')?.addEventListener('click', () => showCheckpointHistory(node));
}

async function showCheckpointHistory(node) {
  const data = await api(`/api/tasks/${currentTask.id}/checkpoints`);
  const others = (state.tools?.length ? state.tools : DEFAULT_TOOLS).filter((t) => t.id !== node.tool);
  let toTool = others[0]?.id || node.tool;
  const lossText = (c) => c.loss
    ? ` · 纳入 ${c.loss.knowledgeIncluded}/${c.loss.knowledgeTotal} 认知 · 证据 ${c.loss.evidenceIncluded}/${c.loss.evidenceTotal}`
    : '';
  openModal({
    title: '检查点历史与回退',
    bodyHtml: `${others.length > 1 ? `<div class="segmented" id="rb-tool-switch">${toolButtonsHtml(toTool, node.tool)}</div>` : ''}
      <div class="pick-list">${data.checkpoints.map((c) => `
      <div class="pick" data-version="${c.version}">
        <span class="pick-radio"></span>
        <div class="pick-main">
          <div class="pick-title">v${c.version} · ${c.injectedTokens} tokens${c.llmUsed ? ' · LLM 加工' : ' · 规则生成'}${lossText(c)}</div>
          <div class="pick-sub">${fmtTime(c.createdAt)}</div>
        </div>
      </div>`).join('') || '<div class="empty-tree">暂无历史检查点</div>'}</div>
      <div class="hint" style="color:#9a9aa4;margin-top:10px">回退会用所选版本的检查点生成一条新的 ${toolLabel(toTool)} 会话（不覆盖历史，新生成一条）。</div>`,
    submitLabel: '用此版本接力',
    onSubmit: async () => {
      const sel = document.querySelector('#modal-body .pick.selected');
      if (!sel) throw new Error('请选择一个检查点版本');
      const r = await api(`/api/tasks/${currentTask.id}/checkpoint?rollback=1`, {
        method: 'POST',
        body: { toTool, version: Number(sel.dataset.version), cwd: node.cwd || undefined, launch: false },
      });
      await refreshTask();
      openSessionTab(r.node.id);
      toast(`已用 v${r.checkpointVersion} 生成 ${toolLabel(toTool)} 会话：${r.resumeCommand}`);
    },
  });
  $('modal-body').querySelectorAll('[data-version]').forEach((el) => {
    el.addEventListener('click', () => {
      $('modal-body').querySelectorAll('.pick').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
    });
  });
  $('modal-body').querySelectorAll('#rb-tool-switch button').forEach((btn) => {
    btn.addEventListener('click', () => {
      toTool = btn.dataset.tool;
      $('modal-body').querySelectorAll('#rb-tool-switch button').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
}

