const fs = require('node:fs');
const path = require('node:path');

/** electron-builder afterPack：Linux 下给内嵌引擎补可执行位（Windows 不需要） */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const engine = path.join(context.appOutDir, 'resources', 'sbridge', 'sbridge');
  if (fs.existsSync(engine)) fs.chmodSync(engine, 0o755);
};
