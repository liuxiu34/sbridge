# sbridge · 会话接力工作台

在 **Codex / Claude Code / Pi / omp** 之间搬运本地会话的桌面工作台。
把「同一件事在不同 CLI 之间交接」变成一条可追溯的接力链，并给这些命令行工具补上它们没有的东西：
图形化工作轨迹、真正的终端面板、跨工具上下文接力、内置浏览器。

> 版本 1.3.4 · 许可证 Apache-2.0 · 单文件后端（Node SEA）+ Electron 外壳

---

## 它解决什么问题

这些 CLI 编程工具各有所长，但会话是各自封闭的：换个工具就得从头讲一遍背景，
出了问题也不知道中间跑了哪些命令、改了什么文件。

sbridge 的做法：

- **接力链**：把一个会话的上下文接力给另一个工具，形成可回溯的链条，而不是各聊各的
- **工作轨迹**：把 CLI 的消息、工具调用、思考过程整理成可折叠的时间线，一眼看清做了什么
- **任务即容器**：会话挂在任务下，任务挂在项目下；同一个任务里可以横向开分支、并排对比

## 功能

| 模块 | 说明 |
|---|---|
| 工作轨迹 | 消息 / 工具调用 / 思考过程可视化，工具调用自动折叠，支持复制、分支、编辑重发 |
| 原始终端 | 内嵌 xterm + ConPTY，按需挂载；缩放、回滚、TUI 对话框检测都已处理 |
| 会话接力 | 把一个会话的上下文接力到其他工具，接力链在白板与侧栏可见 |
| 分屏 | 任意两个会话左右并排（**可跨任务**），各自独立输入区 |
| 多会话标签 | 顶部标签页跨任务保留，切换任务不会关掉已打开的会话 |
| 右侧面板 | Git / 改动 / 文件 / 浏览器 / Worktree / 侧边对话，**同类型可多开**、各自独立状态 |
| 问答与审批 | 四工具（pi / claude / codex / omp）在执行中抛出的选择题与审批，直接在轨迹里作答 |
| 消息队列 | 忙碌时消息排队、可撤回，按序自动连发 |
| 内置浏览器 | 面板内嵌真实浏览器，编程工具通过 CDP **直接接管同一个实例**（见下） |
| Worktree | 会话级独立 git worktree，面板内看差异、一键合并回主分支 |
| 模型与权限 | 模型 / 思考强度切换，执行权限三档（只读 / 常规 / 全自动） |

## 支持的工具

| 工具 | 说明 |
|---|---|
| **Pi** | 原生 rpc 驱动，支持运行中引导（steer） |
| **Claude Code** | stream-json 双向长驻，支持原生排队与问答卡片 |
| **Codex** | 会话解析与终端驱动（turn/steer 协议已探明，驱动尚未接入） |
| **omp** | rpc-ui 驱动，问答走卡片 + 队列 |

工具需要各自安装好并完成登录；sbridge 读取它们自己的会话目录，不改动其全局配置。

## 安装

### 安装包（Windows）

从 [Releases](https://github.com/liuxiu34/sbridge/releases) 下载 `sbridge Setup *.exe` 安装。
安装包未做代码签名，Windows SmartScreen 会提示「未知发布者」，选择「仍要运行」即可。

> Releases 里的版本可能落后于 `main`；需要最新功能时按下面的方式从源码构建。

### 从源码构建

```bash
npm install          # 需要 Node >= 22.5

# Windows：打包单文件后端
npm run build:exe
# 生成安装包（NSIS）
npm run dist

# Linux
npm run build:exe:linux
npm run dist:linux
```

构建产物：

- `dist/sbridge.exe`：后端（Node SEA 单文件，Web 资产内嵌，改 `src/web` 后必须重建）
- `release/sbridge Setup x.y.z.exe`：Windows 安装包

开发时可以只跑后端：`node src/server.mjs --port=4311`，用浏览器打开 `http://127.0.0.1:4311`。

## 快速上手

1. 左侧选中或新建一个**任务**（可绑定项目目录）
2. 点「新开会话」，选工具与工作目录，开始第一场对话
3. 在**工作轨迹**里看 AI 做了什么；需要 TUI 交互时点「终端」切到原始终端
4. 想换工具继续？点会话工具栏的「接力」，把上下文交给另一个 CLI
5. 想并排对比两个方向？点「分屏」，右侧下拉可按任务挑任意会话

## 内置浏览器与工具接管

面板里的「浏览器」是这个应用持有的**唯一浏览器实例**（Electron `WebContentsView`）。
编程工具不需要再启动自己的浏览器，直接通过 CDP 接管它——登录态、cookie 都是同一份：

```bash
# Playwright MCP
npx @playwright/mcp@latest --cdp-endpoint=http://127.0.0.1:9222

# Chrome DevTools MCP
npx chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222

# browser-use
Browser(cdp_url='http://127.0.0.1:9222')
```

sbridge 启动工具时会把 `SBRIDGE_CDP_URL=http://127.0.0.1:9222` 注入子进程环境。
端点信息也可随时查询：

```bash
curl http://127.0.0.1:4310/api/browser
```

注意：

- 端口默认 `9222`，可用环境变量 `SBRIDGE_CDP_PORT` 覆盖
- 只监听 `127.0.0.1`；连接后能看到「面板浏览器」和「应用主界面」两个页面，自动化时选面板那个
- 该能力依赖 Electron 外壳，**仅桌面客户端可用**；纯服务端模式（Linux server / dev）下
  `/api/browser` 会返回 `enabled:false`，面板显示降级说明

## 数据与配置

- 端口默认 `4310`，可 `--port=` 覆盖
- 数据目录优先级：`SBRIDGE_DATA` 环境变量 → exe 同目录 `data/`
  - 桌面版默认 `%APPDATA%\sbridge\data`（升级不丢数据）
  - 便携模式：整个目录拷到 U 盘即可带走
- 主要数据文件：`board.json`（任务/会话/布局）、`context.db`（上下文索引）
- `SBRIDGE_NO_BROWSER=1`：启动后不自动打开系统浏览器（桌面版默认开启）

## 开发与验收

```bash
npm test                 # 单元/集成测试（35 项）
```

Electron 端到端验收脚本（真实前端、独立夹具，不接触用户会话）：

```bash
npx electron scripts/ui-workbench.cjs          # 工作台完整交互（22 项检查）
npx electron scripts/verify-resize-continuity.cjs --native   # 真实 ConPTY 缩放（20 项场景）
node scripts/verify-browser-cdp.mjs            # 真实 Playwright 经 CDP 接管面板浏览器
node scripts/verify-native-pi.mjs              # Pi 原生驱动
node scripts/verify-native-omp.mjs             # omp 原生驱动
node scripts/verify-live-dialogue.mjs          # 真实工具对话链路
```

验收记录见仓库根目录 `*验收记录-*.md`。

## 已知限制

- 安装包未签名（NotSigned）
- Codex 的 turn/steer 驱动未接入；omp 的引导是问答卡片 + 队列，不是原生 steer
- 侧边对话、MCP 表单/URL 授权等工具私有交互，部分场景会提示转到终端处理
- 强杀进程或断电时，正在执行的回合不保证完整落盘
- 内嵌浏览器只在桌面客户端可用（纯服务端模式没有浏览器面板）

## 许可证

[Apache-2.0](LICENSE)
