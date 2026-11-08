import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 展开 ~ 与 %VAR% 环境变量 */
export function expandPath(p) {
  if (!p) return p;
  let out = p.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? '');
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1));
  return path.resolve(out);
}

/** Windows 下路径比较应忽略大小写与分隔符差异 */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+/g, '/').toLowerCase().replace(/\/$/, '');
  return norm(a) === norm(b);
}

export function uuid() {
  return crypto.randomUUID();
}

/** 生成 8 位十六进制 id，用于 pi 的 parentId 链 */
export function shortId() {
  return crypto.randomBytes(4).toString('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

/** 2026-11-03T00-06-52 形式，供文件名使用 */
export function isoForFile(date = new Date(), withMs = false) {
  const iso = date.toISOString();
  return withMs ? iso.replace(/[:.]/g, '-') : iso.replace(/:/g, '-').slice(0, 19);
}

export function dayParts(date = new Date()) {
  const iso = date.toISOString();
  return {
    year: iso.slice(0, 4),
    month: iso.slice(5, 7),
    day: iso.slice(8, 10),
  };
}

/** 粗略 token 估算：中日韩字符接近 1 token，其余按 3.6 字符 1 token */
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.15 + other / 3.6);
}

export function truncate(text, max) {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 备份文件到指定目录（保留最近 keep 份），返回备份路径；失败返回 null 不抛错 */
export function backupFile(srcPath, { dir, keep = 10 } = {}) {
  try {
    if (!fs.existsSync(srcPath)) return null;
    ensureDir(dir);
    const ts = isoForFile(new Date(), true);
    const dest = path.join(dir, `${path.basename(srcPath)}.${ts}.bak`);
    fs.copyFileSync(srcPath, dest);
    // 清理旧备份
    const base = path.basename(srcPath);
    const olds = fs.readdirSync(dir)
      .filter((f) => f.startsWith(base + '.') && f.endsWith('.bak'))
      .sort()
      .reverse()
      .slice(keep);
    for (const f of olds) {
      try { fs.rmSync(path.join(dir, f)); } catch { /* 删除失败忽略 */ }
    }
    return dest;
  } catch {
    return null;
  }
}

/** 首行可能很大（如 codex session_meta），按块读到换行 */
export function readFirstLine(file, maxBytes = 4 * 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(65536);
    let text = '';
    let scanned = 0;
    while (scanned < maxBytes) {
      const len = fs.readSync(fd, chunk, 0, chunk.length, scanned);
      if (!len) break;
      scanned += len;
      text += chunk.subarray(0, len).toString('utf8');
      const nl = text.indexOf('\n');
      if (nl !== -1) return text.slice(0, nl);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/** 读取文件前 n 行（整行 JSON 解析失败时给原文），供 list 元数据探测 */
export function readHeadLines(file, n = 40) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(256 * 1024);
    const len = fs.readSync(fd, chunk, 0, chunk.length, 0);
    const text = chunk.subarray(0, len).toString('utf8');
    return text.split('\n').filter((l) => l.trim()).slice(0, n);
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

/** 读取 jsonl，坏行跳过 */
export function readJsonl(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // 写入中断产生的半行，忽略
    }
  }
  return out;
}

export function writeJsonl(file, records) {
  ensureDir(path.dirname(file));
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, body, 'utf8');
}

/** 把工具参数压成一行可读摘要 */
export function formatArgs(args, max = 160) {
  if (args == null) return '';
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return truncate(args, max);
    }
  }
  if (typeof args !== 'object') return truncate(String(args), max);
  const parts = Object.entries(args).map(([k, v]) => {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${truncate(val, 60)}`;
  });
  return truncate(parts.join(' '), max);
}
