import { estimateTokens, truncate, formatArgs } from './util.mjs';

/**
 * 统一会话模型：
 * { sourceTool, sourceFile, id, cwd, createdAt, title,
 *   messages: [{ role:'user'|'assistant', text, ts, tools:[{name,args,outcome}] }] }
 */

const MUTATING_TOOL = /^(edit|write|create|apply|patch|multiedit|str_replace|notebook_edit)/i;

export function buildConversation({ sourceTool, sourceFile, id, cwd, createdAt, title, messages, interruptedCalls = 0 }) {
  return { sourceTool, sourceFile, id, cwd, createdAt, title, interruptedCalls, messages: messages.filter((m) => m.text || (m.tools && m.tools.length)) };
}

/** 把工具调用拼成交接用的纯文本行（结果体一律丢弃，只留一行结论） */
export function toolTrailText(tools, limit = 12) {
  if (!tools || !tools.length) return '';
  const shown = tools.slice(-limit);
  const lines = shown.map((t) => {
    const args = formatArgs(t.args, 140);
    const outcome = t.outcome ? ` -> ${truncate(t.outcome, 90)}` : '';
    return `- ${t.name}(${args})${outcome}`;
  });
  if (tools.length > limit) lines.unshift(`- （更早的 ${tools.length - limit} 次调用已省略）`);
  return `[工具调用记录]\n${lines.join('\n')}`;
}

/** 组装最终用于写入的纯文本正文 */
export function messageBody(msg) {
  const parts = [];
  if (msg.text && msg.text.trim()) parts.push(msg.text.trim());
  const trail = toolTrailText(msg.tools);
  if (trail) parts.push(trail);
  return parts.join('\n\n');
}

export function changedFiles(messages) {
  const files = new Set();
  for (const m of messages) {
    for (const t of m.tools || []) {
      if (!MUTATING_TOOL.test(t.name || '')) continue;
      let args = t.args;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      if (!args || typeof args !== 'object') continue;
      for (const key of ['path', 'file_path', 'filePath', 'filename', 'target_file', 'file']) {
        if (typeof args[key] === 'string') files.add(args[key]);
      }
    }
  }
  return [...files];
}

/**
 * 上下文预算裁剪：保留首条消息与最近若干条，其余按预算从新到旧填充。
 * 返回保留后的消息列表与丢弃统计。
 */
export function applyBudget(messages, { maxTokens, tailPin = 4 } = {}) {
  const total = messages.reduce((n, m) => n + estimateTokens(messageBody(m)), 0);
  if (!maxTokens || total <= maxTokens) return { messages, droppedCount: 0, droppedTokens: 0, total };

  const first = messages[0];
  const firstTokens = estimateTokens(messageBody(first));
  const tailStart = Math.max(1, messages.length - tailPin);
  const tail = messages.slice(tailStart);
  const tailTokens = tail.reduce((n, m) => n + estimateTokens(messageBody(m)), 0);

  let budget = maxTokens - firstTokens - tailTokens;
  const kept = [];
  let droppedCount = 0;
  let droppedTokens = 0;

  for (let i = 1; i < tailStart; i++) {
    const cost = estimateTokens(messageBody(messages[i]));
    if (budget - cost >= 0) {
      budget -= cost;
      kept.push(messages[i]);
    } else {
      droppedCount++;
      droppedTokens += cost;
    }
  }

  if (droppedCount === 0 && kept.length === tailStart - 1) return { messages, droppedCount: 0, droppedTokens: 0, total };

  const notice = {
    role: 'user',
    ts: first.ts,
    text: `[会话交接] 为适配目标上下文预算，已省略 ${droppedCount} 条较早对话（约 ${droppedTokens} tokens）。早期细节可能缺失，必要时请重新读取相关文件或重跑命令确认现状。`,
  };
  return {
    messages: [first, notice, ...kept, ...tail],
    droppedCount,
    droppedTokens,
    total,
  };
}

export function summarize(conv) {
  const users = conv.messages.filter((m) => m.role === 'user');
  const assistants = conv.messages.filter((m) => m.role === 'assistant');
  const tokens = conv.messages.reduce((n, m) => n + estimateTokens(messageBody(m)), 0);
  const files = changedFiles(conv.messages);
  return {
    turnCount: users.length,
    messageCount: conv.messages.length,
    assistantCount: assistants.length,
    tokens,
    files,
    interruptedCalls: conv.interruptedCalls || 0,
    firstUser: users[0] ? truncate(users[0].text, 300) : '',
    lastUser: users.length > 1 ? truncate(users[users.length - 1].text, 300) : '',
    lastAssistant: assistants.length ? truncate(assistants[assistants.length - 1].text, 400) : '',
  };
}
