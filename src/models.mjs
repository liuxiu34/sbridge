import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* 模型目录：直接读各 CLI 自己的配置，避免硬编码模型名。
   - Claude：~/.claude/settings.json 的 modelPicker.options（终端 /model 用的就是这份）
   - Codex ：~/.codex/models_cache.json（models[].slug/display_name）+ config.toml 的默认 model
   - Pi    ：~/.pi/agent/models.json 的 providers[].models[] + settings.json 的默认模型 */

const HOME = os.homedir();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

export function listModels(tool) {
  if (tool === 'claude') {
    const s = readJson(path.join(HOME, '.claude', 'settings.json')) || {};
    const options = (s.modelPicker?.options || [])
      .filter((o) => o && o.model)
      .map((o) => ({ id: String(o.model), label: String(o.label || o.model), note: String(o.description || '') }));
    if (s.model && !options.some((o) => o.id === s.model)) {
      options.unshift({ id: String(s.model), label: String(s.model), note: '默认模型' });
    }
    return { options, configModel: s.model ? String(s.model) : '' };
  }

  if (tool === 'codex') {
    const cfg = readText(path.join(HOME, '.codex', 'config.toml'));
    const hit = cfg.match(/^\s*model\s*=\s*"([^"]+)"/m);
    const configModel = hit ? hit[1] : '';
    const cache = readJson(path.join(HOME, '.codex', 'models_cache.json')) || {};
    const options = (cache.models || [])
      .filter((m) => m && m.slug && m.visibility !== 'hide')
      .map((m) => ({ id: String(m.slug), label: String(m.display_name || m.slug), note: String(m.description || '') }));
    if (configModel && !options.some((o) => o.id === configModel)) {
      options.unshift({ id: configModel, label: configModel, note: 'config.toml 默认' });
    }
    return { options, configModel };
  }

  if (tool === 'pi') {
    const models = readJson(path.join(HOME, '.pi', 'agent', 'models.json')) || {};
    const settings = readJson(path.join(HOME, '.pi', 'agent', 'settings.json')) || {};
    const options = [];
    for (const [provider, v] of Object.entries(models.providers || {})) {
      for (const m of (v.models || [])) {
        if (!m || !m.id) continue;
        options.push({
          id: String(m.id), provider, label: String(m.name || m.id), note: provider,
          contextWindow: m.contextWindow || null,
        });
      }
    }
    const configModel = settings.defaultModel
      ? String(settings.defaultModel).includes('/') ? String(settings.defaultModel) : `${settings.defaultProvider || ''}/${settings.defaultModel}`
      : '';
    return { options, configModel };
  }

  if (tool === 'omp') {
    // models.yml 只读我们关心的两层：providers.<name>.models[].{id,name}
    const text = readText(path.join(HOME, '.omp', 'agent', 'models.yml'));
    const options = [];
    let provider = '';
    for (const line of text.split('\n')) {
      const p = line.match(/^\s{2}([\w.@-]+):\s*$/);
      if (p) { provider = p[1]; continue; }
      const id = line.match(/^\s*-\s*id:\s*(.+?)\s*$/);
      if (id) { options.push({ id: id[1].replace(/^["']|["']$/g, ''), provider, label: '', note: provider }); continue; }
      const nm = line.match(/^\s+name:\s*(.+?)\s*$/);
      if (nm && options.length && !options[options.length - 1].label) {
        options[options.length - 1].label = nm[1].replace(/^["']|["']$/g, '');
      }
    }
    for (const o of options) if (!o.label) o.label = o.id;
    // 默认角色（config.yml 的 modelRoles.default）优先，别把没配额的那个当默认
    const conf = readText(path.join(HOME, '.omp', 'agent', 'config.yml'));
    const hit = conf.match(/^\s*default:\s*(\S+)\s*$/m);
    const configModel = hit ? hit[1] : (options[0] ? `${options[0].provider}/${options[0].id}` : '');
    if (configModel) {
      const full = options.find((o) => `${o.provider}/${o.id}` === configModel);
      if (full) options.splice(options.indexOf(full), 1), options.unshift(full);
    }
    return { options, configModel };
  }

  return { options: [], configModel: '' };
}

/** 从会话文件尾部反查这个会话实际在用的模型（终端里 /model 切换后会写进文件） */
export function detectSessionModel(node) {
  try {
    const file = node?.file;
    if (!file || String(file).startsWith('sqlite:')) return null;
    const st = fs.statSync(file);
    if (!st.size) return null;
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len)); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');
    // omp 的 model_change 里直接是 "provider/model" 字符串，优先取它
    const change = [...text.matchAll(/"type"\s*:\s*"model_change"[\s\S]{0,300}?"model"\s*:\s*"([^"]+)"/g)].pop();
    if (change) return change[1];
    const picks = [...text.matchAll(/"(?:model|modelId)"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
    if (!picks.length) return null;
    const last = picks[picks.length - 1];
    // pi 的 model_change 记录带 provider，优先用它拼出 provider/model
    const prov = [...text.matchAll(/"type"\s*:\s*"model_change"[\s\S]{0,200}?"provider"\s*:\s*"([^"]+)"/g)].pop();
    if (prov && !last.includes('/')) return `${prov[1]}/${last}`;
    return last;
  } catch { return null; }
}

/** 给 CLI 追加模型参数（无头执行与终端启动共用） */
export function modelFlags(tool, model, provider) {
  const m = String(model || '').trim();
  if (!m) return '';
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  if (tool === 'claude') return ` --model ${q(m)}`;
  if (tool === 'codex') return ` --model ${q(m)}`;
  if (tool === 'pi') return provider ? ` --provider ${q(provider)} --model ${q(m)}` : ` --model ${q(m)}`;
  if (tool === 'omp') return ` --model ${q(m)}`;
  return '';
}
