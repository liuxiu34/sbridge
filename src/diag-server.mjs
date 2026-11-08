import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getAsset, isSea } from 'node:sea';

/** sbridge 终端滚动诊断台 · 独立 exe
 *  内嵌全部页面资产（含 TUI 回放样本），零外部依赖。
 *  启动后自动用 Edge app 模式开独立窗口；窗口关闭（页面卸载探活失败）即自动退出。
 */

const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] || 0) || 4390;
const SEA = isSea();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// 资产表：SEA 模式从内嵌资产读；源码模式直接读文件（开发用）
const ASSETS = {
  'diag.html': 'web/diag.html',
  'vendor/xterm.js': 'web/vendor/xterm.js',
  'vendor/xterm.css': 'web/vendor/xterm.css',
  'diag-sample.txt': 'asset-sample',
};

let sampleText = '';
function getAssetText(key) {
  if (key === 'asset-sample') return sampleText;
  if (SEA) return Buffer.from(getAsset(key)).toString('utf8');
  const file = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src', 'web', key);
  return fs.readFileSync(file, 'utf8');
}

const server = http.createServer((req, res) => {
  const name = req.url.replace(/^\/+/, '').split('?')[0] || 'diag.html';
  const key = ASSETS[name];
  if (!key) { res.writeHead(404); return res.end('not found'); }
  try {
    const body = getAssetText(key);
    res.writeHead(200, { 'content-type': MIME[path.extname(name)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch (err) {
    res.writeHead(500); res.end(err.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/diag.html`;
  console.log(`sbridge 诊断台: ${url}`);
  // 样本：SEA 模式从内嵌资产读；源码模式从 data/tui-sample.txt 读
  try {
    sampleText = SEA
      ? Buffer.from(getAsset('web/diag-sample.txt')).toString('utf8')
      : fs.readFileSync(path.join(process.cwd(), 'data', 'tui-sample.txt'), 'utf8');
  } catch { sampleText = 'sample unavailable\r\n'; }

  // 自动开独立窗口：优先 Edge app 模式，退化到默认浏览器
  const edgeCandidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ];
  const edge = edgeCandidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (edge) {
    spawn(edge, [`--app=${url}`, '--window-size=1400,860'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }

  // 探活：每 3 秒开一个临时 ws/http 连接检测窗口是否还开着——用简单办法：
  // 轮询「 Edge app 进程是否还有我们的 --app= 参数」不可靠；改为页面心跳：
  // diag.html 每 2 秒 fetch /ping，若 15 秒无心跳则退出
  let lastPing = Date.now();
  setInterval(() => {
    if (Date.now() - lastPing > 15000) {
      console.log('窗口已关闭，诊断台退出。');
      process.exit(0);
    }
  }, 3000);
  server.on('request', (req) => { if (req.url === '/ping') lastPing = Date.now(); });
});
