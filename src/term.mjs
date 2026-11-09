import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './paths.mjs';

/**
 * 内嵌终端：PTY 注册表。
 * agent 进程挂在 sbridge 服务上（不是浏览器上），关页面、断开重连都不中断；
 * 每个终端保留最近一段输出，重连时先回放再续流。
 */

// node-pty 是原生模块，不能打进 SEA 包：开发模式从 sbridge/node_modules 找，
// exe 模式从 exe 旁边的 node_modules 找。
const nodeRequire = createRequire(path.join(ROOT, 'node_modules', '_load_.js'));
let pty = null;
let wsLib = null;
export function getPty() {
  if (!pty) pty = nodeRequire('node-pty');
  return pty;
}
export function getWs() {
  if (!wsLib) wsLib = nodeRequire('ws');
  return wsLib;
}

const terms = new Map(); // termId -> { id, tool, cwd, pty, buffer: string[], clients: Set<ws>, exitCode, createdAt, label }
const BUFFER_MAX_CHARS = 200_000;
let seq = 0;

export function listTerms() {
  return [...terms.values()].map((t) => ({
    id: t.id,
    tool: t.tool,
    cwd: t.cwd,
    label: t.label,
    nodeId: t.nodeId || null,
    createdAt: t.createdAt,
    running: !t.exitCode,
    exitCode: t.exitCode,
  }));
}

export function getTerm(id) {
  return terms.get(id) || null;
}

/** 分支/新会话检测到节点后，把 PTY 归属补绑到该节点（前端才能按节点找到它） */
export function setTermNode(id, nodeId) {
  const t = terms.get(id);
  if (t) t.nodeId = nodeId || null;
}

/** 某会话节点终端最近输出的原文（含控制序列，调用方自行清洗）：
 *  用于读取 CLI 自己打印的状态栏（如 pi 的上下文百分比），比在应用里估算准。 */
export function tailTextForNode(nodeId, maxChars = 16000) {
  if (!nodeId) return '';
  let best = null;
  for (const t of terms.values()) {
    if (t.nodeId !== nodeId) continue;
    if (!best || (t.createdAt || '') > (best.createdAt || '')) best = t;
  }
  if (!best) return '';
  return best.buffer.join('').slice(-maxChars);
}

/** 启动一个内嵌终端；command 为完整命令行（如 `claude --resume <id>` 或 `codex`）
 *  replay 为显示层历史回放（transcript.mjs 生成）：只写进回放缓冲给浏览器看，不喂 PTY */
export function spawnTerm({ tool, cwd, command, label, replay, nodeId }) {
  const { spawn: ptySpawn } = getPty();
  const id = `t${Date.now().toString(36)}${(++seq).toString(36)}`;
  // Windows 用 cmd/ConPTY；Linux/macOS 用用户 shell（bash/zsh）
  const isWin = process.platform === 'win32';
  const shell = isWin ? (process.env.COMSPEC || 'powershell.exe') : (process.env.SHELL || '/bin/bash');
  // Pi 的全屏 TUI 模式（默认）在 resume 时不回放历史对话，屏幕上只有启动横幅；
  // regular 行式模式会把历史对话逐行打印出来（实测 195KB 历史正常显示）。
  // 给 pi 的启动命令统一补上 --tui-mode regular（已有该参数则不重复）。
  let cmd = command;
  if (tool === 'pi' && /^pi\b/.test(cmd) && !cmd.includes('--tui-mode')) {
    cmd = cmd.replace(/^pi\b/, 'pi --tui-mode regular');
  }
  // 用 cmd.exe /c（Windows）或 shell -c（POSIX）承接完整命令行，保留交互 TUI 能力
  const shellArgs = isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
  const p = ptySpawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    // WorkBuddy / Git Bash 常把 TERM 设为 dumb，Codex 会直接拒绝启动交互 TUI。
    // 这里显式覆盖为 PTY 实际模拟的终端类型，Pi/Claude 也能拿到一致的颜色能力。
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  const term = {
    id, tool, cwd, label: label || command,
    // 归属的会话节点：同一目录同工具的多个会话必须各自挂各自的 PTY，
    // 否则切终端时会把 A 的进程显示到 B 的面板里（用户看到的「四个会话终端内容一样」）
    nodeId: nodeId || null,
    pty: p,
    buffer: replay ? [replay] : [], // 预置历史回放：attachTerm 回放时会一并发出并带 REPLAY_DONE 哨兵
    clients: new Set(),
    exitCode: null,
    createdAt: new Date().toISOString(),
  };
  terms.set(id, term);

  p.onData((data) => {
    term.buffer.push(data);
    if (term.buffer.join('').length > BUFFER_MAX_CHARS) {
      // 合并裁剪，避免 buffer 数组无限增长
      term.buffer = [term.buffer.join('').slice(-BUFFER_MAX_CHARS / 2)];
    }
    for (const ws of term.clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  });
  p.onExit(({ exitCode }) => {
    term.exitCode = exitCode ?? 0;
    const msg = `\r\n\x1b[2m[进程已退出，代码 ${term.exitCode}]\x1b[0m\r\n`;
    for (const ws of term.clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
    term.buffer.push(msg);
  });
  return term;
}

/** 浏览器接入：回放历史，然后续流；返回 term 便于上层处理 */
export function attachTerm(id, ws) {
  const term = terms.get(id);
  if (!term) return null;
  term.clients.add(ws);
  if (term.buffer.length) {
    ws.send(term.buffer.join(''));
  }
  // 回放结束标记：无论 buffer 是否为空都发。前端回放状态机靠它收缩到真实行数，
  // 不发的话空回放（刚 spawn CLI 还没输出/记录失效）会让客户端一直停在回放相位
  //（仅 1.2s 兜底），配合「CLI 迟迟不打印」就表现为终端一片空白。
  ws.send('\u0000REPLAY_DONE\u0000');
  ws.on('message', (raw) => {
    // 浏览器发来的都是输入（或 JSON 指令 {resize:{cols,rows}}）
    const text = raw.toString();
    if (text.startsWith('{') && text.includes('"resize"')) {
      try {
        const { resize } = JSON.parse(text);
        if (resize?.cols && resize?.rows) term.pty.resize(resize.cols, resize.rows);
      } catch { /* 非 JSON 输入，当普通键入 */ }
      return;
    }
    term.pty.write(text);
  });
  ws.on('close', () => term.clients.delete(ws));
  return term;
}

/** 清理已退出的终端记录（保留 1 小时后可清，避免无限累积） */
export function pruneTerms(maxIdleMs = 3600_000) {
  const now = Date.now();
  for (const [id, t] of terms) {
    if (t.exitCode !== null && now - new Date(t.createdAt).getTime() > maxIdleMs) terms.delete(id);
  }
}

/** 一键关闭终端：tool 为空时关掉全部，否则只关该工具下所有运行中的终端 */
export function killAll(tool = null) {
  let killed = 0;
  for (const [id, t] of terms) {
    if (t.exitCode !== null) continue;
    if (tool && t.tool !== tool) continue;
    if (killTerm(id)) killed += 1;
  }
  return killed;
}

export function killTerm(id) {
  const t = terms.get(id);
  if (t && t.exitCode === null) {
    // PTY 是 shell 包裹启动的：pty.kill() 在 Windows 只杀 cmd 壳，pi/codex 孙进程会变孤儿。
    // Windows 用 taskkill /T 杀整棵树；POSIX 用负 PID 杀整个进程组（forkpty 的子进程是会话首进程）。
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${t.pty.pid} /T /F`, { stdio: 'ignore' });
      else process.kill(-t.pty.pid, 'SIGKILL');
    } catch {
      try { t.pty.kill(); } catch { /* 已退出 */ }
    }
    return true;
  }
  return false;
}
