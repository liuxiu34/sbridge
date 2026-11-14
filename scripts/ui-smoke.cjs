// 隐藏 Electron 窗口中的真实 DOM/事件测试；API 为本进程的隔离 fixture。
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = process.env.SBRIDGE_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-ui-qa-'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-ui-profile-')));
app.disableHardwareAcceleration();
let server, win;
(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(url.pathname === '/api/state' ? { projects: [], tasks: [] } : url.pathname === '/api/terms' ? { terms: [] } : {}));
    }
    const file = path.join(root, 'src/web', url.pathname === '/' ? 'index.html' : url.pathname);
    try {
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  win = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error('Renderer:', event.message);
  });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const evaluate = (code) => win.webContents.executeJavaScript(code, true);
  await evaluate(`
    window.auditCalls = []; window.auditErrors = [];
    window.addEventListener('error', (e) => auditErrors.push(e.message));
    window.auditSnapshot = {status:{running:true,phase:'waiting-input',runId:'run-1',startedAt:Date.now()},queue:[],interactions:[{
      id:'question-1',runId:'run-1',kind:'questions',title:'需要你做个选择',questions:[{
        id:'strategy',question:'这次修复采用哪种验证方式？',allowCustom:true,multiSelect:false,
        options:[{label:'自动回归与界面验证',value:'自动回归与界面验证',description:'检查发送、队列、中断，以及安装版的实际界面。'},
          {label:'仅检查当前页面',value:'仅检查当前页面',description:'只检查本页的显示与交互。'}]
      }]}]};
    window.auditApi = async (url, options = {}) => {
      if (url.includes('headless-status')) return structuredClone(auditSnapshot);
      if (url.endsWith('/model')) return {current:'test-model',options:[],effort:{levels:[]}};
      if (url.endsWith('/subagents')) return {sessions:[],fix:{}};
      if (options.method === 'POST') {
        auditCalls.push({url,body:options.body});
        await new Promise(resolve=>setTimeout(resolve,100));
        if(url.endsWith('/answer')) auditSnapshot.interactions=[];
        return {ok:true,queued:false};
      }
      return {};
    };
    window.fetch = async (url, options = {}) => new Response(JSON.stringify(await auditApi(url, {
      ...options, body: options.body ? JSON.parse(options.body) : undefined,
    })), { headers: { 'content-type': 'application/json' } });
    window.auditStreams=[];
    window.EventSource = class { constructor(url){this.url=url;auditStreams.push(this)} close(){this.closed=true} addEventListener(){} };
    window.auditNode={id:'audit-node',tool:'pi',title:'工作轨迹交互验证',cwd:'C:/audit',file:'audit.jsonl'};
    currentTask={id:'audit-task',nodes:[auditNode],project:{name:'隔离验证'}};
    window.auditMount=document.createElement('div');auditMount.className='pane-host focused';
    auditMount.style.cssText='position:fixed;inset:16px;z-index:100;background:var(--bg);height:calc(100vh - 32px);width:calc(100vw - 32px)';
    document.body.appendChild(auditMount);
    window.auditPane=createSessionPane(auditMount,auditNode);
    void 0;
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(await evaluate(`document.querySelectorAll('.interaction-option').length`), 2);
  await evaluate(`document.querySelector('.interaction-option input').click()`);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(await evaluate(`document.querySelector('.interaction-option input').checked`), true, 'polling must preserve selection');
  await evaluate(`auditPane.close();auditPane=createSessionPane(auditMount,auditNode);void 0;`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate(`document.querySelector('.interaction-option input').checked`), true, 'reopen must restore draft');
  for (const theme of ['light', 'dark']) {
    await evaluate(`theme.current='${theme}';theme.apply();void 0;`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(path.join(output, `interaction-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  }
  win.setSize(650, 800);
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(output, 'interaction-narrow.png'), (await win.webContents.capturePage()).toPNG());
  const layout = await evaluate(`(()=>{const c=document.querySelector('[data-role="composer"]').getBoundingClientRect();const p=document.querySelector('.interaction-panel').getBoundingClientRect();return {composerVisible:c.top>=0&&c.bottom<=innerHeight,panelAboveComposer:p.bottom<=c.top+1,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert.equal(layout.composerVisible, true, JSON.stringify(layout));
  assert.equal(layout.panelAboveComposer, true, JSON.stringify(layout));
  await evaluate(`document.querySelector('.interaction-footer .primary').click();document.querySelector('.interaction-footer .primary').click()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const answers = await evaluate(`auditCalls.filter(c=>c.url.endsWith('/answer'))`);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].body.answers.strategy[0], '自动回归与界面验证');
  await evaluate(`
    window.ta=auditMount.querySelector('[data-role="input"]');
    ta.value='中文草稿';ta.dispatchEvent(new Event('input',{bubbles:true}));
    ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
  `);
  assert.equal(await evaluate(`auditCalls.filter(c=>c.url.endsWith('/send-headless')).length`), 0);
  await evaluate(`
    ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    ta.value='发送期间的新草稿';ta.dispatchEvent(new Event('input',{bubbles:true}));
  `);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await evaluate(`auditCalls.filter(c=>c.url.endsWith('/send-headless')).length`), 1);
  assert.equal(await evaluate(`ta.value`), '发送期间的新草稿');
  await evaluate(`auditSnapshot.session={id:'same-session',file:'updated.jsonl'};void 0;`);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(await evaluate(`auditStreams.at(-2).closed && auditStreams.at(-1).url.includes('updated.jsonl')`), true, 'session file updates must reconnect stream');
  await evaluate(`
    auditSnapshot.interactions=[{id:42,runId:'run-1',kind:'approval',title:'是否允许执行命令？',description:'echo test',choices:[{id:'accept',label:'允许本次'},{id:'decline',label:'拒绝'}]}];void 0;
  `);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  await evaluate(`document.querySelector('[data-decision="decline"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const declined = await evaluate(`auditCalls.filter(c=>c.url.endsWith('/answer')).at(-1).body`);
  assert.equal(declined.interactionId, 42);
  assert.equal(declined.decision, 'decline');
  await evaluate(`auditSnapshot.interactions=[{id:'omp-toggle',runId:'run-1',kind:'choices',title:'请勾选需要的选项',description:'选择检查项',choices:[{id:'0',label:'☑ 检查 X'},{id:'1',label:'☐ 检查 Y'},{id:'2',label:'完成选择'},{id:'cancel',label:'取消问题',danger:true}]}];void 0;`);
  await evaluate(`auditPane.close();auditNode.tool='omp';auditPane=createSessionPane(auditMount,auditNode);void 0;`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(await evaluate(`document.querySelectorAll('.is-choice-list [data-decision]').length`), 4);
  // DOM 存在并不代表用户能看见或点击；核对位置与命中元素，再用真实鼠标事件提交。
  const ompButton = await evaluate(`(()=>{const b=document.querySelector('.is-choice-list [data-decision="1"]');b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();const c=auditMount.querySelector('[data-role="composer"]').getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,visible:r.width>0&&r.height>0&&r.top>=0&&r.bottom<c.top&&r.bottom<innerHeight,hit:b.contains(document.elementFromPoint(x,y))}})()`);
  assert.equal(ompButton.visible, true, JSON.stringify(ompButton));
  assert.equal(ompButton.hit, true, JSON.stringify(ompButton));
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  fs.writeFileSync(path.join(output, 'omp-choice-card.png'), (await win.webContents.capturePage()).toPNG());
  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(ompButton.x), y: Math.round(ompButton.y), button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(ompButton.x), y: Math.round(ompButton.y), button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await evaluate(`auditCalls.filter(c=>c.url.endsWith('/answer')).at(-1).body.decision`), '1');
  const errors = await evaluate(`auditErrors`);
  assert.deepEqual(errors, []);
  await evaluate(`auditPane.close()`);
  console.log(JSON.stringify({ passed: true, checks: ['option selection', 'poll preservation', 'reopen recovery', 'single answer', 'IME', 'duplicate Enter', 'draft preservation', 'narrow layout', 'session stream reconnect', 'approval reply', 'OMP checkbox steps', 'no browser errors'], output }));
  win.destroy(); server.close(); app.exit(0);
})().catch((error) => { console.error(error); win?.destroy(); server?.close(); app.exit(1); });
