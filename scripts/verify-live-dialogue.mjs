// 可选真人模型验收：只在临时工作目录创建独立验证会话，不接触用户已有会话。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createExecutionDriver } from '../src/execution-driver.mjs';
import { CliProcess } from '../src/cli-process.mjs';
import { listModels } from '../src/models.mjs';

const tool = process.argv[2] || 'claude';
if (!['claude', 'codex'].includes(tool)) throw Error('Only claude/codex are supported');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `sbridge-live-${tool}-`));
const node = { id: 'live-test', tool, cwd, model: listModels(tool).configModel || undefined };
let questionCount = 0, firstSession = null;
async function run(message, ask = true) {
  let finalText = '';
  let resolve, reject;
  const outcome = new Promise((yes, no) => { resolve = yes; reject = no; });
  const driver = createExecutionDriver({ node, runId: `live-${Date.now()}`, message,
    onComplete: resolve, onRequestCanceled() {},
    onSession(s) { if (s.id) { firstSession ||= s.id; node.sessionId = s.id; } if (s.file) node.file = s.file; },
    onRequest(q) {
      if (q.view.kind !== 'questions') { q.respond({ decision: 'decline' }).catch(reject); return; }
      questionCount++;
      const answers = Object.fromEntries(q.view.questions.map((question) => [question.id,
        [question.options[1]?.value || question.options[0]?.value || '方案 B']]));
      q.respond({ answers }).catch(reject);
    },
  }, { makeProcess: (name, args, options) => {
    const extras = name === 'claude' ? ['--tools', 'AskUserQuestion', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] : [];
    const process = new CliProcess(name, [...args, ...extras], { ...options, onRecord(rec) {
      if (name === 'claude' && rec.type === 'assistant') finalText += (rec.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (name === 'codex' && rec.method === 'item/completed' && rec.params?.item?.type === 'agentMessage') finalText += rec.params.item.text;
      options.onRecord(rec);
    } });
    const write = process.write.bind(process);
    process.write = (record) => {
      if (name === 'codex' && record.method === 'turn/start' && ask) {
        record.params.collaborationMode = { mode: 'plan', settings: { model: node.model, reasoning_effort: 'low', developer_instructions: null } };
      }
      return write(record);
    };
    return process;
  } });
  const timeout = setTimeout(() => reject(Error('模型验收超过 120 秒')), 120_000);
  try { await driver.start(); const result = await outcome; assert.equal(result.exitCode, 0, `CLI exit ${result.exitCode}: ${String(result.stderrTail || '').replace(/(?:sk-|key-)[\w-]+/g, '[redacted]').slice(-200)}`); }
  finally { clearTimeout(timeout); await driver.stop(); }
  return finalText;
}
await run(`这是隔离交互验收。请只使用 ${tool === 'claude' ? 'AskUserQuestion' : 'request_user_input'} 工具问我选择“方案 A”还是“方案 B”。收到答案后，用一句中文确认选择。不要读取或修改文件，不要使用其他工具。`);
assert.ok(questionCount > 0, '模型没有发出问题请求');
assert.ok(firstSession, '会话 ID 未收到');
const recalledText = await run('请用一句中文复述我上一轮选择的方案，不调用任何工具。', false);
assert.equal(node.sessionId, firstSession);
assert.match(recalledText, /B|Ｂ/);
console.log(JSON.stringify({ tool, passed: true, questionCount, resumedSameSession: true, rememberedChoice: true, cwd }));
