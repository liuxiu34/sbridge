import path from 'node:path';
import { isSea } from 'node:sea';

/** 是否运行在单文件 exe（Node SEA）模式 */
export const IS_SEA = isSea();

/** 应用根目录：exe 模式下数据放在 exe 旁边；
 *  源码/bundle 模式下用启动脚本位置推导（兼容 esbuild CJS 输出，不能用 import.meta.url） */
export const ROOT = IS_SEA
  ? path.dirname(process.execPath)
  : path.resolve(path.dirname(process.argv[1] || process.cwd()), '..');

/** 数据目录：优先 SBRIDGE_DATA 环境变量（Electron 桌面版设置到 %APPDATA%/sbridge/data），
 *  其次 exe 旁边的 data/（便携模式，U 盘拷走即带走数据） */
export const DATA_DIR = process.env.SBRIDGE_DATA
  ? path.resolve(process.env.SBRIDGE_DATA)
  : path.join(ROOT, 'data');
export const WEB_DIR = path.join(ROOT, 'src', 'web');
