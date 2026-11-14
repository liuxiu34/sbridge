import { CliProcess } from './cli-process.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { sessionsRoot as claudeSessionsRoot, encodeCwd } from './claude.mjs';
import { claudeInteraction, piInteraction, codexInteraction, ompInteraction } from './interaction-protocol.mjs';

/** 每轮重建 CLI，仍恢复原会话；模型、权限、思考深度因此不会留在旧进程中。 */
export function createExecutionDriver(hooks, { makeProcess = (tool, args, opts) => new CliProcess(tool, args, opts) } = {}) {
  const { node, message, runId, onComplete, onRequest, onRequestCanceled, onSession } = hooks;
  let transport, stopped = false, finished = false, seq = 0, lastError = '', turnId = null;
  let ompConfigDir, ompPromptId, ompOutcome, ompSettled = false, ompCompleting = false;
  const pending = new Map();
  const fileChanges = new Map();
  const send = (record) => {
    if (stopped || !transport) return Promise.reject(new Error('执行已经停止'));
    return transport.write(record);
  };
  const complete = (outcome) => { if (!finished && !stopped) { finished = true; onComplete(outcome); } };
  const request = (method, params = {}, timeoutMs = 45_000) => {
    const id = `${runId}-${++seq}`;
    if (node.tool === 'omp' && method === 'prompt') ompPromptId = id;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(new Error(`${method} 未在 ${timeoutMs / 1000} 秒内响应`)); }, timeoutMs) : null;
      pending.set(id, { resolve, reject, timer });
      const data = node.tool === 'codex' ? { id, method, params }
        : node.tool === 'claude' ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } }
          : { id, type: method, ...params };
      send(data).catch((error) => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
  };
  const settleReply = (id, value, error) => {
    const p = pending.get(String(id)); if (!p) return;
    clearTimeout(p.timer); pending.delete(String(id));
    if (error) p.reject(new Error(typeof error === 'string' ? error : error.message || JSON.stringify(error)));
    else p.resolve(value);
  };
  const ompSession = (state) => { if (state?.sessionId || state?.sessionFile) onSession({ id: state.sessionId, file: state.sessionFile }); };
  const completeOmp = () => {
    if (!ompOutcome || !ompSettled || ompCompleting || stopped) return;
    ompCompleting = true;
    // 新会话可能在第一次模型回合后才生成文件；结束前同步，保证轨迹和下轮恢复使用同一文件。
    void request('get_state').then((state) => {
      ompSession(state);
      if (state?.isSettled === false) { ompSettled = false; ompCompleting = false; return; }
      complete(lastError ? { exitCode: 1, stderrTail: lastError } : ompOutcome);
    }).catch((error) => complete({ exitCode: -1, stderrTail: error.message }));
  };
  const onRecord = (rec) => {
    if (stopped) return;
    if (node.tool === 'codex') {
      if (rec.id != null && !rec.method) { settleReply(rec.id, rec.result, rec.error); return; }
      if (rec.id != null && rec.method) {
        const detail = fileChanges.get(rec.params?.itemId);
        const enriched = detail ? { ...rec, params: { ...rec.params, changeDescription: detail } } : rec;
        const interaction = codexInteraction(enriched, send, node.perm === 'ro');
        if (interaction) onRequest(interaction);
        else void send({ id: rec.id, error: { code: -32601, message: `sbridge 暂不支持此交互：${rec.method}` } }).catch((e) => complete({ exitCode: -1, stderrTail: e.message }));
        return;
      }
      if (['item/started', 'item/completed'].includes(rec.method) && rec.params?.item?.type === 'fileChange') {
        const item = rec.params.item;
        fileChanges.set(item.id, (item.changes || []).map((c) => `${c.path}\n${c.diff || ''}`).join('\n').slice(0, 20_000));
      }
      if (rec.method === 'turn/started') {
        turnId = rec.params?.turn?.id || turnId;
        finished = false;
        hooks.onTurnStarted?.();
      }
      if (rec.method === 'turn/completed') {
        const turn = rec.params?.turn;
        if (!turnId || turn?.id === turnId) complete({ exitCode: turn?.status === 'completed' ? 0 : -1,
          canceled: turn?.status === 'interrupted', stderrTail: turn?.error?.message || '' });
      }
      if (rec.method === 'serverRequest/resolved') onRequestCanceled(rec.params?.requestId);
      if (rec.method === 'error' && !rec.params?.willRetry) complete({ exitCode: -1, stderrTail: rec.params?.error?.message || 'Codex 执行失败' });
    } else if (node.tool === 'claude') {
      if (rec.type === 'control_response') {
        settleReply(rec.response?.request_id, rec.response?.response,
          rec.response?.subtype === 'error' ? rec.response.error || 'Claude 控制请求失败' : null);
      } else if (rec.type === 'control_request') {
        const interaction = claudeInteraction(rec, send, node.perm === 'ro');
        if (interaction) onRequest(interaction);
        else void send({ type: 'control_response', response: { subtype: 'error', request_id: rec.request_id,
          error: 'sbridge 暂不支持此控制请求' } }).catch((e) => complete({ exitCode: -1, stderrTail: e.message }));
      } else if (rec.type === 'control_cancel_request') onRequestCanceled(rec.request_id);
      else if (rec.type === 'system' && rec.subtype === 'init' && rec.session_id) onSession({ id: rec.session_id,
        file: node.file || path.join(claudeSessionsRoot(), encodeCwd(node.cwd), `${rec.session_id}.jsonl`) });
      else if (rec.type === 'result') complete({ exitCode: rec.is_error ? 1 : 0,
        stderrTail: rec.is_error ? String(rec.result || rec.errors?.join('\n') || 'Claude 执行失败') : '' });
    } else if (node.tool === 'omp') {
      if (rec.type === 'response') {
        settleReply(rec.id, rec.data, rec.success === false ? rec.error || 'OMP 请求失败' : null);
        if (rec.id === ompPromptId && rec.success && rec.data?.agentInvoked === false) {
          ompOutcome = { exitCode: 0 }; ompSettled = true; completeOmp();
        }
      } else if (rec.type === 'extension_ui_request') {
        if (rec.method === 'cancel') onRequestCanceled(rec.targetId);
        else { const interaction = ompInteraction(rec, send); if (interaction) onRequest(interaction); }
      } else if (rec.type === 'agent_start') {
        ompSettled = false; hooks.onTurnStarted?.();
      } else if (rec.type === 'message_end' && rec.message?.role === 'assistant') {
        lastError = rec.message.stopReason === 'error' ? rec.message.errorMessage || 'OMP 执行失败' : '';
      } else if (rec.type === 'prompt_result' && rec.id === ompPromptId) {
        ompOutcome = { exitCode: rec.status === 'completed' ? 0 : rec.status === 'aborted' ? -2 : 1,
          canceled: rec.status === 'aborted', stderrTail: rec.error?.message || '' };
        ompSettled = ompSettled || rec.sessionSettled === true;
        completeOmp();
      } else if (rec.type === 'session_settled') { ompSettled = true; completeOmp(); }
    } else if (node.tool === 'pi') {
      if (rec.type === 'response') {
        settleReply(rec.id, rec.data, rec.success === false ? rec.error || 'Pi 请求失败' : null);
        if (rec.command === 'prompt' && rec.success && rec.data?.disposition === 'handled') complete({ exitCode: 0 });
      } else if (rec.type === 'extension_ui_request') {
        const interaction = piInteraction(rec, send); if (interaction) onRequest(interaction);
      } else if (rec.type === 'extension_ui_cancel') onRequestCanceled(rec.id);
      else if (rec.type === 'message_end' && rec.message?.role === 'assistant') {
        lastError = rec.message.stopReason === 'error' ? rec.message.errorMessage || 'Pi 执行失败' : '';
      } else if (rec.type === 'agent_settled') complete({ exitCode: rec.aborted ? -2 : lastError ? 1 : 0, canceled: !!rec.aborted, stderrTail: lastError });
    }
  };
  const args = [];
  if (node.tool === 'codex') args.push('app-server');
  else if (node.tool === 'claude') {
    args.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio');
    if (node.sessionId) args.push('--resume', node.sessionId);
    if (node.perm === 'yolo') args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', node.perm === 'ro' ? 'plan' : 'acceptEdits');
    if (node.perm === 'ro') args.push('--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,Bash,Task,Agent');
  } else if (node.tool === 'pi') {
    args.push('--mode', 'rpc');
    if (node.file && !node.file.startsWith('sqlite:')) args.push('--session', node.file);
    else if (node.sessionId) args.push('--session', node.sessionId);
    if (node.modelProvider) args.push('--provider', node.modelProvider);
  } else if (node.tool === 'omp') {
    args.push('--mode', 'rpc-ui');
    if (node.file && !node.file.startsWith('sqlite:')) args.push('--resume', node.file);
    else if (node.sessionId) args.push('--resume', node.sessionId);
    if (node.modelProvider) args.push('--provider', node.modelProvider);
    if (node.perm === 'yolo') args.push('--auto-approve');
  } else throw new Error('未知工具');
  if (node.tool !== 'codex') {
    if (node.model) args.push('--model', node.model);
    if (node.effort) args.push(node.tool === 'claude' ? '--effort' : '--thinking', node.effort);
  }
  return {
    async start() {
      if (stopped) throw new Error('执行已经停止');
      if (node.tool === 'omp') {
        // 工作轨迹里的决定必须由用户提交，不能沿用 OMP 的超时自动选默认答案；只覆盖本轮，不改全局配置。
        ompConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-omp-config-'));
        const configFile = path.join(ompConfigDir, 'workflow.yml');
        fs.writeFileSync(configFile, 'ask:\n  timeout: 0\n', 'utf8');
        args.push('--config', configFile);
      }
      transport = makeProcess(node.tool, args, { cwd: node.cwd, onRecord, onExit: (outcome) => {
        for (const [id] of pending) settleReply(id, null, outcome.stderrTail || 'CLI 已退出');
        if (!stopped) { finished = false; complete({ ...outcome, exitCode: outcome.exitCode === 0 ? -1 : outcome.exitCode,
          stderrTail: outcome.stderrTail || 'CLI 在回合完成前退出' });
        }
      } });
      if (node.tool === 'codex') {
        await request('initialize', { clientInfo: { name: 'sbridge', version: '1.2.4' }, capabilities: { experimentalApi: true } });
        await send({ method: 'initialized', params: {} });
        const config = { cwd: node.cwd, sandbox: node.perm === 'ro' ? 'read-only' : node.perm === 'yolo' ? 'danger-full-access' : 'workspace-write',
          approvalPolicy: node.perm === 'ro' || node.perm === 'yolo' ? 'never' : 'on-request', approvalsReviewer: 'user' };
        if (node.model) config.model = node.model;
        if (node.modelProvider) config.modelProvider = node.modelProvider;
        const loaded = await request(node.sessionId ? 'thread/resume' : 'thread/start', {
          ...config, ...(node.sessionId ? { threadId: node.sessionId, excludeTurns: true } : {}),
        });
        const threadId = loaded.thread.id;
        onSession({ id: threadId, file: loaded.thread.path || undefined });
        const response = await request('turn/start', { threadId, input: [{ type: 'text', text: message, text_elements: [] }], ...(node.effort ? { effort: node.effort } : {}) });
        turnId = response.turn?.id || turnId;
      } else if (node.tool === 'claude') {
        await request('initialize');
        await send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: message }] } });
      } else if (node.tool === 'pi') {
        const state = await request('get_state');
        if (state?.sessionId || state?.sessionFile) onSession({ id: state.sessionId, file: state.sessionFile });
        await request('prompt', { message });
      } else if (node.tool === 'omp') {
        ompSession(await request('get_state'));
        await request('set_ask_dialog', { enabled: true });
        // 扩展的 input 钩子也可能等用户回答；等待期间由执行管理器负责取消，不能被 45 秒控制请求超时误杀。
        await request('prompt', { message }, 0);
      }
    },
    async steer(text) {
      if (node.tool !== 'pi' || finished) throw new Error('该执行不支持运行中引导');
      await request('steer', { message: text });
    },
    async stop() {
      stopped = true;
      for (const [id] of pending) settleReply(id, null, '执行已经停止');
      try { await transport?.stop(); }
      finally {
        if (ompConfigDir) {
          try { fs.unlinkSync(path.join(ompConfigDir, 'workflow.yml')); fs.rmdirSync(ompConfigDir); } catch { /* 仅清理本轮创建的文件 */ }
          ompConfigDir = null;
        }
      }
    },
  };
}
