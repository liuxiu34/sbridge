const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const approvals = [{ id: 'accept', label: '允许本次' }, { id: 'decline', label: '拒绝', danger: true }];
const options = (items) => (items || []).map((o) => typeof o === 'string'
  ? { label: o, value: o, description: '' }
  : { label: String(o.label || ''), value: String(o.label || ''), description: String(o.description || '') });
function questions(items, tool) {
  return (items || []).map((q, index) => ({
    id: String(q.id || index), question: String(q.question || q.header || '请选择'),
    header: String(q.header || ''), options: options(q.options), multiSelect: !!q.multiSelect,
    secret: !!q.isSecret, allowCustom: tool === 'claude' || q.isOther !== false || !q.options?.length,
  }));
}
function readAnswers(view, body) {
  const result = {};
  for (const q of view.questions) {
    const values = body.answers?.[q.id];
    if (!Array.isArray(values) || !values.length || values.some((s) => typeof s !== 'string' || !s.trim())) throw invalid('请回答所有问题');
    if (!q.multiSelect && values.length > 1) throw invalid('此问题只能选择一个答案');
    if (!q.allowCustom && values.some((s) => !q.options.some((o) => o.value === s))) throw invalid('请选择有效选项');
    result[q.id] = values;
  }
  return result;
}
function decision(body) {
  if (!['accept', 'decline'].includes(body.decision)) throw invalid('请选择允许或拒绝');
  return body.decision === 'accept';
}

/** 返回原协议的回复，不把历史工具记录当作仍然有效的请求。 */
export function claudeInteraction(record, send, readOnly = false) {
  const req = record.request;
  if (req?.subtype !== 'can_use_tool') return null;
  const respond = (response) => send({ type: 'control_response', response: {
    subtype: 'success', request_id: record.request_id, response,
  } });
  if (req.tool_name === 'AskUserQuestion') {
    const view = { kind: 'questions', title: '需要你做个选择', questions: questions(req.input?.questions, 'claude') };
    return { id: record.request_id, view, respond: async (body) => {
      if (body.cancel) return respond({ behavior: 'deny', message: '用户取消了问题' });
      const answers = readAnswers(view, body), byQuestion = {};
      view.questions.forEach((q) => { byQuestion[q.question] = answers[q.id].join(', '); });
      return respond({ behavior: 'allow', updatedInput: { ...req.input, answers: byQuestion } });
    } };
  }
  if (req.requires_user_interaction) {
    return { id: record.request_id, view: { kind: 'approval', cancelRun: true,
      title: '此操作需要专用交互界面', description: '可以取消本轮后，在原始终端中处理。',
      choices: [{ id: 'cancel', label: '取消本轮' }],
    }, respond: () => { throw invalid('此交互不支持普通允许按钮，请取消本轮后使用原始终端'); } };
  }
  const view = {
    kind: 'approval', title: `是否允许 ${req.tool_name || '这次操作'}？`,
    description: JSON.stringify(req.input || {}, null, 2),
    choices: readOnly ? approvals.filter((c) => c.id === 'decline') : approvals,
  };
  return { id: record.request_id, view, respond: (body) => {
    const allow = !body.cancel && decision(body);
    if (allow && readOnly) throw invalid('只读模式不能批准工具权限');
    return respond(allow ? { behavior: 'allow', updatedInput: req.input || {} }
      : { behavior: 'deny', message: '用户拒绝了本次操作' });
  } };
}

export function piInteraction(record, send) {
  if (!['select', 'confirm', 'input', 'editor'].includes(record.method)) return null;
  const confirm = record.method === 'confirm';
  const view = confirm ? {
    kind: 'approval', title: record.title || '请确认', description: record.message || '',
    choices: [{ id: 'accept', label: '确认' }, { id: 'decline', label: '取消' }],
  } : {
    kind: 'questions', title: record.title || '需要你的回答',
    questions: [{ id: 'answer', question: record.title || record.placeholder || '请输入',
      options: options(record.options), multiSelect: false, allowCustom: record.method !== 'select',
      prefill: record.prefill || '', multiline: record.method === 'editor' }],
  };
  return { id: record.id, view, respond: (body) => {
    const response = { type: 'extension_ui_response', id: record.id };
    if (body.cancel) response.cancelled = true;
    else if (confirm) response.confirmed = decision(body);
    else response.value = readAnswers(view, body).answer[0];
    return send(response);
  } };
}

/** OMP rpc-ui：保留每个选项的原值，显示层去掉终端颜色码；多选字段通过原生逐项切换协议回传。 */
export function ompInteraction(record, send) {
  const clean = (text) => String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (record.method === 'ask') {
    const view = { kind: 'questions', title: '需要你做个选择', questions: (record.questions || []).map((q) => ({
      id: q.id, question: clean(q.question), header: clean(q.header), multiSelect: !!q.multi, allowCustom: true,
      options: (q.options || []).map((o) => ({ label: clean(o.label), value: o.label, description: clean(o.description) })),
    })) };
    return { id: record.id, view, respond: (body) => {
      if (body.cancel) return send({ type: 'extension_ui_response', id: record.id, cancelled: true });
      const values = readAnswers(view, body);
      const answers = view.questions.map((q) => {
        const selectedOptions = values[q.id].filter((v) => q.options.some((o) => o.value === v));
        const custom = values[q.id].filter((v) => !q.options.some((o) => o.value === v));
        if (new Set(selectedOptions).size !== selectedOptions.length || custom.length > 1) throw invalid('答案重复或自定义回答过多');
        return { id: q.id, selectedOptions, ...(custom.length ? { customInput: custom[0] } : {}) };
      });
      return send({ type: 'extension_ui_response', id: record.id, answers });
    } };
  }
  if (record.method === 'select' && record.selectionMarker === 'checkbox') {
    const count = record.markableCount ?? record.options.length;
    const view = { kind: 'choices', title: '请勾选需要的选项', description: clean(record.title),
      choices: record.options.map((option, i) => ({ id: String(i),
        label: i < count ? `${record.checkedIndices?.includes(i) ? '☑' : '☐'} ${clean(option)}` : clean(option).replace(/^.*Done selecting$/, '完成选择'),
      })).concat({ id: 'cancel', label: '取消问题', danger: true }) };
    return { id: record.id, view, respond: (body) => {
      if (body.cancel || body.decision === 'cancel') return send({ type: 'extension_ui_response', id: record.id, cancelled: true });
      const index = record.options.findIndex((_, i) => String(i) === body.decision);
      if (index < 0) throw invalid('请选择有效选项');
      return send({ type: 'extension_ui_response', id: record.id, value: record.options[index] });
    } };
  }
  const interaction = piInteraction(record, send);
  if (!interaction) return null;
  interaction.view.title = clean(interaction.view.title);
  if (interaction.view.description) interaction.view.description = clean(interaction.view.description);
  for (const q of interaction.view.questions || []) {
    q.question = clean(q.question); q.secret = !!record.secret;
    q.options = q.options.map((o, i) => ({ ...o, label: clean(o.label), description: clean(record.optionDetails?.[i]?.description) }));
  }
  return interaction;
}

export function codexInteraction(record, send, readOnly = false) {
  const p = record.params || {};
  const respond = (result) => send({ id: record.id, result });
  if (record.method === 'item/tool/requestUserInput') {
    const view = { kind: 'questions', title: '需要你做个选择', cancelRun: true, questions: questions(p.questions, 'codex') };
    return { id: record.id, blocking: p.isBlocking !== false, view, respond: (body) => {
      if (body.cancel) throw invalid('请使用取消本轮结束此请求');
      const answers = readAnswers(view, body);
      return respond({ answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { answers: value }])) });
    } };
  }
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(record.method)) {
    const permissionRequest = record.method === 'item/permissions/requestApproval';
    const allowedChoices = readOnly ? approvals.filter((c) => c.id === 'decline') : approvals;
    const choices = Array.isArray(p.availableDecisions) ? allowedChoices.filter((c) => p.availableDecisions.includes(c.id)) : allowedChoices;
    const view = {
      kind: 'approval', title: permissionRequest ? '是否授予本轮请求的权限？' : record.method.includes('fileChange') ? '是否允许这些文件改动？' : '是否允许执行此命令？',
      description: [p.reason, p.command, p.cwd, p.changeDescription, permissionRequest ? JSON.stringify(p.permissions, null, 2) : ''].filter(Boolean).join('\n'),
      choices: choices.length ? choices : [{ id: 'cancel', label: '取消本轮' }], cancelRun: !choices.length,
    };
    return { id: record.id, view, respond: (body) => {
      const allow = !body.cancel && decision(body);
      if (allow && readOnly) throw invalid('只读模式不能扩大执行权限');
      if (!choices.some((c) => c.id === (allow ? 'accept' : 'decline'))) throw invalid('该请求不接受此决定');
      return respond(permissionRequest ? { permissions: allow ? p.permissions : {}, scope: 'turn' }
        : { decision: allow ? 'accept' : 'decline' });
    } };
  }
  if (record.method === 'mcpServer/elicitation/request') {
    // URL 与任意 JSON Schema 交互先给出可取消说明，不能虚构已经完成外部授权。
    const view = { kind: 'approval', title: '工具需要额外交互',
      description: `${p.message || '该工具的外部交互暂不支持在工作轨迹中完成。'}\n可取消本次请求后改用原始终端处理。`,
      choices: [{ id: 'decline', label: '取消本次请求' }],
    };
    return { id: record.id, view, respond: () => respond({ action: 'cancel', content: null, _meta: null }) };
  }
  return null;
}
