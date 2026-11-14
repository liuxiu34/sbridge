/* sbridge · 入口：启动流程（所有模块按顺序加载后执行这里） */

/* ---------------- 启动 ---------------- */
// 主题：恢复上次选择 + 绑定侧栏左下角的切换按钮
theme.apply();
$('btn-theme')?.addEventListener('click', () => theme.toggle());
/* 静态按钮图标注入（index.html 里的按钮，文本保留、字符图标换 SVG） */
(function decorateStaticIcons() {
  const decorate = (id, name, label) => {
    const b = $(id);
    if (b) b.innerHTML = icon(name) + (label ? ' ' + label : '');
  };
  decorate('btn-discover', 'radar', '自动获取项目');
  decorate('btn-settings', 'settings', '设置');
  decorate('btn-new-task', 'plus', '新建任务');
  // btn-new-project 已改为「项目文件夹」标题右侧的 ＋（renderTree 动态创建，纯文本）
  decorate('btn-search', 'search', '搜索会话');
  $('btn-search').insertAdjacentHTML('beforeend', '<kbd>Ctrl K</kbd>');
  decorate('btn-panel', 'panel', '面板');
  decorate('btn-board-view2', 'board', '接力白板');
  decorate('btn-launch', 'plus', '新开会话');
  decorate('btn-split', 'split', '分屏');
  decorate('btn-attach', 'link', '接入已有会话');
  const bb = $('btn-board-view');
  if (bb) bb.innerHTML = icon('board', 12) + ' 白板视图';
  document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
})();

// 菜单的鼠标和键盘收起共用同一规则，不影响其内按钮原有的业务处理。
$('btn-sidebar').addEventListener('click', () => {
  const open = document.body.classList.toggle('sidebar-open');
  $('btn-sidebar').setAttribute('aria-expanded', String(open));
});
const closeSidebar = () => { document.body.classList.remove('sidebar-open'); $('btn-sidebar').setAttribute('aria-expanded', 'false'); };
document.addEventListener('click', (event) => {
  if (!event.target.closest('#btn-sidebar') && (event.target.closest('.main') || event.target.closest('[data-task], [data-mnode]'))) closeSidebar();
  document.querySelectorAll('details.workspace-menu[open], details.pane-menu[open]').forEach((menu) => {
    if (!menu.contains(event.target) || event.target.closest('.action-menu button')) menu.open = false;
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeSidebar();
  const menu = document.querySelector('details.workspace-menu[open], details.pane-menu[open]');
  if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); event.preventDefault(); }
});

/* 赞助入口：配置了链接才显示（不配置就不打扰用户） */
(function initSupportEntry() {
  const btn = $('btn-support');
  if (!btn) return;
  const configured = Object.values(SUPPORT_LINKS).some((v) => String(v || '').trim());
  btn.hidden = !configured;
  if (configured) btn.addEventListener('click', openSupportModal);
})();

setupBoardInteractions();
initSidePanel();
updateSplitControls();
loadState().then(() => {
  const latest = [...state.tasks].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (latest) openTask(latest.id);
  else { $('task-actions').hidden = true; }
}).catch((err) => toast(err.message));

