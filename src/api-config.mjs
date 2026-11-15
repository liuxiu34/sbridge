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
  if (/^(null|~)$/.test(t)) return null;
  return t;
}
const BOOL_KEYS = /^(supportsTools|reasoning|omitMaxOutputTokens|preferWebsockets)$/;
const NUM_KEYS = /^(contextWindow|maxContextWindow|maxTokens|premiumMultiplier|imageCountBudget)$/;
function emitValue(key, v) {
  if (v === null) return 'null'; // 不能先 String()，否则 null 会变成字符串 "null"
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (BOOL_KEYS.test(key) && /^(true|false)$/i.test(s)) return s.toLowerCase();
  if (NUM_KEYS.test(key) && /^-?\d+(\.\d+)?$/.test(s)) return s;
  return scalar(s);
}
function scalar(v) {
  if (v === '' || v === undefined) return '""';
  // null 必须写成 YAML 的 null（不能加引号，否则读回来变成字符串 "null"）
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  // 纯字母数字/下划线/点/斜杠/短横/冒号开头的 URL 可以裸写，其余加引号
  if (/^[A-Za-z0-9_./:@-]+$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s) && !/^-?\d/.test(s)) return s;
  return JSON.stringify(s);
}

/* 把任意值写成 YAML：标量直写，对象/数组递归展开。
   Pi 的 models.json 里有嵌套结构（compat / cost / thinkingLevelMap / promptCache），
   之前直接 String() 会写成 "[object Object]"，omp 读到就废了。 */
function emitYamlValue(key, v, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return [`${pad}${key}: []`];
    const out = [`${pad}${key}:`];
    for (const item of v) {
      if (item && typeof item === 'object') {
        const entries = Object.entries(item);
        if (!entries.length) { out.push(`${pad}  - {}`); continue; }
        const [k0, v0] = entries[0];
        const first = emitYamlValue(k0, v0, indent + 4);
        out.push(`${pad}  - ${first[0].trimStart()}`);
        for (const line of first.slice(1)) out.push(line);
        for (const [k, val] of entries.slice(1)) out.push(...emitYamlValue(k, val, indent + 4));
      } else {
        out.push(`${pad}  - ${scalar(item)}`);
      }
    }
    return out;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    if (!entries.length) return [`${pad}${key}: {}`];
    const out = [`${pad}${key}:`];
    for (const [k2, v2] of entries) out.push(...emitYamlValue(k2, v2, indent + 2));
    return out;
  }
  return [`${pad}${key}: ${emitValue(key, v)}`];
}

function emitYamlProviders(providers) {
  const lines = ['# 由 sbridge「设置 → API 配置」维护；手改也有效', 'providers:'];
  if (!providers.length) lines.push('  {}');
  for (const p of providers) {
    lines.push(`  ${p.name}:`);
    if (p.baseUrl) lines.push(`    baseUrl: ${scalar(p.baseUrl)}`);
    if (p.api) lines.push(`    api: ${scalar(p.api)}`);
    if (p.apiKey) lines.push(`    apiKey: ${scalar(p.apiKey)}`);
    for (const [k, v] of Object.entries(p.extra || {})) lines.push(...emitYamlValue(k, v, 4));
    if (p.models?.length) {
      lines.push('    models:');
      for (const m of p.models) {
        lines.push(`      - id: ${scalar(m.id)}`);
        if (m.name) lines.push(`        name: ${scalar(m.name)}`);
        for (const [k, v] of Object.entries(m.extra || {})) lines.push(...emitYamlValue(k, v, 8));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/* 解析 omp 的 models.yml：支持嵌套映射/数组/内联 JSON 值。
   只覆盖 omp 用到的结构，但要能正确还原 compat / cost / thinkingLevelMap / promptCache
   这类嵌套对象——否则读回来再保存一次就把它们丢了。 */
/* 解析 omp 的 models.yml：支持嵌套映射/数组/内联 JSON 值。
   只覆盖 omp 用到的结构，但要能正确还原 compat / cost / thinkingLevelMap / promptCache
   这类嵌套对象——否则读回来再保存一次就把它们丢了。 */
function parseScalarValue(raw) {
  const t = String(raw).trim();
  if (!t) return '';
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return JSON.parse(t); } catch { /* 落到下面按字符串处理 */ }
  }
  return stripQuotes(t);
}

function parseYamlModels(text) {
  const lines = String(text || '').split('\n');
  const indentOf = (l) => l.match(/^\s*/)[0].length;
  const isBlank = (l) => !l.trim() || /^\s*#/.test(l);
  const providers = [];
  let i = 0;

  // 收集缩进大于 baseIndent 的连续块，还原成对象（递归）
  const collectBlock = (baseIndent) => {
    const out = {};
    while (i < lines.length) {
      const raw = lines[i];
      if (isBlank(raw)) { i++; continue; }
      const ind = indentOf(raw);
      if (ind <= baseIndent) break;
      const line = raw.trim();
      i++;
      const kv = line.match(/^([\w.@$-]+):\s*(.*)$/);
      if (!kv) continue;
      const [, k, rest] = kv;
      if (rest !== '') { out[k] = parseScalarValue(rest); continue; }
      // rest 为空：下一层可能是数组（- 开头）或对象
      const next = lines[i];
      if (next && !isBlank(next) && indentOf(next) > ind && /^-\s/.test(next.trim())) {
        const arr = [];
        const arrIndent = indentOf(next);
        while (i < lines.length) {
          const r = lines[i];
          if (isBlank(r)) { i++; continue; }
          if (indentOf(r) !== arrIndent || !/^-\s/.test(r.trim())) break;
          const body = r.trim().replace(/^-\s*/, '');
          i++;
          const inline = body.match(/^([\w.@$-]+):\s*(.*)$/);
          if (inline) {
            const [, k2, v2] = inline;
            const obj = {};
            if (v2 !== '') obj[k2] = parseScalarValue(v2);
            else obj[k2] = collectBlock(arrIndent + 1);
            Object.assign(obj, collectBlock(arrIndent + 1));
            arr.push(obj);
          } else {
            arr.push(parseScalarValue(body));
          }
        }
        out[k] = arr;
      } else {
        out[k] = collectBlock(ind);
      }
    }
    return out;
  };

  while (i < lines.length) {
    const raw = lines[i];
    if (isBlank(raw)) { i++; continue; }
    const ind = indentOf(raw);
    const line = raw.trim();
    i++;
    if (/^providers:\s*$/.test(line)) continue;
    if (ind !== 2) continue;
    const m = line.match(/^([\w.@-]+):\s*$/);
    if (!m) continue;
    const body = collectBlock(ind);
    const models = Array.isArray(body.models) ? body.models : [];
    const extra = {};
    for (const [k, v] of Object.entries(body)) {
      if (!['baseUrl', 'api', 'apiKey', 'models'].includes(k)) extra[k] = v;
    }
    providers.push({
      name: m[1],
      baseUrl: body.baseUrl || '',
      api: body.api || '',
      apiKey: body.apiKey || '',
      extra,
      models: models.filter((x) => x && x.id).map((x) => {
        const { id, name: mn, ...rest } = x;
        return { id, name: mn || '', extra: rest };
      }),
    });
  }
  return providers;
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
/* omp 认可的 compat 键（从 omp 包里核对过）。Pi 还有 sendSessionAffinityHeaders 之类，
   写进 omp 会让它每次启动都打一行 "Unknown compat key" 警告，这里先剔掉。 */
const OMP_COMPAT_KEYS = new Set(['supportsStrictMode', 'supportsStore', 'supportsDeveloperRole']);
function filterCompat(compat) {
  if (!compat || typeof compat !== 'object' || Array.isArray(compat)) return compat;
  const out = {};
  for (const [k, v] of Object.entries(compat)) if (OMP_COMPAT_KEYS.has(k)) out[k] = v;
  return out;
}

function cleanProviders(list) {
  if (!Array.isArray(list)) throw new Error('providers 必须是数组');
  const seen = new Set();
  return list.map((p) => {
    const name = String(p?.name || '').trim();
    if (!/^[\w.@-]{1,48}$/.test(name)) throw new Error(`Provider 名称不合法：${name || '(空)'}`);
    if (seen.has(name)) throw new Error(`Provider 重名：${name}`);
    seen.add(name);
    const models = (Array.isArray(p.models) ? p.models : [])
      .map((m) => {
        const extra = { ...(m?.extra || {}) };
        if ('compat' in extra) extra.compat = filterCompat(extra.compat);
        return { id: String(m?.id || '').trim(), name: String(m?.name || '').trim(), extra };
      })
      .filter((m) => m.id);
    const extra = { ...(p.extra && typeof p.extra === 'object' ? p.extra : {}) };
    if ('compat' in extra) extra.compat = filterCompat(extra.compat);
    return {
      name,
      baseUrl: String(p.baseUrl || '').trim(),
      api: String(p.api || '').trim(),
      apiKey: String(p.apiKey || ''),
      extra,
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

  /* omp 的校验规则：自定义 provider 必须带 apiKey，否则整个 models.yml 加载失败
     （Pi 允许留空走环境变量/OAuth，所以从 Pi 复制过来时会踩到）。
     这里直接拦掉并说清是哪个 provider，而不是写进去让 omp 起不来。 */
  const noKey = list.filter((p) => !String(p.apiKey || '').trim()).map((p) => p.name);
  if (noKey.length) {
    throw new Error(`omp 要求每个 provider 都填 API Key，这些还没有：${noKey.join('、')}。请补上或删掉它们。`);
  }
  writeText(OMP_MODELS, emitYamlProviders(list));
  /* config.yml 只维护 modelRoles.default 这一项。这里整块重写，
     避免出现两个 modelRoles 键（YAML 重复键会让解析结果不确定）。 */
  const conf = readText(OMP_CONFIG);
  const kept = [];
  let inRoles = false;
  for (const line of conf.split('\n')) {
    // modelRoles 可能写成 `modelRoles:` 也可能是 `modelRoles: {}`，两种都要吃掉
    if (/^modelRoles:\s*(\{\s*\})?\s*$/.test(line)) { inRoles = true; continue; }
    if (inRoles && /^\s{2,}\S/.test(line)) continue; // 丢掉旧的 modelRoles 子项
    if (inRoles && /^\S/.test(line) && !/^\s*#/.test(line)) inRoles = false;
    if (inRoles && !line.trim()) continue;
    if (/^\s*#\s*sbridge 接入默认值/.test(line)) continue; // 旧的说明注释一并清掉
    kept.push(line);
  }
  const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const parts = [];
  if (body) parts.push(body);
  if (def) parts.push('modelRoles:', `  default: ${scalar(def)}`);
  writeText(OMP_CONFIG, `${parts.join('\n')}\n`);
  return { ok: true, providers: list.length, defaultModel: def };
}
