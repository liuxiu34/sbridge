# sbridge · 会话接力工作台

**在一个编程工具里卡住的问题，换一个工具接着解——不用重讲一遍背景。**

---

## 为什么做这个

每个 CLI 编程工具（Claude Code、Codex、Pi、omp）都在同一个模型上做了不同的调教：
提示词、工具集、上下文管理、失败处理各不相同。所以经常出现这种情况——

> 同一个问题，在 A 工具里怎么调模型都过不去，换到 B 工具，几句话就解决了。

道理大家都懂，但真正愿意换工具的人不多，因为**换的成本太高**：新工具不知道你在做什么、改过哪些文件、
试过哪些思路，你得重新讲一遍故事，还得把散落在终端里的上下文找回来。于是大多数人宁可在一个工具里死磕。

sbridge 就是把「换工具」这件事的成本压到接近零：

- 这些编程工具都在 sbridge 里打开，你只需要装一次
- 一个会话卡住了，点「接力」，把上下文交给另一个工具，它在完整背景下继续解
- 谁接过谁的活、中间发生了什么，都在一条可追溯的**接力链**里，不是各聊各的

说白了：**它不是又一个 AI 编程助手，而是让已有的几个助手能互相接力的工作台。**

## 它怎么工作

```
任务（一个目标）
 └─ 会话链：Claude Code ──接力──> Codex ──接力──> Pi
       每个会话都在同一个工作目录里，上下文可交接
```

- **任务即容器**：会话挂在任务下，任务挂在项目下；一个任务可以横向开分支、并排对比两条思路
- **工作轨迹**：CLI 的消息、工具调用、思考过程整理成可折叠时间线——出问题能看清它到底做了什么
- **原始终端**：需要 TUI 交互时一键切到真终端，CLI 进程挂在服务上，关页面也不中断
- **接力**：把一个会话的上下文交给另一个工具，接力关系在白板和侧栏可见

## 核心能力

| 模块 | 说明 |
|---|---|
| 会话接力 | 上下文在 pi / claude / codex / omp 之间交接，形成可回溯的接力链 |
| 工作轨迹 | 消息、工具调用、思考过程可视化；工具调用自动折叠，支持复制、分支、编辑重发 |
| 原始终端 | 内嵌 xterm + ConPTY；缩放、回滚、TUI 对话框检测都已处理 |
| 排队与引导 | 执行中继续发消息：可排队等下一轮，也可直接注入当前回合（见下节） |
| 分屏 | 任意两个会话左右并排（**可跨任务**），各自独立输入区 |
| 多会话标签 | 顶部标签跨任务保留，切任务不会关掉已打开的会话 |
| 右侧面板 | Git / 改动 / 文件 / 浏览器 / Worktree / 侧边对话；同类型可多开、各自独立 |
| 问答与审批 | 四工具执行中抛出的选择题与审批，直接在轨迹里作答 |
| 内置浏览器 | 面板内嵌真实浏览器，编程工具通过 CDP **接管同一个实例**（见下节） |
| Worktree | 会话级独立 git worktree，面板内看差异、一键合并回主分支 |
| 模型与权限 | 模型 / 思考强度切换；执行权限三档（只读 / 常规 / 全自动） |

## 排队与引导

工具在跑任务时，你往往还想补一句「顺便看看 X」或「方向不对，改走 Y」。
sbridge 提供了两种方式，不用等这一轮跑完：

**排队**
消息进入待发队列，当前回合结束后按顺序自动连发。队列里的消息可以撤回。
适合「先把手里这轮跑完」的场景。

**引导（steer）**
不打断当前回合，把新信息作为补充直接送进正在执行的会话，让它边跑边调整方向。
适合「趁它还没跑偏，赶紧纠正」的场景。

支持程度按各工具的真实能力分派，不做假装：

| 工具 | 排队 | 引导 |
|---|---|---|
| Pi | ✅ | ✅ 原生 steer，注入当前回合、不中断 |
| Claude Code | ✅ | ✅ 注入为原生排队（进下一轮，不打断当前回合） |
| Codex | ✅ | 协议已探明，驱动尚未接入 |
| omp | ✅ | 走问答卡片 + 队列，非原生 steer |

此外还有「中断并发送」：直接终止当前执行、立刻提交新消息。

## 支持的工具

| 工具 | 接入方式 |
|---|---|
| **Pi** | rpc 长驻驱动，支持运行中 steer |
| **Claude Code** | stream-json 双向长驻，支持原生排队与问答卡片 |
| **Codex** | 会话解析 + 终端驱动 |
| **omp** | rpc-ui 驱动，问答走卡片 + 队列 |

工具需要各自安装好并完成登录；sbridge 读取它们自己的会话目录，不改动其全局配置。

## 安装

### 安装包（Windows）

从 [Releases](https://github.com/liuxiu34/sbridge/releases) 下载 `sbridge-Setup-*.exe` 安装。
安装包未做代码签名，Windows SmartScreen 会提示「未知发布者」，选择「仍要运行」即可。

### 从源码构建

```bash
npm install          # 需要 Node >= 22.5

# Windows
npm run build:exe    # 打包单文件后端
npm run dist         # 生成 NSIS 安装包

# Linux
npm run build:exe:linux
npm run dist:linux
```

构建产物：

- `dist/sbridge.exe`：后端（Node SEA 单文件，Web 资产内嵌；改 `src/web` 后必须重建）
- `release/sbridge Setup x.y.z.exe`：Windows 安装包

只跑后端做开发：`node src/server.mjs --port=4311`，浏览器打开 `http://127.0.0.1:4311`。

## 快速上手

1. 左侧选中或新建一个**任务**（绑定项目目录）
2. 点「新开会话」，选工具与工作目录，开始第一场对话
3. 在**工作轨迹**里看它做了什么；需要 TUI 交互时点「终端」
4. 卡住了？点会话工具栏的「接力」，交给另一个工具继续
5. 想比较两条思路？点「分屏」，右侧下拉可按任务挑任意会话

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

启动工具时 sbridge 会把 `SBRIDGE_CDP_URL=http://127.0.0.1:9222` 注入子进程环境；
端点信息也可随时查询：`curl http://127.0.0.1:4310/api/browser`

注意：

- 端口默认 `9222`，可用环境变量 `SBRIDGE_CDP_PORT` 覆盖；只监听 `127.0.0.1`
- 连接后能看到「面板浏览器」和「应用主界面」两个页面，自动化时选面板那个
- 该能力依赖 Electron 外壳，**仅桌面客户端可用**；纯服务端模式下 `/api/browser` 返回 `enabled:false`

## 数据与配置

- 端口默认 `4310`，可 `--port=` 覆盖
- 数据目录优先级：`SBRIDGE_DATA` 环境变量 → exe 同目录 `data/`
  - 桌面版默认 `%APPDATA%\sbridge\data`（升级不丢数据）
  - 便携模式：整个目录拷到 U 盘即可带走
- 主要数据：`board.json`（任务/会话/布局）、`context.db`（上下文索引）
- `SBRIDGE_NO_BROWSER=1`：启动后不自动打开系统浏览器（桌面版默认开启）

## 开发与验收

```bash
npm test                 # 单元/集成测试（35 项）
```

Electron 端到端验收脚本（真实前端 + 独立夹具，不接触用户会话）：

```bash
npx electron scripts/ui-workbench.cjs                        # 工作台完整交互（22 项检查）
npx electron scripts/verify-resize-continuity.cjs --native   # 真实 ConPTY 缩放（20 项场景）
node scripts/verify-browser-cdp.mjs                          # 真实 Playwright 经 CDP 接管面板浏览器
node scripts/verify-native-pi.mjs                            # Pi 原生驱动
node scripts/verify-native-omp.mjs                           # omp 原生驱动
node scripts/verify-live-dialogue.mjs                        # 真实工具对话链路
```

## 已知限制

- 安装包未签名（NotSigned）
- Codex 的 turn/steer 驱动未接入；omp 的引导是问答卡片 + 队列，不是原生 steer
- 侧边对话、MCP 表单/URL 授权等工具私有交互，部分场景会提示转到终端处理
- 强杀进程或断电时，正在执行的回合不保证完整落盘
- 内嵌浏览器只在桌面客户端可用（纯服务端模式没有浏览器面板）

## 许可证

[Apache-2.0](LICENSE)
