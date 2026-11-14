import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** npm 的 Windows shim 转为它指向的程序，以参数数组启动，避免模型名经过 shell 展开。 */
export function cliCommand(tool, args) {
  if (process.platform !== 'win32') return { command: tool, args };
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  const find = (name) => dirs.map((d) => path.join(d.replace(/^"|"$/g, ''), name)).find((f) => fs.existsSync(f));
  const command = dirs.flatMap((d) => ['.exe', '.cmd', '.bat'].map((ext) => path.join(d.replace(/^"|"$/g, ''), tool + ext)))
    .find((f) => fs.existsSync(f));
  if (!command) throw new Error(`未找到 ${tool}，请先安装并加入 PATH`);
  if (/\.exe$/i.test(command)) return { command, args };
  const shim = fs.readFileSync(command, 'utf8');
  const target = [...shim.matchAll(/"%dp0%[\\/]([^"\r\n]+?\.(?:[cm]?js|exe))"/gi)]
    .map((m) => m[1]).find((s) => s.toLowerCase() !== 'node.exe');
  if (!target) throw new Error(`${tool} 启动脚本格式不受支持，请使用官方 CLI 启动器`);
  const script = path.resolve(path.dirname(command), target);
  if (/\.exe$/i.test(script)) return { command: script, args };
  const node = find('node.exe');
  if (!node) throw new Error('未找到 Node.js，无法启动该 CLI');
  return { command: node, args: [script, ...args] };
}

export class CliProcess {
  constructor(tool, args, { cwd, onRecord, onExit, env = {}, spawnProcess = spawn }) {
    this.closed = false;
    this.stopping = null;
    this.tail = '';
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    const cli = cliCommand(tool, args);
    this.proc = spawnProcess(cli.command, cli.args, {
      cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32',
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += this.decoder.write(chunk);
      if (this.buffer.length > 16_000_000) {
        onExit({ exitCode: -1, stderrTail: 'CLI 输出记录超过大小限制' }); return;
      }
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        try { onRecord(record); } catch (error) { onExit({ exitCode: -1, stderrTail: error.message }); }
      }
    });
    this.proc.stderr.on('data', (chunk) => { this.tail = (this.tail + chunk.toString('utf8')).slice(-1600); });
    this.proc.stdin.on('error', (error) => { if (!this.stopping) onExit({ exitCode: -1, stderrTail: error.message }); });
    this.done = new Promise((resolve) => {
      this.proc.once('error', (error) => {
        this.closed = true; resolve(); onExit({ exitCode: -1, stderrTail: error.message });
      });
      this.proc.once('close', (code) => {
        this.closed = true; resolve();
        onExit({ exitCode: code ?? -1, stderrTail: this.tail });
      });
    });
  }
  write(record) {
    if (this.closed || this.stopping || this.proc.stdin.destroyed) return Promise.reject(new Error('CLI 连接已关闭'));
    return new Promise((resolve, reject) => this.proc.stdin.write(
      (typeof record === 'string' ? record : JSON.stringify(record)) + '\n', 'utf8',
      (error) => error ? reject(error) : resolve(),
    ));
  }
  end() { this.proc.stdin.end(); }
  stop() {
    if (this.closed) return Promise.resolve();
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (process.platform === 'win32') {
        await new Promise((resolve) => execFile('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
      } else {
        try { process.kill(-this.proc.pid, 'SIGKILL'); } catch { try { this.proc.kill('SIGKILL'); } catch {} }
      }
      let timer;
      try {
        await Promise.race([this.done, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('CLI 未在 5 秒内退出')), 5000);
        })]);
      } finally { clearTimeout(timer); }
    })();
    return this.stopping;
  }
}
