import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionDriver } from '../src/execution-driver.mjs';
import { claudeInteraction, piInteraction, codexInteraction, ompInteraction } from '../src/interaction-protocol.mjs';

function fixture(tool, replies = {}) {
  const writes = [], interactions = [], outcomes = [], sessions = [], canceled = [];
  let callbacks, args;
  const driver = createExecutionDriver({ node: { tool, cwd: process.cwd(), sessionId: 'existing', model: 'model', effort: 'high' },
    runId: 'run', message: 'message', onComplete: (r) => outcomes.push(r), onSession: (s) => sessions.push(s),
    onRequest: (q) => interactions.push(q), onRequestCanceled: (id) => canceled.push(id),
  }, { makeProcess(_tool, argv, opts) {
    callbacks = opts; args = argv;
    return { async write(rec) {
      writes.push(rec);
      queueMicrotask(() => {
        if (rec.method && rec.id) opts.onRecord({ id: rec.id, result: rec.method === 'thread/resume'
          ? { thread: { id: 'existing', path: 'session.jsonl' } } : rec.method === 'turn/start' ? { turn: { id: 'turn' } } : {} });
        if (rec.type === 'control_request') opts.onRecord({ type: 'control_response', response: { subtype: 'success', request_id: rec.request_id, response: {} } });
        if (['get_state', 'prompt', 'steer', 'set_ask_dialog'].includes(rec.type)) opts.onRecord({ type: 'response', id: rec.id, command: rec.type, success: true, data: replies[rec.type] ?? {} });
      });
    }, stop: async () => {}, end() {} };
  } });
  return { driver, writes, interactions, outcomes, sessions, canceled, emit: (rec) => callbacks.onRecord(rec), args: () => args };
}
test('Codex 按初始化、恢复原会话、开始回合顺序调用', async () => {
  const h = fixture('codex'); await h.driver.start();
  assert.deepEqual(h.writes.map((r) => r.method), ['initialize', 'initialized', 'thread/resume', 'turn/start']);
  assert.equal(h.writes[2].params.threadId, 'existing');
  assert.equal(h.writes[3].params.effort, 'high');
  h.emit({ id: 42, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q', question: '选择', options: [{ label: 'A' }] }] } });
  await h.interactions[0].respond({ answers: { q: ['A'] } });
  assert.deepEqual(h.writes.at(-1), { id: 42, result: { answers: { q: { answers: ['A'] } } } });
  h.emit({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
  assert.equal(h.outcomes[0].exitCode, 0); await h.driver.stop();
});
test('Claude 使用同一 stream-json 进程完成提问与回答', async () => {
  const h = fixture('claude'); await h.driver.start();
  assert.ok(h.args().includes('--input-format'));
  assert.ok(h.args().includes('--effort'));
  assert.equal(h.writes[0].request.subtype, 'initialize');
  assert.equal(h.writes[1].type, 'user');
  h.emit({ type: 'control_request', request_id: 'q', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion',
    input: { questions: [{ question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }] } } });
  await h.interactions[0].respond({ answers: { 0: ['B'] } });
  assert.equal(h.writes.at(-1).response.response.updatedInput.answers['选哪个？'], 'B');
  assert.equal(h.writes.at(-1).response.request_id, 'q'); await h.driver.stop();
});
test('Pi 请求错误明确失败，UI 回复使用原请求 ID', async () => {
  const h = fixture('pi'); await h.driver.start();
  h.emit({ type: 'extension_ui_request', id: 'select-1', method: 'select', title: '选择', options: ['A', 'B'] });
  await h.interactions[0].respond({ answers: { answer: ['B'] } });
  assert.deepEqual(h.writes.at(-1), { type: 'extension_ui_response', id: 'select-1', value: 'B' });
  await h.driver.steer('continue');
  assert.equal(h.writes.at(-1).type, 'steer'); await h.driver.stop();
});
test('答案校验拒绝漏答和伪造选项，不写入 CLI', async () => {
  const sent = [];
  const q = piInteraction({ id: 'q', method: 'select', options: ['A'] }, async (r) => sent.push(r));
  assert.throws(() => q.respond({ answers: {} }), /回答/);
  assert.throws(() => q.respond({ answers: { answer: ['forged'] } }), /有效选项/);
  assert.equal(sent.length, 0);
});
test('只读审批不能通过伪造请求扩大权限', async () => {
  const sent = [];
  const q = codexInteraction({ id: 1, method: 'item/commandExecution/requestApproval', params: { command: 'write' } }, async (r) => sent.push(r), true);
  assert.throws(() => q.respond({ decision: 'accept' }), /只读/);
  await q.respond({ decision: 'decline' });
  assert.deepEqual(sent[0], { id: 1, result: { decision: 'decline' } });
});
test('Claude 取消问题明确拒绝，不把取消当成同意', async () => {
  const sent = [];
  const q = claudeInteraction({ request_id: 'q', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [] } } }, async (r) => sent.push(r));
  await q.respond({ cancel: true });
  assert.equal(sent[0].response.response.behavior, 'deny');
});

test('Codex 原生决定列表限制卡片与答复，不能伪造允许', async () => {
  const q = codexInteraction({ id: 1, method: 'item/commandExecution/requestApproval',
    params: { availableDecisions: ['decline'] } }, async () => {});
  assert.deepEqual(q.view.choices.map((c) => c.id), ['decline']);
  assert.throws(() => q.respond({ decision: 'accept' }), /不接受/);
});

test('Codex 自动续轮可以再次报告完成', async () => {
  const h = fixture('codex'); await h.driver.start();
  h.emit({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
  h.emit({ method: 'turn/started', params: { turn: { id: 'continuation' } } });
  h.emit({ method: 'turn/completed', params: { turn: { id: 'continuation', status: 'completed' } } });
  assert.equal(h.outcomes.length, 2); await h.driver.stop();
});

test('OMP 使用 rpc-ui 恢复会话；按 prompt ID 等待后台工作结清', async () => {
  const h = fixture('omp'); await h.driver.start();
  assert.equal(h.args()[1], 'rpc-ui'); assert.ok(h.args().includes('--resume'));
  const promptId = h.writes.find((r) => r.type === 'prompt').id;
  h.emit({ type: 'agent_end' });
  h.emit({ type: 'prompt_result', id: 'old', status: 'completed', sessionSettled: true });
  assert.equal(h.outcomes.length, 0);
  h.emit({ type: 'prompt_result', id: promptId, status: 'completed', sessionSettled: false });
  assert.equal(h.outcomes.length, 0);
  h.emit({ type: 'session_settled' }); await new Promise((r) => setImmediate(r));
  assert.equal(h.outcomes[0].exitCode, 0); await h.driver.stop();
});

test('OMP input 本地处理只凭 agentInvoked:false 响应完成，不等待模型事件或 prompt_result', async () => {
  const h = fixture('omp', { get_state: { isSettled: true }, prompt: { agentInvoked: false } });
  try {
    await h.driver.start();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.outcomes, [{ exitCode: 0 }]);
    assert.deepEqual(h.writes.map((r) => r.type), ['get_state', 'set_ask_dialog', 'prompt', 'get_state']);
  } finally { await h.driver.stop(); }
});

test('OMP 输入、秘密字段及取消通知保持原生语义', async () => {
  const h = fixture('omp'); await h.driver.start();
  h.emit({ type: 'extension_ui_request', method: 'input', id: 'password', title: '输入', secret: true });
  assert.equal(h.interactions[0].view.questions[0].secret, true);
  h.emit({ type: 'extension_ui_request', method: 'cancel', id: 'cancel-event', targetId: 'password' });
  assert.deepEqual(h.canceled, ['password']);
  await h.interactions[0].respond({ cancel: true });
  assert.deepEqual(h.writes.at(-1), { type: 'extension_ui_response', id: 'password', cancelled: true });
  await h.driver.stop();
});

test('OMP 批量问题区分选项和自由回答，并校验单选', async () => {
  const sent = [];
  const q = ompInteraction({ id: 'ask', method: 'ask', questions: [
    { id: 'multi', question: '多选', multi: true, options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'single', question: '单选', options: [{ label: 'C' }] },
  ] }, async (r) => sent.push(r));
  assert.throws(() => q.respond({ answers: { multi: ['A'], single: ['C', 'free'] } }), /一个答案/);
  await q.respond({ answers: { multi: ['A', 'B'], single: ['free'] } });
  assert.deepEqual(sent[0].answers, [{ id: 'multi', selectedOptions: ['A', 'B'] }, { id: 'single', selectedOptions: [], customInput: 'free' }]);
});

test('OMP 逐项多选保留勾选状态与选项原值，不把完成按钮当选项', async () => {
  const sent = [];
  const q = ompInteraction({ id: 'toggle', method: 'select', title: '多选', selectionMarker: 'checkbox',
    options: ['A', 'B', '✓ Done selecting'], checkedIndices: [1], markableCount: 2 }, async (r) => sent.push(r));
  assert.equal(q.view.choices[1].label, '☑ B');
  assert.equal(q.view.choices[2].label, '完成选择');
  await q.respond({ decision: '2' });
  assert.equal(sent[0].value, '✓ Done selecting');
  assert.throws(() => q.respond({ decision: '99' }), /有效选项/);
});
