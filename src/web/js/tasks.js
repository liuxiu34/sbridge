/* sbridge · 任务数据：加载状态、打开任务、刷新 */

/* ---------------- 任务 ---------------- */
async function loadState() {
  state = await api('/api/state');
  if (!state.tools?.length) {
    try {
      const t = await api('/api/tools');
      state.tools = t.tools;
    } catch { state.tools = DEFAULT_TOOLS; }
  }
  // 每个工具支持哪些「模式」（Claude/Codex 内置；Pi 看扩展装没装）
  try {
    const t = await api('/api/tools');
    state.toolModes = Object.fromEntries((t.tools || []).map((x) => [x.id, x.modes || []]));
  } catch { state.toolModes = null; }
  renderTree();
  refreshTerms();
}
// 卡片上的「终端运行中」小绿点：每 5 秒兜底刷新（启动/停止等动作已即时刷新）
setInterval(() => { if (currentTaskId) { refreshTerms().then(renderBoard); } }, 5000);

async function openTask(taskId) {
  currentTaskId = taskId;
  let detail;
  try {
    detail = await api(`/api/tasks/${taskId}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  currentTask = detail;
  cacheTask(currentTask);
  /* 切任务只切换「侧栏会话链 / 白板」的上下文，不再销毁已打开的标签与面板：
     之前打开的会话（含其他任务的）保持原位，后台 SSE 继续积累，分屏也自然跨任务。
     任务里有已打开的会话就聚焦最近打开的那个，没有才补开该任务最新的会话。 */
  // ownTabs 存的是 nodeId；任务里有已打开的会话就聚焦最近打开的那个，没有才补开该任务最新的会话
  const ownTabs = openTabs.filter((id) => findNode(id) && taskIdForNode(id) === taskId);
  renderTree();
  boardSel.clear();
  closeBoardMenu();
  renderBoard();
  $('task-actions').hidden = false;
  const target = ownTabs[ownTabs.length - 1] || currentTask.nodes[currentTask.nodes.length - 1]?.id || null;
  if (target) openSessionTab(target);
  else { renderTabs(); renderPanes(); }
}

async function refreshTask() {
  if (!currentTask) return;
  currentTask = await api(`/api/tasks/${currentTask.id}`);
  cacheTask(currentTask);
  // 会话集合变了（新建分支/接入新会话）→ 每个已打开面板的「跳转到最新会话」提示条重算一次，
  // 否则它只在面板首次创建时算过，会一直停在旧结论上。
  for (const h of paneHandles.values()) { try { h.refreshForkAlert?.(); } catch { /* ignore */ } }
  await loadState();
  renderBoard();
}

