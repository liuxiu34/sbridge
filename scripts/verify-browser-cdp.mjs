// 浏览器接管验收：用真实 Playwright 通过 CDP 控制面板里的浏览器。
// 这是唯一有意义的标准——Playwright MCP / chrome-devtools-mcp / browser-use 都基于
// chromium.connectOverCDP，它们只能看到 type=page 的 target。
// 用法：node scripts/verify-browser-cdp.mjs [--cdp=http://127.0.0.1:9222] [--keep-open]
// 前提：sbridge 桌面客户端在运行（CDP 端口由 Electron 壳开启）。
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const CDP = arg('cdp', process.env.SBRIDGE_CDP_URL || 'http://127.0.0.1:9222');
const keepOpen = args.includes('--keep-open');
const log = (...a) => console.log(...a);

let browser;
try {
  browser = await chromium.connectOverCDP(CDP);
} catch (err) {
  console.error(JSON.stringify({ passed: false, reason: `连不上 CDP ${CDP}: ${err.message}` }));
  process.exit(1);
}
log('已连接 CDP:', CDP);

const pages = () => browser.contexts().flatMap((c) => c.pages());

// 1) 打开面板里的浏览器（等同用户点「浏览器」），让原生视图被摆上并出现在 CDP 里
const appPage = pages().find((p) => /127\.0\.0\.1:\d+\/?$/.test(p.url()));
if (!appPage) {
  console.error(JSON.stringify({ passed: false, reason: '没找到 sbridge 主页面', pages: pages().map((p) => p.url()) }));
  process.exit(1);
}
await appPage.evaluate(() => { if (typeof openSidePanel === 'function') openSidePanel('browser'); return 'ok'; });
// 等原生视图被创建并摆上（IPC 往返 + 首帧）
await new Promise((r) => setTimeout(r, 3000));

const all = pages();
log('Playwright 看到的页面：');
for (const p of all) log('  -', p.url());

// 2) 面板浏览器必须作为 type=page 出现在 Playwright 的页面列表里（不是 webview）
const panelPage = all.find((p) => p !== appPage && /^https?:|^about:/.test(p.url()));
if (!panelPage) {
  console.error(JSON.stringify({
    passed: false,
    reason: 'Playwright 看不到面板浏览器（target 可能不是 type=page）',
    pages: all.map((p) => p.url()),
    hint: '检查面板浏览器是否用 WebContentsView 而不是 <webview>',
  }));
  await browser.close();
  process.exit(1);
}
log('面板浏览器页面:', panelPage.url());

// 3) 用工具的方式操作它：导航到本地页面（不依赖外网/代理）、读文本、点链接、填输入框
const base = new URL(appPage.url()).origin;
const probeUrl = `${base}/diag.html`;
let ok = false;
let detail = {};
try {
  await panelPage.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  const title = await panelPage.title();
  const bodyText = (await panelPage.locator('body').innerText({ timeout: 8000 })).slice(0, 80);
  const links = await panelPage.locator('a').count();
  log('导航后 title:', title, '| 正文:', bodyText.replace(/\s+/g, ' '), '| 链接:', links);
  // 交互：点击第一个链接（站内跳转）
  const href = links ? await panelPage.locator('a').first().getAttribute('href') : null;
  if (links) {
    await panelPage.locator('a').first().click({ timeout: 8000 });
    await panelPage.waitForLoadState('domcontentloaded', { timeout: 15000 });
  }
  const afterClick = panelPage.url();
  log('点击后 URL:', afterClick, '(href=' + href + ')');
  // 地址栏应与页面同步（前端通过 IPC 收到导航事件）
  const urlBar = await appPage.evaluate(() => document.querySelector('[data-br="url"]')?.value || '');
  log('地址栏:', urlBar);
  detail = { title, bodyText: bodyText.replace(/\s+/g, ' '), links, afterClick, urlBar };
  ok = /诊断|diag/i.test(title) && /diag\.html/.test(afterClick) && /diag\.html/.test(urlBar);
  if (!ok) detail.note = '页面可控制但断言不满足';
} catch (err) {
  detail.error = err.message;
}

// 4) 复位：回到空白页；除非 --keep-open，把面板收起
await panelPage.goto('about:blank').catch(() => {});
if (!keepOpen) await appPage.evaluate(() => { if (typeof toggleSidePanel === 'function') toggleSidePanel(false); }).catch(() => {});
await browser.close();

console.log(JSON.stringify({
  passed: ok,
  cdp: CDP,
  panelTargetType: 'page',
  ...detail,
  note: ok ? '真实 Playwright 能接管面板浏览器：导航/读取/点击/地址栏同步均正常' : '接管链路有问题，见 detail',
}, null, 2));
process.exit(ok ? 0 : 1);
