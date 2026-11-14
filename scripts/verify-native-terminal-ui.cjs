// 四家真实 CLI + 真实 HTTP/PTY + Electron 窗口；隔离配置、假凭证，不发送模型请求。
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn,execFile}=require('node:child_process');
const root=path.resolve(__dirname,'..'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'sbridge-native-ui-'));
const data=path.join(folder,'data'),cwd=path.join(folder,'workspace'),profile=path.join(folder,'pi-profile');
const output=process.env.SBRIDGE_QA_OUTPUT||folder;
for(const dir of [data,cwd,profile,output])fs.mkdirSync(dir,{recursive:true});
const tools=['codex','claude','pi','omp'];
const model={baseUrl:'http://127.0.0.1:1/v1',api:'openai-completions',apiKey:'offline-test-placeholder',models:[{id:'fixture',name:'Fixture',reasoning:false,contextWindow:128000,maxTokens:8192}]};
fs.writeFileSync(path.join(profile,'models.json'),JSON.stringify({providers:{qa:model}}));
fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({defaultProvider:'qa',defaultModel:'fixture'}));
fs.writeFileSync(path.join(profile,'models.yml'),JSON.stringify({providers:{qa:model}}));
fs.writeFileSync(path.join(profile,'config.yml'),'');
const codexHome=path.join(folder,'codex');fs.mkdirSync(codexHome);
fs.writeFileSync(path.join(codexHome,'config.toml'),'model = "gpt-5.4"\nmodel_provider = "qa"\n[model_providers.qa]\nname = "Local QA"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nenv_key = "SBRIDGE_QA_KEY"\n');
fs.writeFileSync(path.join(data,'board.json'),JSON.stringify({projects:[{id:'p',name:'Terminal QA',cwd}],tasks:[{id:'qa',projectId:'p',title:'原生终端缩放验收',nodes:tools.map(tool=>({id:tool,tool,title:tool,cwd,file:'',...(tool==='pi'?{model:'fixture',modelProvider:'qa'}:tool==='omp'?{model:'qa/fixture'}:{})}))}]}));
app.setPath('userData',path.join(folder,'electron-profile'));app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{}); // 清理后台服务完成后再由 finish 退出。
const env={...process.env,SBRIDGE_DATA:data,SBRIDGE_TEST_MODE:'1',SBRIDGE_NO_REUSE:'1',SBRIDGE_NO_BROWSER:'1',PI_CODING_AGENT_DIR:profile,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:path.join(folder,'claude'),ANTHROPIC_API_KEY:'offline-test-placeholder',ANTHROPIC_BASE_URL:'http://127.0.0.1:1',SBRIDGE_QA_KEY:'offline-test-placeholder'};
const binary=process.env.SBRIDGE_QA_BINARY;
const child=spawn(binary||'node',[...(binary?[]:['src/server.mjs']),'--port=49330'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let base='',logs='',win;
child.stdout.on('data',d=>{logs+=d;const m=logs.match(/SBRIDGE_PORT=(\d+)/);if(m)base='http://127.0.0.1:'+m[1];});
child.stderr.on('data',d=>logs+=d);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(get,predicate,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const v=await get();if(predicate(v))return v;await sleep(100);}throw Error('native terminal UI timeout');}
async function finish(code){
  win?.destroy();fs.writeFileSync(path.join(output,'native-server.log'),logs);
  if(base)await fetch(base+'/api/shutdown',{method:'POST'}).catch(()=>{});
  await new Promise(r=>execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},r));
  // Codex 的隔离 app-server daemon 可脱离父进程树；只清理本次临时配置目录中的程序。
  await new Promise(r=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    "$qaPrefix = $env:SBRIDGE_QA_FIXTURE_DIR + '\\'; Get-CimInstance Win32_Process -Filter \"Name = 'codex.exe'\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($qaPrefix, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }"
  ],{windowsHide:true,env:{...process.env,SBRIDGE_QA_FIXTURE_DIR:codexHome}},r));
  app.exit(code);
}
(async()=>{
  await until(()=>base,Boolean);await app.whenReady();
  win=new BrowserWindow({width:1440,height:960,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadURL(base);
  const ev=s=>win.webContents.executeJavaScript(s,true);
  await until(()=>ev(`typeof openTask==='function' && currentTask?.id==='qa' && document.querySelector('.pane-host.focused')!==null`),Boolean);
  await ev(`userSettings.autoStartTerm=false;userSettings.syncModel=false;window.nativeErrors=[];addEventListener('error',e=>nativeErrors.push(e.message));void 0;`);
  const results=[];
  for(const tool of tools){
    await ev(`openSessionTab('${tool}');void 0;`);
    await ev(`document.querySelector('.pane-host.focused [data-pact="terminal"]').click();void 0;`);
    await until(()=>ev(`!document.querySelector('.pane-host.focused [data-role="termstart"]').hidden`),Boolean);
    const began=Date.now();
    await ev(`document.querySelector('.pane-host.focused [data-role="termstart"]').click();void 0;`);
    await until(()=>ev(`window.__sbLastMount?.node==='${tool}'&&document.querySelector('.pane-host.focused .xterm-rows')?.textContent.trim().length>30`),Boolean);
    const firstContentMs=Date.now()-began;
    await sleep(1500);
    const timing=await ev('({...window.__sbLastMount})');
    const before=await ev(`({cols:__sbLastMountTerm.cols,rows:__sbLastMountTerm.rows})`);
    win.maximize();await sleep(350);
    const maximized=await ev(`({cols:__sbLastMountTerm.cols,rows:__sbLastMountTerm.rows})`);
    win.unmaximize();win.setSize(1100,760);await sleep(650);
    const restored=await ev(`({cols:__sbLastMountTerm.cols,rows:__sbLastMountTerm.rows,visible:document.querySelector('.pane-host.focused .xterm-rows').textContent.trim().length>0})`);
    const terms=await(await fetch(base+'/api/terms')).json();
    assert.equal(terms.terms.find(t=>t.id===timing.id)?.running,true,tool+' CLI exited');
    assert.ok(restored.visible,tool+' blank after resize');
    assert.ok(restored.cols!==before.cols||restored.rows!==before.rows,tool+' terminal size unchanged');
    fs.writeFileSync(path.join(output,tool+'-native.png'),(await win.webContents.capturePage()).toPNG());
    results.push({tool,firstContentMs,timing,before,maximized,restored});
    await ev(`document.querySelector('.pane-host.focused [data-pact="stream"]').click();void 0;`);
    await fetch(base+'/api/terms/kill',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:timing.id})});
    win.setSize(1440,960);await sleep(200);
  }
  assert.deepEqual(await ev('nativeErrors'),[]);
  const report={passed:true,folder,binary:binary||'source',results,modelRequests:0};
  fs.writeFileSync(path.join(output,'native-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  await finish(0);
})().catch(async e=>{
  console.error(e);
  if(win&&!win.isDestroyed()) {
    fs.writeFileSync(path.join(output,'failed.png'),(await win.webContents.capturePage()).toPNG());
    const detail=await win.webContents.executeJavaScript(`JSON.stringify({task:currentTask?.id,active:activeTabId,settings:userSettings,errors:window.nativeErrors,text:document.body.innerText.slice(-2000)})`).catch(()=>null);
    fs.writeFileSync(path.join(output,'failed.json'),detail||'{}');
  }
  await finish(1);
});
