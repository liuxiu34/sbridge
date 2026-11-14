// 完整工作台验收：真实前端、独立 HTTP/SSE 数据和 Electron 鼠标，不接触用户会话。
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const output = process.env.SBRIDGE_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-workbench-'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-workbench-profile-')));
app.disableHardwareAcceleration();
const projects = [{ id: 'p1', name: 'sbridge', cwd: 'C:/fixture/sbridge' }, { id: 'p2', name: '工具实验室', cwd: 'C:/fixture/lab' }];
const nodes = ['codex', 'claude', 'pi'].map((tool, i) => ({ id: `n${i+1}`, tool, title: ['梳理项目与交互流程', '实现统一工作台', '检查输入与决策流程'][i], cwd: projects[0].cwd, file: `fixture-${tool}.jsonl`, sessionId: `session-${i}`, parentNodeId: i ? `n${i}` : null, edgeKind: i ? 'handoff' : null, createdAt: `2026-11-14T0${i+1}:00:00Z` }));
const task = { id: 't1', projectId: 'p1', project: projects[0], title: '工作台界面打磨', updatedAt: '2026-11-14T09:00:00Z', nodes };
nodes.forEach(n => { n.summary = { messageCount: 6 }; }); // 有历史的终端不能被自动切回轨迹。
const tasks = [{ ...task, nodes: undefined, nodeCount: 3 }, { id:'t2', projectId:'p2', title:'整理开发工具', nodeCount:0, updatedAt:'2026-11-13T09:00:00Z' }];
const history = [
  { kind:'user', text:'把工作轨迹和输入区域整理得更清晰，保留接力与原始终端。' },
  { kind:'assistant', text:'我会先检查页面结构，再统一工作区、输入框和决策卡片的布局。' },
  { kind:'tool_call', toolName:'read', callId:'c1', args:{path:'src/web/js/pane.js'} },
  { kind:'tool_result', callId:'c1', outcome:'已读取会话面板与输入区域。' },
  { kind:'tool_call', toolName:'bash', callId:'c2', args:{command:'npm test'} },
  { kind:'tool_result', callId:'c2', outcome:'30 tests passed. 0 failed.' },
  { kind:'assistant', text:'工作台已经整理好，当前改动包括：\n\n- 工作轨迹与终端有独立切换入口。\n- 提问、待发消息与输入框保持同宽。\n- 工具、模型和思考强度分别显示。\n\n输入草稿与会话历史会继续保留。' },
].map((e,i)=>({...e, ts: new Date(Date.UTC(2026,10,14,9,0,i)).toISOString()}));
let status = { status:{running:false,phase:'idle'}, queue:[], interactions:[] };
let currentModel = 'gpt-5.4', currentEffort = 'high';
let server, win, wss;
const calls = [], errors = [], checks = [];
let terms = [], terminalSeq = 0;
const terminalInputs = [];
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const model = () => ({ current: currentModel, options:[{id:'gpt-5.4',provider:'OpenAI'}, {id:'gpt-5.4-mini',provider:'OpenAI'}, {id:'claude-sonnet-4-6',provider:'Anthropic'}], effort:{supported:true,levels:[{id:'low',label:'低'},{id:'medium',label:'标准'},{id:'high',label:'高'},{id:'xhigh',label:'最高'}],defaultLevel:'medium'},effortCurrent:currentEffort });
function fixture(url, method, body) {
  const p = url.pathname;
  if (method === 'POST') {
    calls.push({p,body});
    if (p.endsWith('/model')) currentModel = body.model;
    if (p.endsWith('/effort')) currentEffort = body.level;
    if (p.endsWith('/answer')) status = {status:{running:false,phase:'idle'},queue:[],interactions:[]};
    if (p.endsWith('/term')) {
      const term = {id:`fixture-terminal-${++terminalSeq}`,nodeId:body.nodeId,tool:body.tool,running:true};
      terms.push(term); return {termId:term.id};
    }
    return {ok:true, applied:'config', effort:currentEffort};
  }
  if (p === '/api/state') return { projects, tasks };
  if (p === '/api/tools') return {tools:['codex','pi','claude','omp'].map(id=>({id,label:id,modes:[]}))};
  if (p === '/api/terms') return {terms};
  if (p === '/api/tasks/t1') return task;
  if (p.endsWith('/headless-status')) return status;
  if (p.endsWith('/model')) return model();
  if (p.endsWith('/subagents')) return {sessions:[],fix:{}};
  if (p.endsWith('/usage')) return {ctx:{used:18240,window:200000,source:'session',model:currentModel}};
  if (p.endsWith('/project-state')) return {project:{cwd:projects[0].cwd,branch:'ui/workbench',dirtyCount:1,isGit:true,dirty:[{path:'src/web/app.css',code:'M',added:24,deleted:12}],recentCommits:[]}};
  if (p.endsWith('/files')) {
    if(url.searchParams.has('read')) return {path:url.searchParams.get('path'),text:'# sbridge\n\n会话接力工作台。',size:42};
    return {dir:url.searchParams.get('path')||'',entries:[{name:'src',type:'dir'},{name:'README.md',type:'file',size:2301},{name:'package.json',type:'file',size:912}]};
  }
  if (p.endsWith('/changes')) return {isGit:true,branch:'ui/workbench',file:'src/web/app.css',files:[{path:'src/web/app.css',code:'M',label:'修改',added:24,deleted:12}],diff:'diff --git a/src/web/app.css b/src/web/app.css\n--- a/src/web/app.css\n+++ b/src/web/app.css\n@@ -1 +1 @@\n-.app { color: black; }\n+.app { color: var(--text); }\n'};
  if (p.endsWith('/context-files')) return {files:[]};
  if (p.endsWith('/worktrees')) return {worktrees:[]};
  if (p === '/api/search') return {results:[{kind:'node',tool:'pi',nodeId:'n3',taskId:'t1',title:nodes[2].title,taskTitle:task.title,where:'标题',updatedAt:task.updatedAt,snippet:'输入、决策与接力流程'}]};
  return {};
}
(async()=>{
  server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/stream') {
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      history.forEach(e=>res.write(`data: ${JSON.stringify(e)}\n\n`));
      return;
    }
    if(url.pathname.startsWith('/api/')) {
      let raw='';for await(const c of req)raw+=c;
      res.setHeader('content-type','application/json');
      return res.end(JSON.stringify(fixture(url,req.method,raw?JSON.parse(raw):{})));
    }
    const file=path.join(root,'src/web',url.pathname==='/'?'index.html':url.pathname);
    try {
      res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');
      let data=fs.readFileSync(file);
      if(url.pathname==='/') data=data.toString().replace('<body>','<body><script>localStorage.setItem("sbridge-settings",JSON.stringify({autoStartTerm:false,syncModel:true}));window.qaErrors=[];addEventListener("error",e=>qaErrors.push(e.message));addEventListener("unhandledrejection",e=>qaErrors.push(String(e.reason)));</script>');
      res.end(data);
    }catch{res.writeHead(404);res.end();}
  });
  wss=new WebSocketServer({server});
  wss.on('connection',socket=>{
    socket.on('message',data=>terminalInputs.push(data.toString()));
    socket.send('sbridge terminal fixture\r\n> ');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  await app.whenReady();
  win=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const ev=code=>win.webContents.executeJavaScript(code,true);
  const until=async(code)=>{for(let i=0;i<60;i++){if(await ev(code))return;await sleep(100);}throw new Error(`Timed out: ${code}`);};
  const click=async(selector)=>{
    const point=await ev(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b)return null;b.scrollIntoView({block:'nearest',inline:'nearest'});const r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y)),visible:r.width>0&&r.height>0&&x>=0&&y>=0&&x<innerWidth&&y<innerHeight};})()`);
    assert.ok(point?.hit&&point?.visible,`Click unreachable ${selector}: ${JSON.stringify(point)}`);
    win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
    await sleep(120);
  };
  const escape=async()=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await sleep(120);};
  const shot=async(name)=>{await sleep(180);await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  const layoutCheck=async()=>{
    const r=await ev(`(()=>{const host=document.querySelector('.pane-host:not([hidden])');const c=host.querySelector('.composer').getBoundingClientRect();const p=host.querySelector('.interaction-panel');const r=p.getBoundingClientRect();return {composer:c.top>0&&c.bottom<=innerHeight,width:c.width,overflow:document.documentElement.scrollWidth>innerWidth,question:p.hidden||(r.bottom<=c.top+1&&Math.abs(r.width-c.width)<2)}})()`);
    assert.ok(r.composer&&r.width>180&&!r.overflow&&r.question,JSON.stringify(r));
  };
  await until(`document.querySelectorAll('.chat-msg').length>=3`);
  await layoutCheck();await shot('workbench-light');checks.push('完整启动与历史轨迹');
  await click('.turn-process');
  await until(`document.querySelector('.chat-tool-row')?.getBoundingClientRect().height>0`);
  await click('.chat-tool-row');
  assert.ok(await ev(`document.querySelector('.cot-detail')?.getBoundingClientRect().height>0`));
  checks.push('过程折叠与工具详情');
  await click('[data-role="input"]');await win.webContents.insertText('保留这份工作轨迹草稿');
  await click('[data-pact="terminal"]');
  assert.equal(await ev(`document.querySelector('[data-pact="terminal"]').getAttribute('aria-pressed')`),'true');
  await until(`!document.querySelector('[data-role="termstart"]').hidden`);
  assert.equal(calls.filter(c=>c.p.endsWith('/term')).length,0,'自动启动关闭时不能偷偷启动');
  await click('[data-role="termstart"]');
  await until(`document.querySelector('.xterm-rows')?.textContent.includes('sbridge terminal fixture')`);
  assert.equal(await ev(`document.querySelector('[data-pact="terminal"]').getAttribute('aria-pressed')`),'true','历史会话启动后保持终端模式');
  const terminalLayout=await ev(`(()=>{const h=document.querySelector('.pane-host:not([hidden])'),p=h.querySelector('.session-pane').getBoundingClientRect(),t=h.querySelector('.term-view').getBoundingClientRect(),head=h.querySelector('.pane-head').getBoundingClientRect();return {composer:h.querySelector('.composer-zone').getClientRects().length,bottom:p.bottom-t.bottom,top:t.top-head.bottom,focus:document.activeElement.matches('.xterm-helper-textarea')}})()`);
  assert.deepEqual(terminalLayout,{composer:0,bottom:0,top:0,focus:true});
  await win.webContents.insertText('native-only');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
  await sleep(200);
  assert.ok(terminalInputs.join('').includes('native-only'));
  assert.ok(terminalInputs.includes('\r'));
  assert.equal(calls.filter(c=>c.p.endsWith('/send-headless')).length,0);
  await shot('terminal-native-only');checks.push('终端独占输入、填满空间、有历史也不自动返回轨迹');
  await click('[data-pact="stream"]');
  assert.equal(await ev(`document.querySelector('[data-role="input"]').value`),'保留这份工作轨迹草稿');
  assert.ok(await ev(`document.querySelector('.composer-zone').getClientRects().length>0`));
  await click('[data-pact="terminal"]');await sleep(200);
  assert.equal(terminalSeq,1,'切换模式复用活终端');
  // 模拟原生退出；保留退出现场，出现手动重启入口。
  terms[0].running=false;await ev('refreshTerms()');
  await until(`!document.querySelector('[data-role="termstart"]').hidden`);
  await click('[data-role="termstart"]');
  await until(`window.__sbLastMount.id==='fixture-terminal-2'`);
  assert.equal(await ev(`document.querySelectorAll('.xterm').length`),1);
  assert.equal(await ev(`document.querySelector('[data-pact="terminal"]').getAttribute('aria-pressed')`),'true');
  await click('[data-pact="stream"]');checks.push('草稿保留、活终端复用、退出后可重新启动');
  await click('.pane-menu summary');await click('[data-pact="ctx"]');
  await until(`!document.getElementById('modal').hidden`);
  await click('#btn-close-modal');checks.push('会话菜单及上下文入口');
  status={status:{running:true,phase:'waiting-input',runId:'fixture-run'},queue:[],interactions:[{id:'q1',runId:'fixture-run',kind:'questions',title:'需要你选择',questions:[{id:'choice',question:'下一步优先检查哪一部分？',allowCustom:true,options:[{label:'完整回归与打包',value:'verify',description:'检查交互、主题及安装版。'},{label:'继续调整界面',value:'polish',description:'保留当前进度，继续打磨细节。'}]}]}]};
  await until(`document.querySelectorAll('.interaction-option').length===2`);
  await layoutCheck();await shot('workbench-question');
  await click('.interaction-option input');await click('.interaction-footer .primary');
  assert.equal(calls.filter(c=>c.p.endsWith('/answer')).length,1);checks.push('完整页面决策卡片鼠标提交');
  await click('#btn-theme');await shot('workbench-dark');checks.push('浅色与深色完整工作台');
  win.setSize(1000,800);await sleep(200);await layoutCheck();await shot('workbench-compact');
  win.webContents.setZoomFactor(1.25);await sleep(250);await layoutCheck();await shot('workbench-125pct');
  assert.ok(await ev(`(()=>{const b=document.querySelector('.stream-bottom'),c=document.querySelector('.composer');return b.hidden||b.getBoundingClientRect().bottom<c.getBoundingClientRect().top})()`),'回到最新按钮不能遮挡输入');
  win.webContents.setZoomFactor(1);win.setSize(1440,1000);await sleep(200);checks.push('窄窗口与125%缩放');
  // U2：从用户可见入口进入侧栏、模型、设置、面板及白板。
  await click('[data-toggle-project="p2"]');
  assert.equal(await ev(`document.querySelector('[data-task="t2"]').getClientRects().length`),0);
  await ev('renderTree();void 0;');
  assert.equal(await ev(`document.querySelector('[data-toggle-project="p2"]').getAttribute('aria-expanded')`),'false');
  assert.ok(await ev(`document.querySelector('[data-task="t1"]').getClientRects().length>0`));checks.push('各项目独立折叠与重绘保留');
  await click('[data-role="model"]');
  await until(`document.querySelectorAll('.model-item').length===2`);
  await shot('model-menu');
  await click('.model-item:nth-child(2)');
  await until(`document.querySelector('[data-role="modelname"]').textContent==='gpt-5.4-mini'`);
  assert.equal(calls.filter(c=>c.p.endsWith('/model')).at(-1).body.provider,'OpenAI');
  await click('[data-role="effort"]');
  await until(`document.activeElement?.matches('.effort-range')`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'End'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'End'});
  await until(`document.querySelector('[data-role="effortname"]').textContent.includes('最高')`);
  await escape();assert.equal(await ev(`document.querySelectorAll('.model-pop').length`),0);
  checks.push('模型来源、模型切换与独立思考强度');
  await click('#btn-settings');await shot('settings');
  assert.ok(await ev(`document.getElementById('modal-body').scrollWidth<=document.getElementById('modal-body').clientWidth`),'设置内容不能横向溢出');
  await click('label:has(#set-syncmodel)');
  assert.equal(await ev(`document.getElementById('set-syncmodel').checked`),false);
  await click('#modal-submit');await click('#btn-settings');
  assert.equal(await ev(`document.getElementById('set-syncmodel').checked`),false);
  await escape();assert.equal(await ev(`document.getElementById('modal').hidden`),true);
  assert.equal(await ev(`document.activeElement.id`),'btn-settings');checks.push('设置保存、整行开关、Esc与焦点恢复');
  await click('[data-pact="handoff"]');await click('[data-to="claude"]');
  assert.equal(await ev(`document.querySelector('[data-to="claude"]').getAttribute('aria-pressed')`),'true');await shot('handoff');await escape();
  await click('#btn-launch');await until(`document.getElementById('ns-cwd')`);await shot('new-session');await escape();checks.push('接力选择与新会话入口');
  await click('#btn-search');
  await ev(`document.getElementById('search-q').value='立即关闭';document.getElementById('search-q').dispatchEvent(new Event('input',{bubbles:true}));`);await escape();await sleep(500);
  assert.deepEqual(await ev('qaErrors'),[]);checks.push('关闭搜索时取消旧视图更新');
  await click('#btn-search');
  await ev(`document.getElementById('search-q').value='输入';document.getElementById('search-q').dispatchEvent(new Event('input',{bubbles:true}));`);
  await until(`document.querySelectorAll('.search-row').length===1`);await shot('search');
  await click('.search-row');await until(`document.querySelectorAll('.chat-msg').length>=3`);checks.push('搜索结果打开原会话');
  await click('#btn-panel');await until(`document.querySelectorAll('[data-sp]').length===6`);await shot('panels');
  await click('[data-sp="files"]');await until(`document.querySelectorAll('[data-entry]').length===3`);
  await layoutCheck();await shot('workbench-files');
  await click('[data-entry="README.md"]');await until(`document.querySelector('.sp-code')?.textContent.includes('会话接力工作台')`);
  await click('[data-sp-back]');await until(`document.querySelectorAll('[data-entry]').length===3`);
  await click('#sp-add');await click('[data-sp="diff"]');await until(`document.querySelector('[data-file]')`);
  await click('[data-file]');await until(`document.querySelector('.d2h-wrapper')`);await shot('workbench-diff');
  await click('#sp-add');await click('[data-sp="context"]');
  await until(`document.querySelector('.sp-ctx-usage')`);assert.ok(await ev(`document.querySelector('.sp-ctx-usage b').textContent==='9%'`));
  await click('[data-ctx-tab="other"]');
  await click('.workspace-menu summary');await escape();
  assert.equal(await ev(`document.getElementById('side-panel').hidden`),false,'Esc只关闭顶层菜单');
  await click('#sp-close');checks.push('文件浏览、差异、上下文与面板切换');
  await click('#btn-board-view');await until(`!document.getElementById('board-wrap').hidden`);await shot('relay-board');
  assert.equal(await ev(`document.querySelectorAll('#cards .card').length`),3);
  await click('#btn-board-view');await click('[data-mnode="n1"]');await until(`activeTabId==='n1'`);
  await click('[data-mnode="n3"]');await until(`activeTabId==='n3'`);
  checks.push('接力来源、白板与会话切换');
  await click('.workspace-menu summary');await click('#btn-split');
  await until(`document.querySelectorAll('.pane-host:not([hidden])').length===2`);await shot('workbench-split');
  const inputs=await ev(`[...document.querySelectorAll('.pane-host:not([hidden]) .composer')].map(c=>({w:c.clientWidth,b:c.getBoundingClientRect().bottom}))`);
  assert.ok(inputs.every(c=>c.w>250&&c.b<1000));
  await click('.workspace-menu summary');await click('#btn-split');checks.push('分屏及独立输入区域');
  win.setSize(720,800);await sleep(200);await click('#btn-sidebar');
  assert.equal(await ev(`document.querySelector('.sidebar').getBoundingClientRect().width>0`),true);await shot('sidebar-compact');
  await click('[data-mnode="n3"]');assert.equal(await ev(`document.body.classList.contains('sidebar-open')`),false);
  await layoutCheck();await click('[data-pane-host="n3"] [data-role="model"]');
  await until(`document.querySelector('.model-pop')`);
  assert.ok(await ev(`(()=>{const p=document.querySelector('.model-pop').getBoundingClientRect();return p.top>=90&&p.bottom<innerHeight&&p.left>=0})()`));
  await shot('model-compact');await escape();checks.push('小窗口项目导航与模型弹层');
  win.setSize(1440,1000);await sleep(200);
  await ev(`theme.current='light';theme.apply();openSessionTab('n3');void 0;`);await shot('workbench-final-light');
  await ev(`theme.current='dark';theme.apply();void 0;`);await shot('workbench-final-dark');
  assert.deepEqual(await ev('qaErrors'),[]);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks,output}));
  await ev('closeAllPanes();void 0;');win.destroy();wss.clients.forEach(c=>c.terminate());wss.close();server.closeAllConnections();server.close();app.exit(0);
})().catch(error=>{console.error(error);win?.destroy();wss?.clients.forEach(c=>c.terminate());wss?.close();server?.closeAllConnections();server?.close();app.exit(1);});
