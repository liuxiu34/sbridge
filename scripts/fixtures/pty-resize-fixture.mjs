// 专用本地进程产生长历史；不启动模型工具，不读取用户会话。供 HTTP 和 Electron 回归共用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function startPtyResizeFixture(output) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-pty-resize-'));
  const data = path.join(folder, 'data'), cwd = path.join(folder, 'workspace');
  for (const dir of [data, cwd]) fs.mkdirSync(dir);
  const fixture = path.join(cwd, 'history.cjs');
  // 分批写入避免单个进程启动输出被 ConPTY 合并为一屏；最后光标位于末行。
  fs.writeFileSync(fixture, `
const fs = require('node:fs');
if (!process.stdout.isTTY) throw Error('Expected a real PTY');
let line = 0;
const timer = setInterval(() => {
  for (let i = 0; i < 6 && line < 240; i++, line++) {
    // 每隔 10 行插入一条超过终端宽度的长行，验证宽度变化时 xterm 软换行 reflow 的场景。
    const text = (line > 0 && line % 10 === 0) ? 'LONG_' + 'x'.repeat(300) + '_' + line : 'HISTORY_' + String(line).padStart(3, '0');
    process.stdout.write(text + '\\r\\n');
  }
  if (line === 240) { clearInterval(timer); process.stdout.write('READY>'); }
}, 15);
process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', data => {
  fs.appendFileSync('inputs.bin', data);
  if (data.includes(2)) process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HNative picker');
  else if (data.includes(4)) process.stdout.write('\\x1b[?1049l');
});
`);
  const command = `node "${fixture}"`;
  const nodes = ['pi', 'codex', 'claude', 'omp'].flatMap(tool => ['create', 'list', 'reuse'].map(route => ({
    id: `${tool}-${route}-height`, tool, cwd, file: '', title: tool, resumeCommand: command,
  })));
  nodes.push({ id: 'legacy-create-height', tool: 'codex', cwd, file: '', resumeCommand: command });
  fs.writeFileSync(path.join(data, 'board.json'), JSON.stringify({ projects: [], tasks: [{ id: 'fixture', title: 'PTY resize fixture', nodes }] }));
  let logs = '', base = '', failure;
  const binary = process.env.SBRIDGE_QA_BINARY;
  const child = spawn(binary || (process.versions.electron ? 'node' : process.execPath), [...(binary ? [] : ['src/server.mjs']), '--port=0'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SBRIDGE_DATA: data, SBRIDGE_TEST_MODE: '1', SBRIDGE_NO_REUSE: '1', SBRIDGE_NO_BROWSER: '1',
      PI_CODING_AGENT_DIR: path.join(folder, 'pi'), CODEX_HOME: path.join(folder, 'codex'), CLAUDE_CONFIG_DIR: path.join(folder, 'claude') },
  });
  child.on('error', error => { failure = error; logs += error.stack + '\n'; });
  child.stdout.on('data', chunk => { logs += chunk; const match = logs.match(/SBRIDGE_PORT=(\d+)/); if (match) base = `http://127.0.0.1:${match[1]}`; });
  child.stderr.on('data', chunk => { logs += chunk; });
  async function close() {
    if (base) await fetch(base + '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, resolve));
      else child.kill();
    }
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'pty-fixture-server.log'), logs);
    }
  }
  try {
    const end = Date.now() + 15000;
    while (!base) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw Error(`Fixture server exited ${child.exitCode}: ${logs}`);
      if (Date.now() > end) throw Error('Fixture server startup timeout: ' + logs);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return { root, folder, cwd, command, nodes, base, close };
  } catch (error) { await close(); throw error; }
}
