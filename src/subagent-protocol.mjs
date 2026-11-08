import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* 子代理修复协议：随 sbridge 分发，启动时幂等安装到三个 orchestrator 的全局说明：
   - Codex → ~/.codex/AGENTS.md
   - Pi    → ~/.pi/AGENTS.md（pi 的项目级说明同为 AGENTS.md，与 Codex 共用）
   - Claude → ~/.claude/CLAUDE.md
   换机器装 sbridge 后，那台机器的三家工具自动获得「无头子代理修复」能力（任意指挥×任意 worker 排列组合）。 */

export const PROTOCOL_VERSION = 3;

const TITLE = '# 子代理修复协议（Sub-agent Fix Protocol）';

export const PROTOCOL_MD = `${TITLE}

## 0. 什么时候走这个协议（触发方式）

- **自动**：当你在某个问题上反复尝试（同类报错出现 2-3 次以上、或你意识到自己可能在维护一个错误前提）仍然失败时，停止自己动手，改用无头子代理修复。
- **手动**：用户说「交给子代理修」「交给其他工具修」「用 XX 当子代理去修」等时，走此协议。
- **拿不准**：无法判断用户是否想触发时，先问一句「要按子代理修复协议，交给其他工具修吗？」，确认后再动。正常开发任务不要主动走此协议。
- **默认开一个子代理即可**（用户通常不同时配多家），不要同时开多个；用户指定了 worker 就用指定的。

## 1. 先检查 worker 可用性（两步：先看订阅凭证，再实测能不能对话）

用户未指定 worker 时，按 Codex → Pi → Claude 顺序挑第一个可用的。

**第一步·订阅凭证**（官方通道有没有登录）：

- **Codex**：\`~/.codex/auth.json\` 存在且非空（含登录凭证）→ 有订阅凭证；没有 → 提醒用户 Codex 需要 ChatGPT Plus/Pro 会员并运行 \`codex login\`，换下一个。
- **Pi**：\`~/.pi/agent/models.json\` 的 providers 里存在带 apiKey 的条目 → 已配置；没有 → 提醒用户先给 pi 配置 API 密钥，换下一个。
- **Claude**：\`~/.claude.json\` 里有 oauthAccount（会员登录），或 \`~/.claude/settings.json\` 的 env 里有 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY（配了兼容网关）→ 有凭证；都没有 → 提醒用户先登录 claude（需要会员）或配置网关，换下一个。

**第二步·实测探活**（决定性——有凭证不等于能用：订阅可能过期、配额可能烧完、账号可能被封，也可能用户改造了通道不走官方）：

- 用该 worker 的无头模式发一个最小探活请求，例如：\`echo "只回复ok" | pi -p\`、\`echo "只回复ok" | claude -p\`、\`codex exec "只回复ok"\`。
- **能正常回复就算可用，不关心也不评论它走官方订阅还是改造过的通道。**
- 探活失败（报错 / 无响应 / 余额或配额类错误）→ 把错误原文转告用户，换下一个 worker。探活通过后即可正式派任务。

三个都不可用：把每家的配置方法简述给用户，**不要硬跑**。注意 Claude 账号风控严格——claude worker 报登录失效 / 403 / 封禁类错误时不要反复重试，直接提醒用户并换 worker。

## 2. 写修复提示词

写入项目目录下 \`.sbridge-fix/prompt.md\`，必须包含：

- 卡点描述：目标是什么、现象是什么
- 你已尝试过什么、为什么失败（让子代理绕开你的错误思路）
- 明确的验证标准（改哪个文件、应出现什么结果、跑什么命令算通过）
- 末尾要求子代理输出固定格式：

\`\`\`
### 修复报告
- 根因：
- 改动文件：
- 验证方式与结果：
- 给主代理的后续建议：
\`\`\`

## 3. 写执行脚本并运行

创建 \`.sbridge-fix/run-fix.cmd\`，然后执行 \`cmd /c .sbridge-fix\\run-fix.cmd\`（用 cmd 包裹：PowerShell 不支持 \`<\` 重定向）。模板：

\`\`\`cmd
@echo off
cd /d "<项目目录绝对路径>"
pi -p < prompt.md > last-run-pi.log 2>&1
type last-run-pi.log
\`\`\`

可用 worker（三选一；**每个 worker 用独立的日志文件名**，避免并发文件锁）：

- Pi：\`pi -p < prompt.md > last-run-pi.log 2>&1\`
- Claude Code：\`claude -p --permission-mode acceptEdits < prompt.md > last-run-claude.log 2>&1\`
- Codex：\`codex exec --skip-git-repo-check -s workspace-write - < prompt.md > last-run-codex.log 2>&1\`

## 4. 等待与判定（重要，避免误判）

- **前台等待脚本跑完**，不要放后台后过早检查。子代理通常 1-5 分钟。
- 日志开头的框架启动警告（extension/plugin warning 等）不是结果，**以「修复报告」为准**。
- 判定 worker 失败前，先确认 worker 进程已真正退出（\`Get-Process pi,claude,node\`），进程还在跑就继续等。
- 判定失败要换 worker 重试时：换一个**日志文件名**，并把上一轮的失败现象写进新 prompt（如 prompt-retry.md）。

## 5. 验证与收尾

- 从日志读「修复报告」，**亲自验证**（跑测试/构建、检查文件内容），不要只信报告。
- 验证通过 → 向用户简报根因与改动，继续正常开发。
- 未通过 → 换 worker 再跑一轮；仍失败则对比子代理思路与自己思路后亲自修。

## 约束

- 子代理拥有文件编辑权限（自动接受），只让它处理当前项目内的修复任务。
- prompt 里不要包含密钥等敏感信息。
- 保留 \`.sbridge-fix/\` 目录（修复审计记录），不要提交到 git。`;

/** 通用幂等安装：工具目录存在才装（只改造这台机器上实际安装的工具）；
 *  已装（含标记）跳过；发现无标记/旧版本的块替换为当前版本；不存在则创建。 */
function ensureProtocolFile(file, scope, { log = console.log } = {}) {
  const marker = `<!-- sbridge:subagent-protocol-${scope}:v${PROTOCOL_VERSION} -->`;
  const block = `\n---\n\n${marker}\n\n${PROTOCOL_MD}\n`;
  try {
    // 存在性检查：工具没装（家目录都没有）就不写文件
    if (!fs.existsSync(path.dirname(file))) {
      log?.(`[子代理协议] 未检测到 ${scope}（${path.dirname(file)} 不存在），跳过`);
      return false;
    }
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current.includes(marker)) return false; // 已是当前版本
    let next;
    const titleAt = current.indexOf(TITLE);
    if (titleAt >= 0) {
      // 无标记的旧版本（手装/旧版 sbridge 装的）：整块替换，避免重复。
      // 回溯吃掉标题前紧邻的空行/分隔线/旧版本标记行，防止替换后残留悬空的旧 marker
      const headLines = current.slice(0, titleAt).split('\n');
      while (headLines.length) {
        const last = headLines[headLines.length - 1].trim();
        if (last === '' || last === '---' || /^<!-- sbridge:subagent-protocol/.test(last)) headLines.pop();
        else break;
      }
      let end = current.indexOf('\n---\n', titleAt + TITLE.length);
      if (end === -1) end = current.length;
      next = headLines.join('\n') + (headLines.length ? '\n' : '') + `${marker}\n\n` + PROTOCOL_MD + '\n' + current.slice(end);
    } else {
      next = current + (current && !current.endsWith('\n') ? '\n' : '') + block;
    }
    fs.writeFileSync(file, next, 'utf8');
    log(`[子代理协议] 已安装到 ${file} (v${PROTOCOL_VERSION})`);
    return true;
  } catch (err) {
    log(`[子代理协议] 安装失败（不影响服务）: ${file} ${err.message}`);
    return false;
  }
}

/** Codex 全局说明：~/.codex/AGENTS.md */
export function ensureCodexSubagentProtocol(opts = {}) {
  return ensureProtocolFile(path.join(opts.home || os.homedir(), '.codex', 'AGENTS.md'), 'codex', opts);
}

/** Pi 全局说明：~/.pi/AGENTS.md（pi 的项目级说明同为 AGENTS.md，与 Codex 共用一份协议） */
export function ensurePiSubagentProtocol(opts = {}) {
  return ensureProtocolFile(path.join(opts.home || os.homedir(), '.pi', 'AGENTS.md'), 'pi', opts);
}

/** Claude 全局记忆：~/.claude/CLAUDE.md */
export function ensureClaudeSubagentProtocol(opts = {}) {
  return ensureProtocolFile(path.join(opts.home || os.homedir(), '.claude', 'CLAUDE.md'), 'claude', opts);
}

/** 启动入口：所有支持的 orchestrator 一起装 */
export function ensureSubagentProtocols(opts = {}) {
  const installed = [];
  if (ensureCodexSubagentProtocol(opts)) installed.push('codex');
  if (ensurePiSubagentProtocol(opts)) installed.push('pi');
  if (ensureClaudeSubagentProtocol(opts)) installed.push('claude');
  return installed;
}
