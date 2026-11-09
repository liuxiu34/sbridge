/* sbridge · 顶部操作与静态按钮绑定 */

/* ---------------- 顶部操作 ---------------- */
$('btn-new-task').onclick = () => createTaskFlow(null);
$('btn-search').onclick = () => openSearchModal();
// Ctrl/Cmd+K 打开全局搜索（和浏览器地址栏快捷键冲突时以应用为准）
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    openSearchModal();
  }
});
// Ctrl/Cmd+B 开关右侧面板；Esc 在无弹窗时收起面板
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault();
    toggleSidePanel();
    return;
  }
  if (e.key === 'Escape' && sidePanelOpen() && $('modal').hidden) {
    toggleSidePanel(false);
  }
});
function sidePanelOpen() { return !$('side-panel').hidden; }
// btn-new-project / btn-tree-toggle 在 renderTree 的 group-label 里（每次重渲染重建），用委托绑定
$('tree').addEventListener('click', (e) => {
  if (e.target.closest('#btn-new-project')) { createProjectFlow(); return; }
  if (e.target.closest('#btn-tree-toggle')) { toggleTreeCollapsed(); }
});
// 自动获取项目：手动触发扫描三个工具的会话目录，按 cwd 分组导入（不自动运行）
$('btn-settings').onclick = () => openSettingsModal();
$('btn-discover').onclick = async () => {
  const btn = $('btn-discover');
  if (!confirm('扫描 Codex / Pi / Claude Code 的全部会话，按项目目录归组导入看板？\n\n每个目录 = 一个项目文件夹，其下建一个「自动获取」任务收纳该目录所有工具的会话；已导入过的会话自动跳过。')) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '扫描中…（可能要十几秒）';
  try {
    const r = await api('/api/discover', { method: 'POST', body: {} });
    if (r.nodesAdded === 0 && r.projectsCreated === 0) {
      toast('扫描完成：没有发现可导入的新会话（都已在看板里或没有实际对话）');
    } else {
      toast(`已导入 ${r.nodesAdded} 个会话：新建 ${r.projectsCreated} 个项目文件夹、${r.tasksCreated} 个任务${r.readFail ? `（${r.readFail} 个会话读取失败已跳过）` : ''}`);
    }
    await loadState(); // renderTree 在内：侧栏立即出现新项目/任务
    if (currentTaskId) {
      try { currentTask = await api(`/api/tasks/${currentTaskId}`); renderTabs(); } catch { /* 任务可能已变化 */ }
    }
  } catch (err) {
    toast(`自动获取失败: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
};
$('btn-launch').onclick = () => { if (currentTask) launchFlow(); };
$('btn-attach').onclick = () => attachFlow();
$('btn-term-close').onclick = () => openTermCloseModal();
// 会话标签：激活 / 关闭
$('sess-tabs').addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) { e.stopPropagation(); closeTab(closeBtn.dataset.close); return; }
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  if (e.shiftKey) openInOtherSlot(tab.dataset.tab);
  else openSessionTab(tab.dataset.tab);
});
$('btn-split').onclick = () => toggleSplit();
/* 顶栏「更多」折叠菜单：白板 / 分屏常驻，新开会话、接入、标记完成、删除任务收进菜单 */
(function bindMoreMenu() {
  const wrap = $('more-wrap');
  const menu = $('more-menu');
  const btn = $('btn-more');
  if (!wrap || !menu || !btn) return;
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('active', open);
  };
  btn.setAttribute('aria-haspopup', 'menu');
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
  // 选择菜单项后立即收起（各按钮自己的 onclick 照常执行）
  menu.addEventListener('click', (e) => { if (e.target.closest('.more-item')) setOpen(false); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#more-wrap')) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
})();
$('split-right').onchange = (e) => {
  if (!e.target.value) return;
  layout.mode = 'split';
  openSessionTab(e.target.value, { slot: 1, split: true });
};
// 白板视图切换（顶栏按钮 + 侧栏链接）
$('btn-board-view2').onclick = () => toggleBoardView();
$('btn-board-view').onclick = () => toggleBoardView();
$('btn-status').onclick = async () => {
  if (!currentTask) return;
  const status = currentTask.status === 'done' ? 'active' : 'done';
  await api(`/api/tasks/${currentTask.id}`, { method: 'PATCH', body: { status } });
  await refreshTask();
};
$('btn-delete-task').onclick = async () => {
  if (!currentTask) return;
  if (!confirm(`删除任务「${currentTask.title}」？本地会话文件不会被删除。`)) return;
  await api(`/api/tasks/${currentTask.id}`, { method: 'DELETE' });
  currentTask = null;
  currentTaskId = null;
  closeAllPanes();
  renderPanes();
  await loadState();
  renderBoard();
};

