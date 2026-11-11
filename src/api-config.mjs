import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* API / provider 配置：只接管 Pi 和 OMP 的模型接入配置。
   Claude Code、Codex 走各自订阅登录，这里不碰，避免把用户账号配置搞乱。 */

export const SUPPORTED_TOOLS = ['pi', 'omp'];

const HOME = os.homedir();
const PI_MODELS = path.join(HOME, '.pi', 'agent', 'models.json');
const PI_SETTINGS = path.join(HOME, '.pi', 'agent', 'settings.json');
const OMP_MODELS = path.join(HOME, '.omp', 'agent', 'models.yml');
const OMP_CONFIG = path.join(HOME, '.omp', 'agent', 'config.yml');

const API_OPTIONS = ['anthropic-messages', 'openai-completions', 'openai-responses'];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
/** 写文件前留一份 .bak，改坏了还能手工还原 */
function backup(file) {
  try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch { /* ignore */ }
}
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, text);
}

/* ---------------- 极简 YAML（只覆盖 omp 的 models.yml 结构） ---------------- */
function stripQuotes(v) {
  const t = String(v).trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  if (/^(true|false)$/.test(t)) return t === 'true';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^(null|~)$/.test(t)) return '';
  return t;
}
const BOOL_KEYS = /^(supportsTools|reasoning|omitMaxOutputTokens|preferWebsockets)$/;
const NUM_KEYS = /^(contextWindow|maxContextWindow|maxTokens|premiumMultiplier|imageCountBudget)$/;
function emitValue(key, v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (BOOL_KEYS.test(key) && /^(true|false)$/i.test(s)) return s.toLowerCase();
  if (NUM_KEYS.test(key) && /^-?\d+(\.\d+)?$/.test(s)) return s;
  return scalar(s);
}
function scalar(v) {
  if (v === '' || v === null || v === undefined) return '""';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  // 纯字母数字/下划线/点/斜杠/短横/冒号开头的 URL 可以裸写，其余加引号
  if (/^[A-Za-z0-9_./:@-]+$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s) && !/^-?\d/.test(s)) return s;
  return JSON.stringify(s);
}
function parseYamlModels(text) {
  const providers = [];
  let prov = null;
  let inModels = false;
  let model = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    if (/^providers:\s*$/.test(line)) continue;
    if (indent <= 2 && /^[\w.@-]+:\s*$/.test(line)) {
      prov = { name: line.slice(0, -1), baseUrl: '', api: '', apiKey: '', extra: {}, models: [] };
      providers.push(prov);
      inModels = false;
      model = null;
      continue;
    }
    if (!prov) continue;
    if (/^models:\s*$/.test(line)) { inModels = true; model = null; continue; }
    if (inModels && /^-\s*/.test(line)) {
      const body = line.replace(/^-\s*/, '');
      const m = body.match(/^([\w.-]+):\s*(.*)$/);
      model = { id: '', name: '', extra: {} };
      if (m) model[m[1]] = stripQuotes(m[2]);
      prov.models.push(model);
      continue;
    }
    const kv = line.match(/^([\w.-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (inModels && model) { model[k] = stripQuotes(v); continue; }
    if (['baseUrl', 'api', 'apiKey'].includes(k)) prov[k] = stripQuotes(v);
    else if (k !== 'extra') prov.extra[k] = stripQuotes(v);
  }
  return providers.map((p) => ({
    name: p.name,
    baseUrl: p.baseUrl,
    api: p.api,
    apiKey: p.apiKey,
    extra: p.extra,
    models: p.models.map((m) => {
      const { id, name, extra, ...rest } = m;
      return { id, name, extra: rest };
    }),
  }));
}
function emitYamlProviders(providers) {
  const lines = ['# 由 sbridge「设置 → API 配置」维护；手改也有效', 'providers:'];
  if (!providers.length) lines.push('  {}');
  for (const p of providers) {
    lines.push(`  ${p.name}:`);
    if (p.baseUrl) lines.push(`    baseUrl: ${scalar(p.baseUrl)}`);
    if (p.api) lines.push(`    api: ${scalar(p.api)}`);
    if (p.apiKey) lines.push(`    apiKey: ${scalar(p.apiKey)}`);
    for (const [k, v] of Object.entries(p.extra || {})) lines.push(`    ${k}: ${emitValue(k, v)}`);
    if (p.models?.length) {
      lines.push('    models:');
      for (const m of p.models) {
        lines.push(`      - id: ${scalar(m.id)}`);
        if (m.name) lines.push(`        name: ${scalar(m.name)}`);
        for (const [k, v] of Object.entries(m.extra || {})) lines.push(`        ${k}: ${emitValue(k, v)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/* ---------------- 读 ---------------- */
export function readApiConfig(tool) {
  if (!SUPPORTED_TOOLS.includes(tool)) throw new Error('该工具不支持 API 配置（只有 Pi 和 OMP）');
  if (tool === 'pi') {
    const j = readJson(PI_MODELS, { providers: {} });
    const s = readJson(PI_SETTINGS, {});
    const providers = Object.entries(j.providers || {}).map(([name, v]) => ({
      name,
      baseUrl: v.baseUrl || '',
      api: v.api || '',
      apiKey: v.apiKey || v.api_key || '',
      extra: Object.fromEntries(Object.entries(v).filter(([k]) => !['baseUrl', 'api', 'apiKey', 'api_key', 'models'].includes(k))),
      models: (v.models || []).filter((m) => m && m.id).map((m) => {
        const { id, name, ...rest } = m;
        return { id, name: name || '', extra: rest };
      }),
    }));
    const def = s.defaultProvider && s.defaultModel ? `${s.defaultProvider}/${s.defaultModel}` : '';
    return { tool, providers, defaultModel: def, apiOptions: API_OPTIONS };
  }
  const providers = parseYamlModels(readText(OMP_MODELS));
  const conf = readText(OMP_CONFIG);
  const hit = conf.match(/^\s*default:\s*(\S+)\s*$/m);
  return { tool, providers, defaultModel: hit ? stripQuotes(hit[1]) : '', apiOptions: API_OPTIONS };
}

/* ---------------- 写 ---------------- */
function cleanProviders(list) {
  if (!Array.isArray(list)) throw new Error('providers 必须是数组');
  const seen = new Set();
  return list.map((p) => {
    const name = String(p?.name || '').trim();
    if (!/^[\w.@-]{1,48}$/.test(name)) throw new Error(`Provider 名称不合法：${name || '(空)'}`);
    if (seen.has(name)) throw new Error(`Provider 重名：${name}`);
    seen.add(name);
    const models = (Array.isArray(p.models) ? p.models : [])
      .map((m) => ({ id: String(m?.id || '').trim(), name: String(m?.name || '').trim(), extra: m?.extra || {} }))
      .filter((m) => m.id);
    return {
      name,
      baseUrl: String(p.baseUrl || '').trim(),
      api: String(p.api || '').trim(),
      apiKey: String(p.apiKey || ''),
      extra: p.extra && typeof p.extra === 'object' ? p.extra : {},
      models,
    };
  });
}

export function writeApiConfig(tool, { providers, defaultModel } = {}) {
  if (!SUPPORTED_TOOLS.includes(tool)) throw new Error('该工具不支持 API 配置（只有 Pi 和 OMP）');
  const list = cleanProviders(providers);
  const def = String(defaultModel || '').trim();

  if (tool === 'pi') {
    const j = readJson(PI_MODELS, { providers: {} });
    const old = j.providers || {};
    const next = {};
    for (const p of list) {
      const prev = old[p.name] || {};
      const prevModels = new Map((prev.models || []).filter((m) => m?.id).map((m) => [m.id, m]));
      next[p.name] = {
        ...prev,
        api: p.api || prev.api,
        baseUrl: p.baseUrl,
        models: p.models.map((m) => {
          const merged = { ...(prevModels.get(m.id) || { id: m.id }) };
          if (m.name) merged.name = m.name; else delete merged.name;
          return merged;
        }),
      };
      // 密钥：填了就替换，留空就清掉（不再偷偷保留旧值）
      if (p.apiKey) next[p.name].apiKey = p.apiKey;
      else delete next[p.name].apiKey;
      delete next[p.name].api_key;
    }
    writeText(PI_MODELS, `${JSON.stringify({ ...j, providers: next }, null, 2)}\n`);

    const s = readJson(PI_SETTINGS, {});
    if (def) {
      const idx = def.indexOf('/');
      if (idx > 0) {
        s.defaultProvider = def.slice(0, idx);
        s.defaultModel = def.slice(idx + 1);
      }
    } else {
      delete s.defaultProvider;
      delete s.defaultModel;
    }
    writeText(PI_SETTINGS, `${JSON.stringify(s, null, 2)}\n`);
    return { ok: true, providers: list.length, defaultModel: def };
  }

  writeText(OMP_MODELS, emitYamlProviders(list));
  const conf = readText(OMP_CONFIG);
  let lines = conf.split('\n');
  let replaced = false;
  if (def) {
    lines = lines.map((line) => {
      if (replaced || !/^\s*default:\s*\S+/.test(line)) return line;
      replaced = true;
      return `  default: ${scalar(def)}`;
    });
  } else if (lines.some((l) => /^\s*default:\s*\S+/.test(l))) {
    // 选「不设置」= 把 default 行删掉；modelRoles 空了就一起删
    lines = lines.filter((l) => !/^\s*default:\s*\S+/.test(l));
    if (lines.some((l) => /^\s*modelRoles:\s*$/.test(l)) && !lines.some((l) => /^\s{2}\w+:/.test(l))) {
      lines = lines.filter((l) => !/^\s*modelRoles:\s*$/.test(l));
    }
    replaced = true;
  }
  const out = lines;
  if (!replaced && def) {
    if (/\nmodelRoles:\s*$/m.test(conf)) out.push(`  default: ${scalar(def)}`);
    else out.push('modelRoles:', `  default: ${scalar(def)}`);
  }
  writeText(OMP_CONFIG, `${out.join('\n').replace(/\n+$/, '')}\n`);
  return { ok: true, providers: list.length, defaultModel: def };
}
