/* sbridge · 任务数据：加载状态、打开任务、刷新 */

/* ---------------- 任务 ---------------- */
async function loadState() {
  state = await api('/api/state');
  if (!state.tools?.length) {
    try { state.tools = (await api('/api/tools')).tools; } catch { state.tools = DEFAULT_TOOLS; }
  }
  renderTree();
  refreshTerms();
}
// 卡片上的「终端运行中」小绿点：每 5 秒兜底刷新（启动/停止等动作已即时刷新）
setInterval(() => { if (currentTaskId) { refreshTerms().then(renderBoard); } }, 5000);

async function openTask(taskId) {
  currentTaskId = taskId;
  closeAllPanes();
  renderPanes();
  try {
    currentTask = await api(`/api/tasks/${taskId}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  renderTree();
  boardSel.clear();
  closeBoardMenu();
  renderBoard();
  $('task-actions').hidden = false;
  // 自动打开该任务最近的一个会话（没有就停在白板/空态）
  const last = currentTask.nodes[currentTask.nodes.length - 1];
  if (last) openSessionTab(last.id);
}

async function refreshTask() {
  if (!currentTask) return;
  currentTask = await api(`/api/tasks/${currentTask.id}`);
  await loadState();
  renderBoard();
}

