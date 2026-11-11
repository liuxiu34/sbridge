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
      .map((m) => ({
        id: String(m.slug),
        label: String(m.display_name || m.slug),
        note: String(m.description || ''),
        vision: (m.input_modalities || []).some((x) => String(x).toLowerCase().includes('image')),
      }));
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
          vision: Array.isArray(m.input) ? m.input.includes('image') : undefined,
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

/* ---------------- 思考深度（reasoning effort） ----------------
   四个工具都能设，但入口不一样：
   - Claude Code：--effort / 运行中 /effort
   - Codex     ：-c model_reasoning_effort=… / 没有斜杠命令，要重开终端
   - Pi        ：--thinking / 运行中 /thinking
   - OMP       ：--thinking= / 运行中 /effort
   档位不是固定的：Codex 按模型（models_cache.json），Pi 按模型的 thinkingLevelMap，
   OMP / Claude 用通用档位。 */

const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const EFFORT_LABELS = {
  off: '关', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: '极限', auto: '自动',
};
const PI_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const OMP_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_FALLBACK = ['low', 'medium', 'high', 'xhigh'];

const stripQ = (s) => String(s || '').replace(/^["']|["']$/g, '');

/** Pi 的模型条目（含 reasoning / thinkingLevelMap） */
function findPiModel(model, provider) {
  const j = readJson(path.join(HOME, '.pi', 'agent', 'models.json')) || {};
  let found = null;
  for (const [pname, v] of Object.entries(j.providers || {})) {
    for (const m of (v.models || [])) {
      if (!m || m.id !== model) continue;
      if (provider && pname !== provider) { found = found || m; continue; }
      return m;
    }
  }
  return found;
}

/** OMP 的 models.yml 里这个模型有没有写 reasoning: false */
function ompModelReasoning(model) {
  const text = readText(path.join(HOME, '.omp', 'agent', 'models.yml'));
  const blocks = text.split(/\n(?=\s*-\s*id:)/);
  const b = blocks.find((x) => stripQ(x.match(/^\s*-\s*id:\s*(.+)$/m)?.[1]) === model);
  if (!b) return true;
  return !/^\s*reasoning:\s*false\s*$/m.test(b);
}

/**
 * 某工具 + 某个模型支持哪些思考深度。
 * @returns {{supported: boolean, defaultLevel: string, levels: {id: string, label: string}[]}}
 */
export function effortOptions(tool, model, provider) {
  const mk = (levels, defaultLevel = '') => {
    const ordered = [
      ...EFFORT_ORDER.filter((id) => levels.includes(id)),
      ...(levels.includes('auto') ? ['auto'] : []),
    ];
    return {
      supported: ordered.length > 0,
      defaultLevel,
      levels: ordered.map((id) => ({ id, label: EFFORT_LABELS[id] || id })),
    };
  };

  if (tool === 'claude') return mk(CLAUDE_EFFORTS);

  if (tool === 'pi') {
    const m = findPiModel(model, provider);
    if (m && m.reasoning === false) return mk([]);
    // 低/中/高恒给（网关普遍支持，用户也默认有「中」）；模型 thinkingLevelMap
    // 里显式映射了的档位（off/minimal/xhigh/max…）再补进来。null = 目录里没映射，不硬塞。
    const levels = new Set(['low', 'medium', 'high']);
    if (m?.thinkingLevelMap && typeof m.thinkingLevelMap === 'object') {
      for (const [k, v] of Object.entries(m.thinkingLevelMap)) {
        if (v != null && PI_EFFORTS.includes(k)) levels.add(k);
      }
    }
    return mk(PI_EFFORTS.filter((id) => levels.has(id)));
  }

  if (tool === 'omp') return ompModelReasoning(model) ? mk(OMP_EFFORTS) : mk([]);

  if (tool === 'codex') {
    const cfg = readText(path.join(HOME, '.codex', 'config.toml'));
    const configModel = cfg.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || '';
    const cache = readJson(path.join(HOME, '.codex', 'models_cache.json')) || {};
    const list = cache.models || [];
    const m = list.find((x) => x && x.slug === model) || list.find((x) => x && x.slug === configModel);
    if (!m) return mk(CODEX_FALLBACK);
    const levels = (m.supported_reasoning_levels || []).map((x) => String(x?.effort || '')).filter(Boolean);
    return mk(levels.length ? levels : CODEX_FALLBACK, m.default_reasoning_level || '');
  }

  return mk([]);
}

/** 启动参数：把思考深度带给 CLI */
export function effortFlags(tool, level) {
  const l = String(level || '').trim();
  if (!l) return '';
  if (tool === 'claude') return ` --effort ${l}`;
  if (tool === 'codex') return ` -c model_reasoning_effort="${l}"`;
  if (tool === 'pi') return ` --thinking ${l}`;
  if (tool === 'omp') return ` --thinking=${l}`;
  return '';
}

/** 运行中的终端用什么斜杠命令切；Codex 没有斜杠命令，只能重开终端 */
export function effortSlash(tool, level) {
  const l = String(level || '').trim();
  if (!l) return '';
  if (tool === 'pi') return `/thinking ${l}`;
  if (tool === 'omp' || tool === 'claude') return `/effort ${l}`;
  return '';
}
