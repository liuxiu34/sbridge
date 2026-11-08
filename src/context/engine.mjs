import fs from 'node:fs';
import * as db from './db.mjs';

/**
 * 有效认知引擎（纯规则，零 LLM）：
 * 消费未处理事件 → 证据分类去重 → 结论抽取 → 代码引用与失效检测 → 状态汇总。
 */

const MUTATING_TOOL = /^(edit|write|create|apply|patch|multiedit|str_replace|replace|insert|notebook_edit)/i;
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'target_file', 'file', 'notebook_path', 'abs_path'];

/* ---------- 证据分类 ---------- */

const TEST_RE = /\b(pass|fail|passed|failed|✓|✗|√|×|tests?\s+\d+\s+passed|exit code [1-9]|测试通过|测试失败)\b/i;
const ERROR_RE = /\b(error|exception|traceback|panic|fatal|failed to|cannot |unable to|报错|异常|失败)\b/i;
const DIFF_TOOL = /^(edit|write|apply|patch|multiedit|str_replace|replace|insert|create)$/i;

function classifyEvidence({ toolName, outcome }) {
  const text = `${toolName || ''} ${outcome || ''}`;
  if (toolName && DIFF_TOOL.test(toolName)) return 'diff';
  if (TEST_RE.test(outcome || '')) return 'test';
  if (ERROR_RE.test(outcome || '')) return 'error';
  return 'command';
}

function evidenceSummary({ toolName, outcome }) {
  const flat = String(outcome || '').replace(/\s+/g, ' ').trim();
  const head = toolName ? `${toolName}: ` : '';
  return `${head}${flat.slice(0, 160)}${flat.length > 160 ? '…' : ''}`;
}

/* ---------- 结论抽取 ---------- */

const VERIFIED_RE = /(验证通过|已确认|已修复|测试通过|可以通过了|根因是|问题出在|问题在|已经解决|修复完成|确认了)/;
const HYPOTHESIS_RE = /(可能是|怀疑|假设|待验证|还没确认|尚未验证|大概|也许是因为|不确定是否)/;
const REFUTED_RE = /(排除了|不是.*的问题|已排除|排除了.*原因|没有效果|无效|行不通|此路不通)/;
/* 结构类结论 → 沉淀为项目级长期认知（跨任务共享） */
const PROJECT_STRUCTURE_RE = /(项目结构|架构|入口|部署|前端文件|后端文件|主入口|技术栈|目录结构|核心模块|配置文件|数据表|接口路由|统一在|位于)/;

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?;\n])|(?<=[;；]\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 220);
}

function extractConclusions(text) {
  const found = { verified: [], hypothesis: [], refuted: [] };
  for (const sentence of splitSentences(text)) {
    if (REFUTED_RE.test(sentence)) found.refuted.push(sentence);
    else if (VERIFIED_RE.test(sentence)) found.verified.push(sentence);
    else if (HYPOTHESIS_RE.test(sentence)) found.hypothesis.push(sentence);
  }
  return found;
}

/* ---------- 代码引用 ---------- */

const PATH_RE = /(?:[A-Za-z]:[\\/]|\/(?:home|Users|opt|data|www)\/)[^\s"'`),;]+\.[A-Za-z0-9]{1,8}|(?:[\\/][\w.@-]+){2,}\.[A-Za-z0-9]{1,8}/g;

function extractPaths(argsJson) {
  if (!argsJson) return [];
  const found = new Set();
  // 1) 已知键名的直接取值
  let args;
  try {
    args = typeof argsJson === 'string' ? JSON.parse(argsJson) : argsJson;
  } catch {
    args = null;
  }
  if (args && typeof args === 'object') {
    const walk = (node, depth = 0) => {
      if (depth > 4 || !node || typeof node !== 'object') return;
      for (const [key, val] of Object.entries(node)) {
        if (typeof val === 'string') {
          if (PATH_KEYS.includes(key) && /\.[A-Za-z0-9]{1,8}$/.test(val)) found.add(val);
          // 任意字符串值中的路径形态（覆盖 js/exec 等自由参数）
          for (const m of val.matchAll(PATH_RE)) found.add(m[0]);
        } else if (val && typeof val === 'object') {
          walk(val, depth + 1);
        }
      }
    };
    walk(args);
  }
  // 2) args 本身解析失败时从原始文本兜底扫描
  if (!found.size && typeof argsJson === 'string') {
    for (const m of argsJson.matchAll(PATH_RE)) found.add(m[0]);
  }
  // 过滤：URL（含被截断中段的）、node_modules；并归一化 JSON 转义产生的双反斜杠
  return [...found]
    .map((p) => p.replace(/\\{2,}/g, '\\'))
    .filter((p) => !p.includes('://') && !p.startsWith('//') && !p.includes('node_modules'))
    .slice(0, 8);
}

function updateCodeRefs(ctxTaskId, evt) {
  const paths = extractPaths(evt.args_json);
  for (const p of paths) {
    let hash = null;
    try {
      hash = fs.existsSync(p) ? db.fileHash(p) : null;
    } catch {
      hash = null;
    }
    db.upsertCodeRef({
      taskId: ctxTaskId,
      filePath: p,
      contentHash: hash,
      lastTool: evt.tool_name || '',
      note: MUTATING_TOOL.test(evt.tool_name || '') ? '曾被修改' : '曾被读取',
    });
    // 文件被修改 → 相关知识可能过期
    if (MUTATING_TOOL.test(evt.tool_name || '')) markStaleByPath(ctxTaskId, p);
  }
}

function markStaleByPath(ctxTaskId, filePath) {
  const dbi = openDbSafe();
  const base = filePath.replace(/\\/g, '/').split('/').pop();
  const rows = dbi.prepare("SELECT id, content FROM knowledge WHERE task_id = ? AND status = 'verified'").all(ctxTaskId);
  for (const row of rows) {
    if (row.content.includes(base)) {
      dbi.prepare("UPDATE knowledge SET status = 'stale', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id);
    }
  }
  // 项目级长期认知联动失效
  const task = db.getTask(ctxTaskId);
  if (!task?.project_id) return;
  const key = db.projectKnowledgeKey(task.project_id);
  const projRows = dbi.prepare("SELECT id, content FROM knowledge WHERE task_id = ? AND status = 'verified'").all(key);
  for (const row of projRows) {
    if (row.content.includes(base)) {
      dbi.prepare("UPDATE knowledge SET status = 'stale', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id);
    }
  }
}

function openDbSafe() {
  // 循环依赖规避：engine 被 capture 调用时 db 已初始化
  return db.openDb();
}

/* ---------- 主处理 ---------- */

export function processEvents(ctxTaskId) {
  const events = db.pendingEvents(ctxTaskId);
  const stats = { events: events.length, evidence: 0, knowledge: 0, hypotheses: 0, codeRefs: 0 };

  for (const evt of events) {
    if (evt.kind === 'user') {
      // 用户最新诉求持续覆盖任务目标
      db.openDb().prepare('UPDATE tasks SET goal = ?, updated_at = ? WHERE id = ?')
        .run(String(evt.outcome || '').slice(0, 2000), new Date().toISOString(), ctxTaskId);
    } else if (evt.kind === 'tool_result') {
      const kind = classifyEvidence(evt);
      const r = db.upsertEvidence({
        taskId: ctxTaskId,
        kind,
        summary: evidenceSummary(evt),
        detail: String(evt.outcome || '').slice(0, MAX_DETAIL),
        hash: evt.outcome_hash,
        ts: evt.ts,
      });
      if (!r.merged) stats.evidence++;
      stats.codeRefs += countCodeRefs(evt);
      updateCodeRefs(ctxTaskId, evt);
    } else if (evt.kind === 'assistant') {
      const found = extractConclusions(evt.outcome || '');
      for (const content of found.verified.slice(0, 3)) {
        const r = db.upsertKnowledge({ taskId: ctxTaskId, kind: 'mechanism', content });
        if (!r.merged) stats.knowledge++;
        // 结构类结论同时沉淀为项目级长期认知
        if (PROJECT_STRUCTURE_RE.test(content)) {
          const task = db.getTask(ctxTaskId);
          if (task?.project_id) {
            const pr = db.upsertProjectKnowledge({ projectId: task.project_id, kind: 'structure', content });
            if (!pr.merged) stats.projectKnowledge++;
          }
        }
      }
      for (const content of found.refuted.slice(0, 3)) {
        const r = db.upsertHypothesis({ taskId: ctxTaskId, content, status: 'refuted' });
        if (!r.merged) stats.hypotheses++;
      }
      for (const content of found.hypothesis.slice(0, 3)) {
        const r = db.upsertHypothesis({ taskId: ctxTaskId, content, status: 'open' });
        if (!r.merged) stats.hypotheses++;
      }
    }
  }

  db.markProcessed(events.map((e) => e.id));
  return stats;
}

const MAX_DETAIL = 4000;

function countCodeRefs(evt) {
  return extractPaths(evt.args_json).length;
}

/* ---------- 失效刷新：capture 末尾重算全部 code_refs 哈希 ---------- */

export function refreshStaleness(ctxTaskId) {
  const dbi = db.openDb();
  const refs = db.listCodeRefs(ctxTaskId);
  let invalidated = 0;
  for (const ref of refs) {
    if (!ref.content_hash || !fs.existsSync(ref.path)) continue;
    let current;
    try {
      current = db.fileHash(ref.path);
    } catch {
      continue;
    }
    if (current !== ref.content_hash) {
      dbi.prepare('UPDATE code_refs SET content_hash = ?, note = ?, updated_at = ? WHERE id = ?')
        .run(current, `${ref.note || ''} [已变化]`.trim(), new Date().toISOString(), ref.id);
      const before = dbi.prepare("SELECT COUNT(*) c FROM knowledge WHERE task_id = ? AND status = 'verified'").get(ctxTaskId).c;
      markStaleByPath(ctxTaskId, ref.path);
      const after = dbi.prepare("SELECT COUNT(*) c FROM knowledge WHERE task_id = ? AND status = 'verified'").get(ctxTaskId).c;
      invalidated += before - after;
    }
  }
  return { invalidated };
}

/* ---------- 状态汇总 ---------- */

export function contextSummary(ctxTaskId) {
  const dbi = db.openDb();
  const count = (sql, ...args) => dbi.prepare(sql).get(...args)?.c || 0;
  const knowledge = listLimited('SELECT kind, content, status, updated_at FROM knowledge WHERE task_id = ? ORDER BY updated_at DESC LIMIT 40', ctxTaskId);
  const hypotheses = listLimited('SELECT content, status, updated_at FROM hypotheses WHERE task_id = ? ORDER BY updated_at DESC LIMIT 40', ctxTaskId);
  const evidence = listLimited('SELECT kind, summary, count, last_ts FROM evidence WHERE task_id = ? ORDER BY last_ts DESC LIMIT 40', ctxTaskId);
  const codeRefs = listLimited('SELECT path, content_hash, last_tool, note, updated_at FROM code_refs WHERE task_id = ? ORDER BY updated_at DESC LIMIT 60', ctxTaskId);
  const checkpoint = db.latestCheckpoint(ctxTaskId);

  // 项目级长期认知（跨任务共享）
  const task = db.getTask(ctxTaskId);
  const projectKnowledge = task?.project_id
    ? listLimited('SELECT kind, content, status, updated_at FROM knowledge WHERE task_id = ? ORDER BY updated_at DESC LIMIT 40', db.projectKnowledgeKey(task.project_id))
    : [];

  return {
    knowledge,
    projectKnowledge,
    hypotheses,
    evidence,
    codeRefs,
    counts: {
      knowledge: count('SELECT COUNT(*) c FROM knowledge WHERE task_id = ?', ctxTaskId),
      knowledgeStale: count("SELECT COUNT(*) c FROM knowledge WHERE task_id = ? AND status = 'stale'", ctxTaskId),
      projectKnowledge: count("SELECT COUNT(*) c FROM knowledge WHERE task_id = ? AND status = 'verified'", db.projectKnowledgeKey(task?.project_id || '')),
      projectKnowledgeStale: count("SELECT COUNT(*) c FROM knowledge WHERE task_id = ? AND status = 'stale'", db.projectKnowledgeKey(task?.project_id || '')),
      hypothesesOpen: count("SELECT COUNT(*) c FROM hypotheses WHERE task_id = ? AND status = 'open'", ctxTaskId),
      hypothesesRefuted: count("SELECT COUNT(*) c FROM hypotheses WHERE task_id = ? AND status = 'refuted'", ctxTaskId),
      evidence: count('SELECT COUNT(*) c FROM evidence WHERE task_id = ?', ctxTaskId),
      codeRefs: count('SELECT COUNT(*) c FROM code_refs WHERE task_id = ?', ctxTaskId),
      checkpoints: count('SELECT COUNT(*) c FROM checkpoints WHERE task_id = ?', ctxTaskId),
    },
    latestCheckpoint: checkpoint
      ? {
          version: checkpoint.version,
          createdAt: checkpoint.created_at,
          injectedTokens: checkpoint.injected_tokens,
          llmUsed: !!checkpoint.llm_used,
          loss: safeLossJson(checkpoint.loss_json),
        }
      : null,
  };
}

function safeLossJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function listLimited(sql, taskId) {
  return db.openDb().prepare(sql).all(taskId);
}
