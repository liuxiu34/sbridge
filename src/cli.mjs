#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { expandPath, estimateTokens } from './util.mjs';
import { applyBudget, summarize, messageBody, changedFiles } from './model.mjs';
import * as codex from './codex.mjs';
import * as pi from './pi.mjs';

const TOOLS = { codex, pi };
const DEFAULT_CONTEXT = 200000;

const HELP = `sbridge - 在不同编程工具之间搬运会话

用法:
  sbridge list    --tool <codex|pi> [--cwd <目录>] [--limit <n>]
  sbridge show    --tool <codex|pi> [--session <id|文件>] [--cwd <目录>] [--budget <0-1>] [--context-window <tokens>]
  sbridge convert --from <codex|pi> --to <codex|pi> [--session <id|文件>] [--cwd <目录>]
                  [--budget <0-1>] [--context-window <tokens>] [--model <provider/model>] [--dry-run]

说明:
  --session 省略时自动选取该目录下最近的一次会话
  --budget  导入内容最多占用目标上下文的比例，默认 0.3
  --dry-run 只预览，不写入
  --model   写 pi 会话时指定落地的 provider/model，默认沿用最近一次 pi 会话的模型

示例:
  sbridge list --tool codex --cwd .
  sbridge convert --from codex --to pi --session 01a1822e --dry-run
  sbridge convert --from pi --to codex --session 01a19cbd
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { opts[key] = next; i++; }
      else opts[key] = true;
      continue;
    }
    opts._.push(a);
  }
  return opts;
}

function fail(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

function pickTool(value) {
  const t = TOOLS[value];
  if (!t) fail(`未知工具 "${value}"，可选: ${Object.keys(TOOLS).join(', ')}`);
  return t;
}

/** 依据 id 前缀、完整 id 或文件路径定位会话 */
function resolveSession(tool, { session, cwd }) {
  const cwdResolved = expandPath(cwd || process.cwd());
  if (session) {
    if (fs.existsSync(session)) return { file: expandPath(session) };
    const items = tool.list({ cwd: null, limit: 200 });
    const hit = items.find((it) => it.id === session) || items.find((it) => it.id && it.id.startsWith(session));
    if (!hit) fail(`在 ${tool.name} 中找不到会话 "${session}"`);
    return hit;
  }
  const items = tool.list({ cwd: cwdResolved, limit: 5 });
  if (!items.length) fail(`${tool.name} 中该目录下没有会话: ${cwdResolved}`);
  return items[0];
}

function shortPath(p, max = 96) {
  if (!p) return '';
  return p.length <= max ? p : `${p.slice(0, 20)}…${p.slice(-(max - 21))}`;
}

function printPreview({ conv, summary, budgetInfo, target, cwd, writeResult, dryRun }) {
  console.log('');
  console.log(`源会话   ${conv.sourceTool}  ${conv.id}`);
  console.log(`源文件   ${shortPath(conv.sourceFile)}`);
  console.log(`工作目录 ${conv.cwd || '(未知)'}`);
  console.log(`消息量   ${summary.messageCount} 条（用户 ${summary.turnCount} / 助手 ${summary.assistantCount}），约 ${summary.tokens} tokens`);
  if (summary.firstUser) console.log(`首个提问 ${summary.firstUser}`);
  if (summary.lastUser) console.log(`最近提问 ${summary.lastUser}`);
  if (summary.lastAssistant) console.log(`最近回答 ${summary.lastAssistant}`);
  if (summary.files.length) {
    const shown = summary.files.slice(0, 5).join(', ');
    console.log(`涉及文件 ${summary.files.length} 个: ${shown}${summary.files.length > 5 ? ' …' : ''}`);
  }
  console.log('');
  console.log(`目标工具 ${target}`);
  console.log(`目标目录 ${cwd}`);
  console.log(`上下文预算 ${budgetInfo.maxTokens} tokens（${budgetInfo.ratio} × ${budgetInfo.contextWindow}）`);
  if (budgetInfo.droppedCount) {
    console.log(`预算裁剪 丢弃 ${budgetInfo.droppedCount} 条较早消息（约 ${budgetInfo.droppedTokens} tokens），保留 ${budgetInfo.keptCount} 条`);
  } else {
    console.log(`预算裁剪 无需裁剪，全部 ${budgetInfo.keptCount} 条保留`);
  }
  console.log('');
  if (dryRun) {
    console.log('（预览模式，未写入任何文件）');
  } else {
    console.log(`已写入   ${writeResult.file}`);
    console.log(`恢复命令 ${writeResult.resumeCommand}`);
    if (writeResult.registration) {
      const r = writeResult.registration;
      console.log(r.registered
        ? '图形界面 已写入 Codex 桌面会话索引，打开/刷新会话列表即可看到'
        : `图形界面 未写入索引（${r.reason}），需在终端执行一次恢复命令后才会出现在列表`);
    }
  }
  console.log('');
}

function cmdList(opts) {
  const tool = pickTool(opts.tool || 'codex');
  const items = tool.list({ cwd: opts.cwd, limit: Number(opts.limit || 15) });
  if (!items.length) {
    console.log(`${tool.name}: 没有找到会话`);
    return;
  }
  console.log(`${tool.name} 会话（${items.length} 条，按更新时间倒序）:`);
  for (const it of items) {
    const when = new Date(it.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
    const kb = Math.round(it.size / 1024);
    console.log(`  ${String(it.id).slice(0, 18).padEnd(20)} ${when}  ${String(kb).padStart(6)}KB  ${it.cwd || ''}`);
  }
}

function buildBudget(opts, messages) {
  const ratio = Number(opts.budget || 0.3);
  const contextWindow = Number(opts['context-window'] || DEFAULT_CONTEXT);
  const maxTokens = Math.floor(contextWindow * ratio);
  const result = applyBudget(messages, { maxTokens });
  return {
    messages: result.messages,
    keptCount: result.messages.length,
    droppedCount: result.droppedCount,
    droppedTokens: result.droppedTokens,
    maxTokens,
    ratio,
    contextWindow,
  };
}

function cmdShow(opts) {
  const tool = pickTool(opts.tool || 'codex');
  const found = resolveSession(tool, opts);
  const conv = tool.read(found.file);
  const summary = summarize(conv);
  const budget = buildBudget(opts, conv.messages);
  printPreview({
    conv,
    summary,
    budgetInfo: budget,
    target: '(仅预览)',
    cwd: conv.cwd,
    writeResult: null,
    dryRun: true,
  });
}

function cmdConvert(opts) {
  if (!opts.from || !opts.to) fail('convert 需要 --from 与 --to');
  const from = pickTool(opts.from);
  const to = pickTool(opts.to);
  const found = resolveSession(from, opts);
  const conv = from.read(found.file);
  const summary = summarize(conv);
  const budget = buildBudget(opts, conv.messages);
  const cwd = expandPath(opts.cwd || conv.cwd || process.cwd());

  let model;
  if (opts.model && typeof opts.model === 'string') {
    const [provider, ...rest] = opts.model.split('/');
    model = { provider, modelId: rest.join('/') };
  }

  const targetConv = { ...conv, messages: budget.messages };
  const dryRun = Boolean(opts['dry-run']);

  let writeResult = null;
  if (!dryRun) {
    try {
      writeResult = to.write(targetConv, { cwd, model, register: !opts['no-register'] });
    } catch (err) {
      fail(`写入 ${to.name} 会话失败: ${err.message}`);
    }
  }

  printPreview({
    conv,
    summary,
    budgetInfo: budget,
    target: to.name,
    cwd,
    writeResult,
    dryRun,
  });

  if (writeResult && process.env.SBRIDGE_VERBOSE) {
    const check = to.read(writeResult.file);
    console.log(`校验     回读 ${check.messages.length} 条消息，tokens 约 ${check.messages.reduce((n, m) => n + estimateTokens(messageBody(m)), 0)}，涉及文件 ${changedFiles(check.messages).length} 个`);
  }
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || opts._.length === 0) {
  console.log(HELP);
  process.exit(0);
}

const command = opts._[0];
if (command === 'list') cmdList(opts);
else if (command === 'show') cmdShow(opts);
else if (command === 'convert') cmdConvert(opts);
else {
  console.log(HELP);
  process.exit(1);
}
