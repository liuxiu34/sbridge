// SEA 运行时依赖准备：把 node-pty / ws 拷进 dist/node_modules，并校验目标平台的二进制。
// 为什么要校验：node-pty 是原生模块，在 Windows 上构建 Linux 包会原样拷走 win32 prebuild，
// 到 Linux 上终端直接报 `Cannot find module './prebuilds/linux-x64//pty.node'`（v1.2.0 实测踩过）。
//
// 用法：node scripts/prepare-node-modules.mjs [--target win32|linux|darwin]

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const ti = args.indexOf('--target');
const target = ti >= 0 ? String(args[ti + 1] || '').toLowerCase() : process.platform;
const VALID = ['win32', 'linux', 'darwin'];
if (!VALID.includes(target)) {
  console.error(`[deps] 未知目标平台：${target}（可选 ${VALID.join(' / ')}）`);
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');
const distModules = path.join(root, 'dist', 'node_modules');
const srcPty = path.join(root, 'node_modules', 'node-pty');
const srcWs = path.join(root, 'node_modules', 'ws');

for (const p of [srcPty, srcWs]) {
  if (!fs.existsSync(p)) {
    console.error(`[deps] 缺少依赖：${p}\n       先在该机器上 npm install（node-pty 需要本机编译）`);
    process.exit(1);
  }
}

// 1) 原生模块不能交叉打包：构建机平台必须等于目标平台
if (process.platform !== target) {
  console.error([
    `[deps] 目标平台是 ${target}，但当前构建机是 ${process.platform}。`,
    '       node-pty 是原生模块，交叉打包会原样带上构建机的二进制（例如在 Windows 上打 Linux 包，',
    '       到 Linux 上终端直接报 Cannot find module ./prebuilds/linux-x64/pty.node）。',
    target === 'linux'
      ? '       请在 Linux 机器 / CI linux runner 上构建，先 `npm rebuild node-pty` 再重跑本命令。'
      : `       请在 ${target} 机器上构建（或改用对应平台的 CI runner），先 \`npm rebuild node-pty\` 再重跑。`,
  ].join('\n'));
  process.exit(1);
}

// 2) node-pty 必须有一份为本机编好的二进制，并校验文件头（ELF / Mach-O / PE）
const binCandidates = [
  path.join(srcPty, 'build', 'Release', 'pty.node'),
  path.join(srcPty, 'build', 'Debug', 'pty.node'),
  path.join(srcPty, 'prebuilds', `${target}-${process.arch}`, 'pty.node'),
];
const binary = binCandidates.find((p) => fs.existsSync(p));
if (!binary) {
  console.error([
    '[deps] node-pty 没有可用的本机二进制，只找到别的平台的 prebuilds。',
    '       先 `npm rebuild node-pty`（需要 python3 / make / g++），再重跑本命令。',
  ].join('\n'));
  process.exit(1);
}
const head = fs.readFileSync(binary).subarray(0, 4);
const want = target === 'win32'
  ? { magic: Buffer.from('MZ'), label: 'PE(MZ)' }
  : target === 'darwin'
    ? { magic: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), label: 'Mach-O' }
    : { magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), label: 'ELF' };
if (!head.subarray(0, want.magic.length).equals(want.magic)) {
  console.error(`[deps] node-pty 二进制平台不符：${binary}\n       期望 ${want.label}，先 npm rebuild node-pty 再重跑`);
  process.exit(1);
}

// 3) 拷贝，并只保留目标平台的 prebuilds（别的平台目录在包里只会误导排查、白占体积）
fs.rmSync(distModules, { recursive: true, force: true });
fs.mkdirSync(distModules, { recursive: true });
for (const name of ['node-pty', 'ws']) {
  fs.cpSync(path.join(root, 'node_modules', name), path.join(distModules, name), { recursive: true });
}

const prebuildsDir = path.join(distModules, 'node-pty', 'prebuilds');
let pruned = [];
if (fs.existsSync(prebuildsDir)) {
  for (const ent of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(`${target}-`)) continue;
    fs.rmSync(path.join(prebuildsDir, ent.name), { recursive: true, force: true });
    pruned.push(ent.name);
  }
}
// 调试符号目录不进运行时包
fs.rmSync(path.join(distModules, 'node-pty', 'build', 'Debug'), { recursive: true, force: true });

console.log(`[deps] 已拷贝 node-pty(${want.label}) + ws → dist/node_modules`);
if (pruned.length) console.log(`[deps] 已剔除其他平台 prebuilds：${pruned.join(', ')}`);
