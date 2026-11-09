import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { DATA_DIR } from './paths.mjs';

/** 三个编程工具的 npm 包 + 常用 Pi 扩展：安装/更新服务用 */
export const CLI_PACKAGES = {
  claude: { pkg: '@anthropic-ai/claude-code', cmd: 'claude', label: 'Claude Code' },
  codex: { pkg: '@openai/codex', cmd: 'codex', label: 'Codex' },
  pi: { pkg: '@earendil-works/pi-coding-agent', cmd: 'pi', label: 'Pi' },
};

export const PI_EXTENSIONS = [
  { pkg: '@dreki-gg/pi-plan-mode', label: '计划模式', note: '给 Pi 提供 /plan' },
  { pkg: '@narumitw/pi-goal', label: '目标模式', note: '给 Pi 提供 /goal' },
  { pkg: 'pi-web-access', label: '网页搜索', note: '联网搜索与网页抓取' },
];

const STATE_FILE = path.join(DATA_DIR, 'toolchain.json');
const latestCache = new Map();

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { autoUpdate: true }; }
}
function writeState(next) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  } catch { /* 写不进去不影响使用 */ }
}

/** 跑一条命令并收尾输出（带超时，不抛错） */
function run(cmd, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = exec(cmd, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    } catch (e) { resolve({ ok: false, output: e.message }); return; }
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ ok: false, output: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, output: out }));
  });
}

const pickVersion = (s) => {
  const m = String(s).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/);
  return m ? m[0] : '';
};
const cmpVer = (a, b) => {
  const pa = String(a || '').split(/[.-]/).map((x) => Number(x) || 0);
  const pb = String(b || '').split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
};

/** 本机装没装、版本是多少 */
export async function installedInfo(tool) {
  const meta = CLI_PACKAGES[tool];
  if (!meta) return null;
  const r = await run(`${meta.cmd} --version`, 20000);
  const version = pickVersion(r.output);
  return { tool, label: meta.label, pkg: meta.pkg, installed: r.ok && !!version, version: version || null };
}

/** npm 上的最新版本（10 分钟缓存） */
export async function latestVersion(pkg) {
  const hit = latestCache.get(pkg);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.version;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`, {
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/json', 'user-agent': 'sbridge' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    latestCache.set(pkg, { at: Date.now(), version: j.version || '' });
    return j.version || '';
  } catch { return ''; }
}

/** 三个工具的本机版本 + 最新版本 + 是否落后 */
export async function toolStatuses() {
  const ids = Object.keys(CLI_PACKAGES);
  const installed = await Promise.all(ids.map((id) => installedInfo(id)));
  const latest = await Promise.all(ids.map((id) => latestVersion(CLI_PACKAGES[id].pkg)));
  return installed.map((info, i) => ({
    ...info,
    latest: latest[i] || '',
    outdated: !!(info.version && latest[i] && cmpVer(latest[i], info.version) > 0),
  }));
}

/** 安装/更新到 npm 最新版 */
export async function updateTool(tool) {
  const meta = CLI_PACKAGES[tool];
  if (!meta) return { ok: false, error: '未知工具' };
  const r = await run(`npm install -g ${meta.pkg}@latest`, 10 * 60 * 1000);
  const after = r.ok ? await installedInfo(tool) : null;
  return { ok: r.ok, output: String(r.output || '').slice(-1500), version: after?.version || null };
}

/** Pi 扩展有没有装（读 settings.json 的 packages + extensions 目录） */
export function piExtensionState() {
  const names = [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'settings.json'), 'utf8'));
    for (const p of s.packages || []) names.push(String(p));
  } catch { /* 没有配置 */ }
  try {
    for (const d of fs.readdirSync(path.join(os.homedir(), '.pi', 'agent', 'extensions'))) names.push(d);
  } catch { /* 没有扩展目录 */ }
  const joined = names.join(' ').toLowerCase();
  return {
    plan: /plan-mode|pi-jar/.test(joined),
    goal: /pi-goal|goal/.test(joined),
    search: /web-access|search/.test(joined),
    packages: names,
  };
}

export async function installPiExtension(pkg) {
  if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(String(pkg || ''))) return { ok: false, error: '包名不合法' };
  const r = await run(`pi install npm:${pkg}`, 5 * 60 * 1000);
  return { ok: r.ok, output: String(r.output || '').slice(-1200) };
}

export function getAutoUpdate() {
  return readState().autoUpdate !== false;
}
export function setAutoUpdate(enabled) {
  const s = readState();
  s.autoUpdate = !!enabled;
  writeState(s);
  return s.autoUpdate;
}

/** 检查并更新落后的工具（自动更新开启时才动手） */
export async function autoUpdateTick() {
  const state = readState();
  if (state.autoUpdate === false) return { skipped: 'disabled' };
  let list = [];
  try { list = await toolStatuses(); } catch { return { skipped: 'check-failed' }; }
  const updated = [];
  for (const t of list) {
    if (!t.installed || !t.latest || !t.outdated) continue;
    const r = await updateTool(t.tool);
    updated.push({ tool: t.tool, ok: r.ok, from: t.version, to: r.version || t.latest });
  }
  const next = readState();
  next.lastCheck = new Date().toISOString();
  next.lastUpdated = updated;
  writeState(next);
  return { updated, checkedAt: next.lastCheck };
}

/** 启动时 + 每 12 小时检查一次，保证工具不会长期停在旧版本 */
export function startAutoUpdate() {
  const tick = () => { autoUpdateTick().catch(() => { /* 忽略单次失败 */ }); };
  setTimeout(tick, 60 * 1000);
  const timer = setInterval(tick, 12 * 60 * 60 * 1000);
  timer.unref?.();
}
