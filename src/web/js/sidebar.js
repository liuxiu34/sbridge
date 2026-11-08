/* sbridge · 侧栏：项目/任务树 */

/* ---------------- 侧栏 ---------------- */
let treeCollapsed = false; // 项目文件夹下的任务是否全部收起

function toggleTreeCollapsed() {
  treeCollapsed = !treeCollapsed;
  renderTree();
}

function renderTree() {
  const tree = $('tree');
  const tasksByProject = new Map();
  const loose = [];
  for (const t of state.tasks) {
    if (t.projectId) {
      if (!tasksByProject.has(t.projectId)) tasksByProject.set(t.projectId, []);
      tasksByProject.get(t.projectId).push(t);
    } else loose.push(t);
  }

  const taskHtml = (t) => `
    <div class="task-item ${t.id === currentTaskId ? 'active' : ''}" data-task="${t.id}">
      <span class="dot"></span>
      <span class="t-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
      <span class="count" style="font-size:11px;color:#9a9aa4">${t.nodeCount}</span>
    </div>`;

  let html = `<div class="group-label">
    <span>项目文件夹</span>
    <span class="tree-actions">
      <button class="tree-toggle" id="btn-tree-toggle" title="${treeCollapsed ? '展开所有项目下的任务' : '收起所有项目下的任务'}">${treeCollapsed ? '展开' : '收回'}</button>
      <button class="add" id="btn-new-project" title="新建项目文件夹">＋</button>
    </span>
  </div>`;
  if (!state.projects.length) {
    html += '<div class="empty-tree">还没有项目文件夹，先在底部新建一个。</div>';
  }
  for (const p of state.projects) {
    const list = tasksByProject.get(p.id) || [];
    html += `<div class="project">
      <div class="project-name" title="${p.cwd ? escapeHtml(p.cwd) : ''}">
        <span class="project-dot"></span>
        <span>${escapeHtml(p.name)}</span>
        <span class="count">${list.length}</span>
        <button class="add" data-new-task-in="${p.id}" title="在此项目下新建任务">＋</button>
      </div>
      <div class="project-tasks"${treeCollapsed ? ' hidden' : ''}>${list.map(taskHtml).join('')}</div>
    </div>`;
  }

  html += '<div class="group-label"><span>独立任务</span></div>';
  html += loose.length ? loose.map(taskHtml).join('') : '<div class="empty-tree">没有独立任务</div>';

  tree.innerHTML = html;
  tree.querySelectorAll('[data-task]').forEach((el) => {
    el.addEventListener('click', () => openTask(el.dataset.task));
  });
  tree.querySelectorAll('[data-new-task-in]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      createTaskFlow(el.dataset.newTaskIn);
    });
  });
}

