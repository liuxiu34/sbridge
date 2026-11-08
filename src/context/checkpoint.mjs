import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as db from './db.mjs';
import * as piAdapter from '../pi.mjs';
import * as codexAdapter from '../codex.mjs';
import * as claudeAdapter from '../claude.mjs';
import { captureTask } from './capture.mjs';
import { estimateTokens, truncate } from '../util.mjs';

/**
 * 上下文检查点生成：
 * 1. 增量捕获 + 规则加工（capture 内含）
 * 2. 组装六节 payload（规则）
 * 3. useLlm 时用 pi -p 一次性加工认知部分，失败自动降级纯规则
 * 4. 渲染注入文本并存库
 */

const LLM_TIMEOUT_MS = 60000;
const TARGET_MAX_TOKENS = 10000;

/** 损耗报告：检查点纳入了多少、省略了多少、去重合并了多少，让用户知道丢了什么 */
function buildLossReport(ctxTaskId, payload, sessions = []) {
  const ev = db.countEvidence(ctxTaskId);
  const knowledgeTotal = db.listKnowledge(ctxTaskId).length;
  const hypothesesTotal = db.listHypotheses(ctxTaskId).length;

  // 最近一个源会话的中断调用数（悬空 call↔result）
  let interruptedCalls = 0;
  try {
    const readers = { codex: codexAdapter, pi: piAdapter, claude: claudeAdapter };
    const latest = sessions
      .filter((s) => s.file && fs.existsSync(s.file))
      .sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs)[0];
    if (latest && readers[latest.tool]?.read) {
      interruptedCalls = readers[latest.tool].read(latest.file).interruptedCalls || 0;
    }
  } catch { /* 读取失败不影响检查点生成 */ }

  return {
    eventsTotal: db.countEvents(ctxTaskId),
    knowledgeTotal,
    knowledgeIncluded: payload.workingKnowledge.verified.length + payload.workingKnowledge.stale.length,
    hypothesesTotal,
    hypothesesIncluded: payload.reasoningArtifacts.open.length + payload.reasoningArtifacts.refuted.length,
    evidenceTotal: ev.total,
    evidenceIncluded: ['errors', 'tests', 'commands', 'diffs'].reduce((n, k) => n + payload.executionEvidence[k].length, 0),
    dedupMerged: ev.merged,
    projectKnowledgeIncluded: payload.projectKnowledge.verified.length + payload.projectKnowledge.stale.length,
    interruptedCalls,
  };
}

/* ---------- git 信息 ---------- */

function gitIdentity(cwd) {
  const info = { cwd: cwd || '', gitBranch: null, gitCommit: null };
  if (!cwd) return info;
  try {
    const head = fs.readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref: (.+)$/);
    info.gitBranch = m ? m[1].replace('refs/heads/', '') : head.slice(0, 12);
    if (m) {
      const refFile = path.join(cwd, '.git', m[1]);
      if (fs.existsSync(refFile)) info.gitCommit = fs.readFileSync(refFile, 'utf8').trim().slice(0, 12);
    }
  } catch {
    // 非 git 目录
  }
  return info;
}

/* ---------- payload 组装（规则） ---------- */

function collect(ctxTaskId) {
  return {
    task: db.getTask(ctxTaskId),
    knowledge: db.listKnowledge(ctxTaskId),
    hypotheses: db.listHypotheses(ctxTaskId),
    evidence: db.listEvidence(ctxTaskId, 120),
    codeRefs: db.listCodeRefs(ctxTaskId),
    sessions: db.listAgentSessions(ctxTaskId),
  };
}

function buildPayload(ctxTaskId, cwd) {
  const data = collect(ctxTaskId);
  const lastAssistant = db.lastAssistantText(ctxTaskId);

  const byKind = (kind) => data.evidence.filter((e) => e.kind === kind);
  const stale = data.knowledge.filter((k) => k.status === 'stale');
  const verified = data.knowledge.filter((k) => k.status === 'verified');
  const changedFiles = data.codeRefs.filter((c) => (c.note || '').includes('已变化')).map((c) => c.path);

  // 项目级长期认知：与当前任务追踪文件相关者优先
  const projRows = data.task?.project_id ? db.listProjectKnowledge(data.task.project_id) : [];
  const taskPathBases = new Set(data.codeRefs.map((c) => c.path.replace(/\\/g, '/').split('/').pop()));
  const projRanked = projRows
    .map((k) => ({ ...k, related: taskPathBases.has(k.content.match(/[\w.-]+\.\w+/)?.[0] || '\u0000') }))
    .sort((a, b) => (b.related - a.related) || b.updated_at.localeCompare(a.updated_at));

  return {
    projectIdentity: {
      cwd: cwd || data.task?.project_id || '',
      ...gitIdentity(cwd),
      trackedFiles: data.codeRefs.length,
    },
    activeTask: {
      title: data.task?.title || '',
      goal: data.task?.goal || '',
      stage: lastAssistant ? '进行中（详见 Continuation State）' : '刚绑定',
    },
    projectKnowledge: {
      verified: projRanked.filter((k) => k.status === 'verified').slice(0, 12).map((k) => ({ kind: k.kind, text: truncate(k.content, 180), related: k.related })),
      stale: projRanked.filter((k) => k.status === 'stale').slice(0, 8).map((k) => ({ text: truncate(k.content, 180) })),
    },
    workingKnowledge: {
      verified: verified.slice(0, 14).map((k) => ({ kind: k.kind, text: truncate(k.content, 180) })),
      stale: stale.slice(0, 10).map((k) => ({ text: truncate(k.content, 180) })),
      changedFiles: changedFiles.slice(0, 8),
    },
    reasoningArtifacts: {
      open: data.hypotheses.filter((h) => h.status === 'open').slice(0, 10).map((h) => truncate(h.content, 180)),
      refuted: data.hypotheses.filter((h) => h.status === 'refuted').slice(0, 10).map((h) => truncate(h.content, 180)),
    },
    executionEvidence: {
      errors: topEvidence(byKind('error')),
      tests: topEvidence(byKind('test')),
      commands: topEvidence(byKind('command')),
      diffs: topEvidence(byKind('diff')),
    },
    continuationState: {
      lastAssistant: truncate(lastAssistant?.outcome || '', 600),
      note: data.task?.goal ? '' : '用户目标尚未从会话中识别到，请参考 Active Task 上下文确认。',
    },
  };
}

function topEvidence(list, limit = 6) {
  return list
    .slice()
    .sort((a, b) => (b.count - a.count) || b.last_ts.localeCompare(a.last_ts))
    .slice(0, limit)
    .map((e) => `[${e.count}次] ${truncate(e.summary, 150)}`);
}

/* ---------- 渲染（规则兜底 / 最终输出格式） ---------- */

const bullet = (line) => (line.startsWith('-') ? line : `- ${line}`);

function renderPayload(p, { llmSections = null } = {}) {
  const L = [];
  L.push('# 上下文检查点（Context Checkpoint）');
  L.push('');
  L.push('这是由 sbridge 自动生成的结构化工作上下文，用于无缝接续前一个编程工具的任务。请把它当作已经建立的工作认知，不要重新探索整个项目。标注「旧版本」的内容基于已变化的代码，修改前必须重新读取对应文件。');
  L.push('');

  L.push('## 1. 项目标识（Project Identity）');
  L.push(`- 工作目录: ${p.projectIdentity.cwd || '(未知)'}`);
  if (p.projectIdentity.gitBranch) L.push(`- Git 分支: ${p.projectIdentity.gitBranch}${p.projectIdentity.gitCommit ? ` @ ${p.projectIdentity.gitCommit}` : ''}`);
  L.push('');

  const at = llmSections?.activeTask || [
    `任务: ${p.activeTask.title}`,
    p.activeTask.goal ? `用户目标: ${truncate(p.activeTask.goal, 500)}` : null,
  ].filter(Boolean);
  L.push('## 2. 当前任务（Active Task）');
  for (const line of at) L.push(bullet(line));
  L.push('');

  L.push('## 3. 项目认知（跨任务长期沉淀）');
  const pk = llmSections?.project;
  if (pk?.length) {
    for (const line of pk) L.push(bullet(line));
  } else if (p.projectKnowledge.verified.length || p.projectKnowledge.stale.length) {
    for (const k of p.projectKnowledge.verified) L.push(`- [已沉淀/${k.kind}]${k.related ? '（与本任务相关）' : ''} ${k.text}`);
    for (const k of p.projectKnowledge.stale) L.push(`- [旧版本，需重读] ${k.text}`);
  } else {
    L.push('- （暂无——会随任务推进自动沉淀结构类结论）');
  }
  L.push('');

  L.push('## 4. 工作认知（Working Knowledge）');
  const wk = llmSections?.workingKnowledge;
  if (p.workingKnowledge.changedFiles?.length && !wk?.length) {
    L.push('- [文件已变化] 以下文件在上个工具工作期间之后被修改过，相关旧认知可能过期，修改前必须重读：');
    for (const f of p.workingKnowledge.changedFiles) L.push(`  - ${f}`);
  }
  if (wk?.length) {
    for (const line of wk) L.push(bullet(line));
  } else if (p.workingKnowledge.verified.length || p.workingKnowledge.stale.length) {
    for (const k of p.workingKnowledge.verified) L.push(`- [已确认/${k.kind}] ${k.text}`);
    for (const k of p.workingKnowledge.stale) L.push(`- [旧版本，需重读] ${k.text}`);
  } else {
    L.push('- （暂无已建立的任务认知）');
  }
  L.push('');

  L.push('## 5. 判断与假设（Reasoning Artifacts）');
  const ra = llmSections?.reasoning;
  if (ra?.length) {
    for (const line of ra) L.push(bullet(line));
  } else {
    for (const h of p.reasoningArtifacts.open) L.push(`- [待验证假设] ${h}`);
    for (const h of p.reasoningArtifacts.refuted) L.push(`- [已排除] ${h}`);
    if (!p.reasoningArtifacts.open.length && !p.reasoningArtifacts.refuted.length) L.push('- （暂无）');
  }
  L.push('');

  L.push('## 6. 执行证据（Execution Evidence）');
  const ev = llmSections?.evidence;
  if (ev?.length) {
    for (const line of ev) L.push(bullet(line));
  } else {
    for (const [label, list] of [['错误', p.executionEvidence.errors], ['测试', p.executionEvidence.tests], ['命令', p.executionEvidence.commands], ['修改', p.executionEvidence.diffs]]) {
      for (const e of list) L.push(`- [${label}] ${e}`);
    }
    if (!p.executionEvidence.errors.length && !p.executionEvidence.tests.length && !p.executionEvidence.commands.length && !p.executionEvidence.diffs.length) {
      L.push('- （暂无）');
    }
  }
  L.push('');

  L.push('## 7. 接续状态（Continuation State）');
  const cs = llmSections?.continuation;
  if (cs?.length) {
    for (const line of cs) L.push(bullet(line));
  } else {
    if (p.continuationState.lastAssistant) L.push(`- 前一个工具最后的输出: ${p.continuationState.lastAssistant}`);
    if (p.continuationState.note) L.push(`- ${p.continuationState.note}`);
    L.push('- 请基于以上认知继续当前任务；需要精确代码时重新读取对应文件再修改。');
  }
  return L.join('\n');
}

/* ---------- LLM 加工 ---------- */

function buildLlmMaterial(p, prevPayload = null) {
  const lines = [];
  if (prevPayload) {
    lines.push('【上一版检查点认知（用于合并，不要原样重复）】');
    const prev = prevPayload.llmSections;
    if (prev) {
      for (const [label, key] of [['项目', 'project'], ['认知', 'knowledge'], ['判断', 'reasoning'], ['证据', 'evidence'], ['接续', 'continuation']]) {
        for (const item of prev[key] || []) lines.push(`[${label}] ${item}`);
      }
    } else {
      for (const k of prevPayload.projectKnowledge?.verified || []) lines.push(`[项目] ${k.text || k.content || ''}`);
      for (const k of prevPayload.workingKnowledge?.verified || []) lines.push(`[认知] ${k.text || k.content || ''}`);
      for (const h of prevPayload.reasoningArtifacts?.open || []) lines.push(`[假设] ${h}`);
    }
    lines.push('');
  }
  lines.push('【本轮素材】');
  lines.push(`任务: ${p.activeTask.title}`);
  if (p.activeTask.goal) lines.push(`用户目标: ${p.activeTask.goal}`);
  lines.push('');
  lines.push('原始认知条目（已由规则从会话中提取，可能冗余、粗糙或互相矛盾）:');
  for (const k of p.projectKnowledge.verified) lines.push(`[项目认知${k.related ? '-与任务相关' : ''}] ${k.text}`);
  for (const k of p.projectKnowledge.stale) lines.push(`[项目认知-可能过期] ${k.text}`);
  for (const k of p.workingKnowledge.verified) lines.push(`[认知] ${k.text}`);
  for (const k of p.workingKnowledge.stale) lines.push(`[认知-可能过期] ${k.text}`);
  for (const h of p.reasoningArtifacts.open) lines.push(`[假设] ${h}`);
  for (const h of p.reasoningArtifacts.refuted) lines.push(`[已排除] ${h}`);
  for (const e of [...p.executionEvidence.errors, ...p.executionEvidence.tests, ...p.executionEvidence.commands, ...p.executionEvidence.diffs]) lines.push(`[证据] ${e}`);
  if (p.continuationState.lastAssistant) lines.push(`[最后输出] ${p.continuationState.lastAssistant}`);
  return lines.join('\n');
}

const LLM_PROMPT_HEADER = `你是编程 Agent 工作上下文的整理器。下面是前一个编程工具的工作记录素材。请把它整理成结构化认知，严格按以下格式输出（不要输出其他内容，不要寒暄）：

## ACTIVE
- 当前任务与用户目标（1-3 条）
## PROJECT
- 项目级长期认知：架构、核心模块、入口、部署方式、技术栈等跨任务仍然有效的信息（去重合并，最多 12 条；没有则写 - （无））
## KNOWLEDGE
- 当前任务确认的代码认知（去重合并，保留关键细节，最多 12 条）
## REASONING
- 判断与假设：[待验证]/[已排除] 前缀，最多 10 条
## EVIDENCE
- 关键执行证据：[错误]/[测试]/[命令]/[修改] 前缀 + 次数，最多 12 条
## CONTINUATION
- 接续状态：当前阻碍、下一步建议、尚需验证的信息（2-5 条）

要求：保留具体信息（文件名、函数名、错误关键词、结论），不要泛化成空话；素材互相矛盾时以时间靠后的为准；不确定的内容保留为[待验证]。
如果提供了「上一版检查点认知」，你输出的仍是**完整合并后的最新版**：保留其中仍然有效的条目（可精简措辞），更新或删除已被推翻的，补充新增的；不要原样重复上一版的大段内容，让新版体积与信息量保持稳定。

素材：
`;

function callPiLlm(material) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `sb_ckpt_${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmp, LLM_PROMPT_HEADER + material, 'utf8');
    } catch {
      resolve(null);
      return;
    }
    // 复用本机最近 pi 会话验证过的 provider/model，避免默认 provider 不可用
    let providerArgs = '';
    try {
      const model = piAdapter.detectModel();
      if (model?.provider && model?.modelId) {
        providerArgs = ` --provider ${model.provider} --model ${model.modelId}`;
      }
    } catch { /* 探测失败用默认 */ }

    // 继承的死代理（如 HTTP_PROXY 指向未运行的 7890）会导致 Connection error，显式清除
    const env = { ...process.env };
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];

    let out = '';
    let done = false;
    const child = spawn(`pi -p --no-session --no-tools --no-context-files${providerArgs} @"${tmp}"`, {
      shell: true, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill(); } catch { /* ignore */ } resolve(null); }
    }, LLM_TIMEOUT_MS);

    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', () => { /* 忽略 stderr 噪音（扩展警告等） */ });
    child.on('close', () => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        resolve(out.trim() || null);
      }
    });
  });
}

function parseLlmSections(text) {
  if (!text || text.length < 60) return null;
  const sections = {};
  const marks = [...text.matchAll(/^##\s*(PROJECT|ACTIVE|KNOWLEDGE|REASONING|EVIDENCE|CONTINUATION)\s*$/gim)];
  if (marks.length < 4) return null;
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(start, end).trim();
    if (!body) continue;
    sections[marks[i][1].toLowerCase()] = body.split('\n').map((l) => l.trim()).filter((l) => l && !/^（无）$/.test(l)).slice(0, 14);
  }
  const required = ['active', 'knowledge', 'reasoning', 'evidence', 'continuation'];
  if (!required.every((k) => Array.isArray(sections[k]) && sections[k].length)) return null;
  return {
    project: sections.project || [],
    activeTask: sections.active,
    workingKnowledge: sections.knowledge,
    reasoning: sections.reasoning,
    evidence: sections.evidence,
    continuation: sections.continuation,
  };
}

/* ---------- 预算裁剪 ---------- */

function safeParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

function trimToBudget(rendered, maxTokens) {
  if (estimateTokens(rendered) <= maxTokens) return rendered;
  // 按行从「执行证据/工作认知」中段开始删，保留头部说明、任务与接续状态
  const lines = rendered.split('\n');
  const dropRe = /^- \[(已确认|旧版本|待验证假设|已排除|错误|测试|命令|修改)\]/;
  for (let i = lines.length - 1; i >= 0 && estimateTokens(lines.join('\n')) > maxTokens; i--) {
    if (dropRe.test(lines[i])) lines.splice(i, 1);
  }
  return lines.join('\n');
}

/* ---------- 主入口 ---------- */

export async function buildCheckpoint(ctxTaskId, { useLlm = true, cwd, maxTokens = TARGET_MAX_TOKENS, sessions = [] } = {}) {
  captureTask(ctxTaskId, { sessions });

  const payload = buildPayload(ctxTaskId, cwd);
  const prev = db.latestCheckpoint(ctxTaskId);
  const prevPayload = prev ? safeParse(prev.payload) : null;
  let llmSections = null;
  let llmTokens = 0;

  if (useLlm) {
    let material = buildLlmMaterial(payload, prevPayload);
    if (estimateTokens(material) > 12000) {
      // 素材过大时先粗裁，控制 LLM 成本
      payload.workingKnowledge.verified = payload.workingKnowledge.verified.slice(0, 10);
      payload.executionEvidence.commands = payload.executionEvidence.commands.slice(0, 4);
      material = buildLlmMaterial(payload, prevPayload);
    }
    const raw = await callPiLlm(material);
    llmSections = parseLlmSections(raw);
    if (raw) llmTokens = estimateTokens(LLM_PROMPT_HEADER + raw);
  }

  const rendered = trimToBudget(renderPayload(payload, { llmSections }), maxTokens);
  const injectedTokens = estimateTokens(rendered);
  const lossReport = buildLossReport(ctxTaskId, payload, sessions || []);

  const saved = db.insertCheckpoint({
    taskId: ctxTaskId,
    payload: { ...payload, llmSections: llmSections || null },
    rendered,
    injectedTokens,
    llmTokens,
    llmUsed: !!llmSections,
    lossJson: JSON.stringify(lossReport),
  });

  return {
    checkpointId: saved.id,
    version: saved.version,
    payload,
    llmSections,
    rendered,
    injectedTokens,
    llmTokens,
    llmUsed: !!llmSections,
    lossReport,
  };
}
