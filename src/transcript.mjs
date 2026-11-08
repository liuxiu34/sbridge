import fs from 'node:fs';
import { PARSERS } from './context/capture.mjs';

/**
 * 会话历史回放：把会话文件渲染成带 ANSI 颜色的文字记录，注入内嵌终端的回放缓冲。
 *
 * 背景：Pi 有 --tui-mode regular，resume 时 CLI 自己会把历史逐行打印；但 Claude Code
 * 和 Codex 的 TUI（实测 2.1.318 / 0.167.0）resume 后只渲染最后一屏，完整历史在 TUI
 * 内部视口里，没有任何 CLI 参数能把它吐进 PTY 流——终端视图因此是空的（内容在工作轨迹）。
 * 这里直接从会话文件生成记录，作为「显示层回放」写进终端 buffer（不喂给 PTY）。
 */

const MAX_TRANSCRIPT_CHARS = 120_000; // 回放整体上限（保留尾部，最近对话最重要）
const MAX_TEXT_CHARS = 1500;          // 单条消息截断
const MAX_ARGS_CHARS = 120;           // 工具调用参数摘要截断

function oneLine(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * @param {string} tool 工具 id（codex/pi/claude）
 * @param {string} file 会话文件路径（可含 ~）
 * @returns {string|null} ANSI 文字记录；无法解析或没有内容时返回 null
 */
export function renderTranscript(tool, file) {
  const parser = PARSERS[tool];
  if (!parser || !file || !fs.existsSync(file)) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }

  const evts = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { parser(JSON.parse(t), evts); } catch { /* 半行或未知格式，跳过 */ }
  }
  if (!evts.length) return null;

  // 组装每条记录（先不带颜色，便于按总量裁剪）
  const items = [];
  for (const e of evts) {
    if (e.kind === 'user' || e.kind === 'assistant') {
      const text = String(e.text || '').trim();
      if (!text) continue;
      items.push({ who: e.kind === 'user' ? '你' : 'AI', text });
    } else if (e.kind === 'tool_call') {
      items.push({ tool: e.toolName || 'tool', args: oneLine(typeof e.args === 'string' ? e.args : JSON.stringify(e.args ?? ''), MAX_ARGS_CHARS) });
    }
    // tool_result 不回放：太吵，工作轨迹里有完整折叠
  }
  if (!items.length) return null;

  const render = (it) => {
    if (it.who) {
      const label = it.who === '你' ? '\x1b[32m【你】\x1b[0m' : '\x1b[36m【AI】\x1b[0m';
      return `${label}${oneLine(it.text, MAX_TEXT_CHARS)}`;
    }
    return `\x1b[2m  ⚙ ${it.tool}(${it.args})\x1b[0m`;
  };

  // 超限时从记录边界裁掉更早内容（不能从字符中间切，会留半条消息）
  const SEP = '\r\n\r\n';
  const rendered = items.map(render);
  let total = 0;
  let start = 0; // 默认从头保留；超限时 start = 第一个保留的记录下标
  for (let i = rendered.length - 1; i >= 0; i--) {
    total += rendered[i].length + (i < rendered.length - 1 ? SEP.length : 0);
    if (total > MAX_TRANSCRIPT_CHARS && i < rendered.length - 1) {
      start = i + 1;
      break;
    }
  }
  const body = rendered.slice(start).join(SEP);
  const omitted = start > 0 ? `\x1b[2m…（更早的 ${start} 条记录已省略，完整对话见工作轨迹）\x1b[0m\r\n\r\n` : '';
  const header = '\x1b[2m──────────────────────────────────────────────────\x1b[0m\r\n'
    + '\x1b[1m📜 本会话历史回放\x1b[0m\x1b[2m（来自会话文件；接续对话请直接在下方输入）\x1b[0m\r\n'
    + '\x1b[2m──────────────────────────────────────────────────\x1b[0m\r\n\r\n';
  // 回放末尾必须垫「盲文空白行」（\u2800 BRAILLE PATTERN BLANK），不能删：Claude/Codex
  // TUI 启动时用 \x1b[H 绝对定位从缓冲区第 1 行重绘（alt-screen 已被前端拦截，输出落在
  // normal buffer），会把刚写入的回放文本原地擦掉（实测：无垫行时回放整体消失、只剩
  // 实况内容）。垫行把回放顶到 TUI 重绘区之上。曾试过去掉垫行改前端拦截清屏——失败，
  // 因为摧毁回放的不是 CSI J（J 只擦可视区不碰滚回区），而是 [H 绝对定位重绘，无法拦截。
  // 用 \u2800 而不是普通空白：xterm translateToString(true) 会把纯空白行 trim 掉，
  // trimBlank 的「非空行计数」就轮到回放本体被裁（实测如此）；\u2800 非空白但渲染不可见。
  // 高度需 ≥ 终端可视行数（app.js 收缩后的 realRows，最高约 80），取 90 留余量；
  // 代价是「历史回放结束」分隔线下方有约 90 行不可见空白（滚动条可见），暂可接受。
  const pad = '\u2800\r\n'.repeat(90);
  return `${header}${omitted}${body}\r\n\r\n\x1b[2m──────── 历史回放结束，以下是本次进程的实际输出 ────────\x1b[0m\r\n${pad}`;
}
