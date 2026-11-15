/* sbridge · 侧栏：项目/任务树 */

/* ---------------- 侧栏 ---------------- */
// 各项目独立收起并保留选择，刷新任务或切换主题不会重置。
const COLLAPSED_PROJECTS_KEY = 'sbridge-collapsed-projects';
let collapsedProjects;
try { collapsedProjects = new Set(JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) || '[]')); }
catch { collapsedProjects = new Set(); }
const saveCollapsedProjects = () => {
  try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsedProjects])); } catch { /* 私密模式 */ }
};

function toggleTreeCollapsed() {
  const allClosed = state.projects.length > 0 && state.projects.every((p) => collapsedProjects.has(p.id));
  collapsedProjects = new Set(allClosed ? [] : state.projects.map((p) => p.id));
  saveCollapsedProjects();
  renderTree();
}

function renderTree() {
  const tree = $('tree');
  const treeCollapsed = state.projects.length > 0 && state.projects.every((p) => collapsedProjects.has(p.id));
  const tasksByProject = new Map();
  const loose = [];
  for (const t of state.tasks) {
    if (t.projectId) {
      if (!tasksByProject.has(t.projectId)) tasksByProject.set(t.projectId, []);
      tasksByProject.get(t.projectId).push(t);
    } else loose.push(t);
  }

  /* 自动归组出来的任务名与项目目录同名（一个项目下就一个任务）：
     这时再显示一遍目录名是纯重复，改成「全部会话」更符合它的实际含义。 */
  const taskHtml = (t, projectName = '') => {
    const same = projectName && String(t.title || '').trim() === String(projectName).trim();
    const label = same ? '全部会话' : (t.title || '(未命名任务)');
    return `
    <button type="button" class="task-item ${t.id === currentTaskId ? 'active' : ''}" data-task="${t.id}" ${t.id === currentTaskId ? 'aria-current="true"' : ''}>
      <span class="dot"></span>
      <span class="t-title" title="${escapeHtml(t.title)}">${escapeHtml(label)}</span>
      <span class="count" title="会话数">${t.nodeCount || 0}</span>
    </button>`;
  };

  let html = `<div class="group-label">
    <span>项目文件夹</span>
    <span class="tree-actions">
      <button class="tree-toggle" id="btn-tree-toggle" title="${treeCollapsed ? '展开所有项目下的任务' : '收起所有项目下的任务'}">${treeCollapsed ? '展开' : '收起'}</button>
      <button class="add" id="btn-new-project" title="新建项目文件夹">＋</button>
    </span>
  </div>`;
  if (!state.projects.length) {
    html += '<div class="empty-tree">点击标题旁的 ＋ 添加项目文件夹。</div>';
  }
  for (const p of state.projects) {
    const list = tasksByProject.get(p.id) || [];
    html += `<div class="project">
      <div class="project-name" title="${p.cwd ? escapeHtml(p.cwd) : ''}">
        <button type="button" class="project-toggle" data-toggle-project="${p.id}" aria-expanded="${!collapsedProjects.has(p.id)}" aria-label="${collapsedProjects.has(p.id) ? '展开' : '收起'} ${escapeHtml(p.name)}">
          <span class="project-chevron">${icon('chevronDown', 12)}</span>${icon('folder', 14)}<span>${escapeHtml(p.name)}</span><span class="count">${list.length}</span>
        </button>
        <button class="add" data-new-task-in="${p.id}" title="在此项目下新建任务">＋</button>
        <button class="project-del" data-del-project="${p.id}" title="删除项目文件夹（任务移到独立任务，不会删除本地会话文件）">${icon('x', 11)}</button>
      </div>
      <div class="project-tasks"${collapsedProjects.has(p.id) ? ' hidden' : ''}>${list.map((t) => taskHtml(t, p.name)).join('')}</div>
    </div>`;
  }

  html += '<div class="group-label"><span>独立任务</span></div>';
  html += loose.length ? loose.map(taskHtml).join('') : '<div class="empty-tree">没有独立任务</div>';

  tree.innerHTML = html;
  tree.querySelectorAll('[data-toggle-project]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.toggleProject;
      if (collapsedProjects.has(id)) collapsedProjects.delete(id); else collapsedProjects.add(id);
      saveCollapsedProjects();
      renderTree();
      tree.querySelector(`[data-toggle-project="${CSS.escape(id)}"]`)?.focus();
    });
  });
  tree.querySelectorAll('[data-task]').forEach((el) => {
    el.addEventListener('click', () => openTask(el.dataset.task));
  });
  tree.querySelectorAll('[data-new-task-in]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      createTaskFlow(el.dataset.newTaskIn);
    });
  });
  tree.querySelectorAll('[data-del-project]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteProjectFlow(el.dataset.delProject);
    });
  });
}

/** 删除项目文件夹：只移除看板分组，任务转为独立任务；本地会话文件一律不动 */
async function deleteProjectFlow(projectId) {
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) return;
  if (!confirm(`删除项目文件夹「${p.name}」？\n\n项目下的任务会移到「独立任务」，只移除看板分组；不会删除任何本地会话文件或数据。`)) return;
  try {
    await api(`/api/projects/${projectId}`, { method: 'DELETE' });
    if (currentTask?.projectId === projectId) {
      currentTask.projectId = null;
      try { currentTask = await api(`/api/tasks/${currentTask.id}`); } catch { /* ignore */ }
    }
    await loadState();
    toast('项目文件夹已删除，任务已移到独立任务');
  } catch (err) { toast(err.message); }
}

