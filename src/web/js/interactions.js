/* 待处理交互只取当前运行的请求，不从历史消息推断审批。 */
function createInteractionPanel(host, { taskId, nodeId, onAnswered }) {
  let signature = '', disposed = false;
  const drafts = new Map();
  const storageKey = `sbridge-interaction-drafts:${taskId}:${nodeId}`;
  try {
    for (const [key, value] of JSON.parse(sessionStorage.getItem(storageKey) || '[]')) drafts.set(key, value);
  } catch { /* 无草稿 */ }
  const persist = () => {
    try { sessionStorage.setItem(storageKey, JSON.stringify([...drafts.entries()])); } catch { /* 无存储权限时仍可回答 */ }
  };
  function render(requests) {
    if (disposed) return;
    const next = JSON.stringify(requests);
    if (next === signature) return;
    signature = next;
    host.replaceChildren();
    host.hidden = !requests.length;
    const live = new Set(requests.map((r) => `${r.runId}:${typeof r.id}:${r.id}`));
    for (const key of drafts.keys()) if (!live.has(key)) drafts.delete(key);
    persist();
    requests.forEach((request, ri) => {
      const key = `${request.runId}:${typeof request.id}:${request.id}`;
      const card = document.createElement('form');
      card.className = 'interaction-card' + (request.kind === 'choices' ? ' is-choice-list' : '');
      card.setAttribute('aria-label', request.title || '待回答问题');
      const qs = request.questions || [];
      card.innerHTML = `<div class="interaction-heading"><span class="interaction-dot"></span><strong>${escapeHtml(request.title || '需要你的回答')}</strong></div>`
        + (request.description ? `<pre class="interaction-description">${escapeHtml(request.description)}</pre>` : '')
        + qs.map((q, qi) => `<fieldset data-question="${qi}"><legend>${escapeHtml(q.question)}</legend>`
          + (q.options || []).map((o, oi) => `<label class="interaction-option"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q-${ri}-${qi}" data-option="${oi}"><span><b>${escapeHtml(o.label)}</b>${o.description ? `<small>${escapeHtml(o.description)}</small>` : ''}</span></label>`).join('')
          + (q.allowCustom ? `<label class="interaction-custom"><span>${q.options?.length ? '也可以填写自己的回答' : '你的回答'}</span>${q.multiline
            ? `<textarea rows="3" data-custom placeholder="${escapeHtml(q.prefill || '请输入回答')}"></textarea>`
            : `<input type="${q.secret ? 'password' : 'text'}" data-custom autocomplete="off" placeholder="请输入回答">`}</label>` : '')
          + '</fieldset>').join('')
        + '<div class="interaction-error" role="alert" hidden></div><div class="interaction-footer">'
        + (request.kind === 'approval' || request.kind === 'choices'
          ? (request.choices || []).map((choice) => `<button type="button" data-decision="${escapeHtml(choice.id)}" class="${choice.danger ? 'danger' : choice.id === 'accept' ? 'primary' : ''}">${escapeHtml(choice.label)}</button>`).join('')
          : `<button type="button" data-cancel>${request.cancelRun ? '取消本轮' : '取消问题'}</button><button type="submit" class="primary">提交回答</button>`)
        + '</div>';
      host.appendChild(card);
      const readDraft = () => qs.map((q, qi) => {
        const field = card.querySelector(`[data-question="${qi}"]`);
        return {
          options: [...field.querySelectorAll('[data-option]:checked')].map((el) => Number(el.dataset.option)),
          text: field.querySelector('[data-custom]')?.value || '',
        };
      });
      const draft = drafts.get(key);
      qs.forEach((q, qi) => {
        const field = card.querySelector(`[data-question="${qi}"]`), value = draft?.[qi];
        if (value) {
          field.querySelectorAll('[data-option]').forEach((el) => { el.checked = value.options?.includes(Number(el.dataset.option)); });
        }
        const custom = field.querySelector('[data-custom]');
        if (custom) custom.value = value?.text || q.prefill || '';
      });
      card.addEventListener('input', (event) => {
        const field = event.target.closest('fieldset');
        const q = field ? qs[Number(field.dataset.question)] : null;
        if (q && !q.multiSelect) {
          if (event.target.matches('[data-custom]') && event.target.value) field.querySelectorAll('[data-option]').forEach((el) => { el.checked = false; });
          else if (event.target.matches('[data-option]')) { const custom = field.querySelector('[data-custom]'); if (custom) custom.value = ''; }
        }
        if (!qs.some((q) => q.secret)) { drafts.set(key, readDraft()); persist(); }
      });
      let busy = false;
      const submit = async (extra = {}) => {
        if (busy || disposed) return;
        const answers = {};
        if (request.kind !== 'approval' && !extra.cancel) {
          const current = readDraft();
          qs.forEach((q, qi) => {
            const values = current[qi].options.map((i) => q.options[i].value);
            if (current[qi].text.trim()) values.push(current[qi].text.trim());
            answers[q.id] = values;
          });
          if (qs.some((q) => !answers[q.id].length)) {
            const error = card.querySelector('.interaction-error'); error.textContent = '请回答所有问题后再提交'; error.hidden = false; return;
          }
        }
        busy = true;
        card.querySelectorAll('button,input,textarea').forEach((el) => { el.disabled = true; });
        try {
          const cancelRun = request.cancelRun && (extra.cancel || extra.decision === 'cancel');
          await api(`/api/tasks/${taskId}/nodes/${nodeId}/${cancelRun ? 'cancel-headless' : 'answer'}`, { method: 'POST', body: {
            runId: request.runId, interactionId: request.id, answers, ...extra,
          } });
          drafts.delete(key); persist();
          card.remove(); host.hidden = !host.children.length;
          signature = ''; onAnswered();
        } catch (err) {
          const error = card.querySelector('.interaction-error'); error.textContent = err.message; error.hidden = false;
          card.querySelectorAll('button,input,textarea').forEach((el) => { el.disabled = false; });
        } finally { busy = false; }
      };
      card.addEventListener('submit', (e) => { e.preventDefault(); void submit(); });
      card.querySelector('[data-cancel]')?.addEventListener('click', () => submit({ cancel: true }));
      card.querySelectorAll('[data-decision]').forEach((btn) => btn.addEventListener('click', () => submit({ decision: btn.dataset.decision })));
      // 中文候选确认不应提交问题表单。
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) e.preventDefault(); });
    });
  }
  return { render, dispose() { disposed = true; host.replaceChildren(); } };
}
