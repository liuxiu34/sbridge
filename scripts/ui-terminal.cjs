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
const nodes = ['codex', 'claude', 'pi', 'omp'].map((tool, i) => ({ id: `n${i+1}`, tool, title: ['梳理项目与交互流程', '实现统一工作台', '检查输入与决策流程'][i], cwd: projects[0].cwd, file: `fixture-${tool}.jsonl`, sessionId: `session-${i}`, parentNodeId: i ? `n${i}` : null, edgeKind: i ? 'handoff' : null, createdAt: `2026-11-14T0${i+1}:00:00Z` }));
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
    socket.send(Array.from({length:80},(_,i)=>`HISTORY_${String(i).padStart(3,'0')}\r\n`+'\r\n'.repeat(5)).join('')+'READY> ');socket.send('\0REPLAY_DONE\0');
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
  await until(`document.querySelectorAll('.chat-msg').length>=3`);
  const results=[];
  const snapshot=()=>ev(`(()=>{const t=window.__sbLastMountTerm,b=t.buffer.active,h=document.querySelector('.pane-host.focused'),v=h.querySelector('.term-view'),r=v.getBoundingClientRect();return {cols:t.cols,rows:t.rows,type:b.type,base:b.baseY,viewport:b.viewportY,scrollback:t.options.scrollback,oldest:[...Array(b.length)].some((_,i)=>b.getLine(i)?.translateToString(true).includes('HISTORY_000')),top:b.getLine(b.viewportY)?.translateToString(true),backgrounds:document.elementsFromPoint(r.x+r.width/2,r.bottom-2).map(e=>({cls:e.className,bg:getComputedStyle(e).backgroundColor}))}})()`);
  for(const n of nodes) {
    await ev(`openSessionTab('${n.id}');void 0;`);
    await click('.pane-host.focused [data-pact="terminal"]');
    await until(`!document.querySelector('.pane-host.focused [data-role="termstart"]').hidden`);
    const start=Date.now();await click('.pane-host.focused [data-role="termstart"]');
    await until(`window.__sbLastMount.node==='${n.id}' && document.querySelector('.pane-host.focused .xterm-rows').textContent.includes('READY>')`);
    const readyMs=Date.now()-start;
    const initial=await snapshot();
    await ev(`document.querySelector('.pane-host.focused .term-view').dispatchEvent(new WheelEvent('wheel',{deltaY:-180,bubbles:true,cancelable:true}));`);
    const scroll=await snapshot();
    const resizeStart=terminalInputs.length;
    await ev(`for(let i=0;i<4;i++)window.dispatchEvent(new Event('resize'));`);
    await sleep(250);
    const redundantResizeCount=terminalInputs.slice(resizeStart).filter(x=>x.includes('"resize"')).length;
    win.setSize(1550,1080);await sleep(200);win.setSize(1100,760);await sleep(650);
    const resized=await snapshot();
    await sleep(5500);
    const settled=await snapshot();
    const shotImage=await win.webContents.capturePage();
    const bitmap=shotImage.toBitmap(),size=shotImage.getSize(),pixel=(Math.floor(size.height-3)*size.width+Math.floor(size.width*.7))*4;
    const bottomPixel=[bitmap[pixel+2],bitmap[pixel+1],bitmap[pixel]];
    fs.writeFileSync(path.join(output,n.tool+'-resize.png'),shotImage.toPNG());
    // 完整 DEC alternate-screen 生命周期；不应因工具名称改变原生屏幕语义。
    const socket=[...wss.clients].at(-1);
    socket.send('\x1b[?1049h\x1b[2J\x1b[HNative picker');await sleep(180);
    const alternate=await snapshot();
    socket.send('\x1b[?1049l');await sleep(180);
    const restored=await snapshot();
    results.push({tool:n.tool,readyMs,initial,scroll,redundantResizeCount,resized,settled,bottomPixel,alternate:alternate.type,restored:restored.oldest});
    await click('.pane-host.focused [data-pact="stream"]');
    win.setSize(1440,1000);await sleep(150);
  }
  const report={results,errors:await ev('qaErrors')};
  fs.writeFileSync(path.join(output,'terminal-resize.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  if(!process.env.SBRIDGE_QA_BASELINE) {
    for(const r of results) {
      assert.equal(r.redundantResizeCount,0,r.tool+' unchanged resize');
      assert.equal(r.settled.oldest,true,r.tool+' history lost');
      assert.equal(r.settled.top,r.resized.top,r.tool+' viewport moved while idle');
      assert.deepEqual(r.bottomPixel,[253,246,227],r.tool+' bottom background');
      assert.equal(r.alternate,'alternate',r.tool+' native alternate screen');
      assert.equal(r.restored,true,r.tool+' normal history restored');
    }
    assert.deepEqual(report.errors,[]);
  }
  await ev('closeAllPanes();void 0;');win.destroy();wss.clients.forEach(c=>c.terminate());wss.close();server.closeAllConnections();server.close();app.exit(0);
})().catch(error=>{console.error(error);win?.destroy();wss?.clients.forEach(c=>c.terminate());wss?.close();server?.closeAllConnections();server?.close();app.exit(1);});

