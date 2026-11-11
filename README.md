# Open Browser Use

一个本地运行的 AI 浏览器代理。输入自然语言目标，模型像 Claude in Chrome 一样通过工具调用读取页面、点击、输入、切换标签页，界面显示截图、每一步工具调用和结果；完成后可以在同一个浏览器里继续对话。支持实时代理光标、点击与拖动反馈、串行任务队列及会话自动清理。默认使用 Anthropic Claude（`claude-opus-5-5`），也支持 DeepSeek 和兼容 OpenAI 的 Chat Completions 服务（需支持 function calling）。

## 开始使用

从源码启动需要 Node.js 22.12+ 和 Chrome / Edge（都没有时运行 `npx playwright install chromium`）。打包后的桌面应用自带 Node.js，不需要用户安装 Node；自动化浏览器仍使用外部 Chrome / Edge 或已安装的 Playwright Chromium。

```bash
npm install
npm start
```

这会打开 Electron 桌面工作台并自动启动独立后台。点击“本地演示”可以无需 Key 验证真实浏览器和工具循环。**演示使用固定脚本，不代表模型智能。**

桌面窗口加载本地资源，通过受限 IPC 调用独立 Node.js 后台；浏览器自动化与模型调用不会运行在界面进程里。工作台提供 Electron 桌面入口，不提供网页界面。可选的标准 HTTP API 通过独立端口提供，默认关闭，见 [API 使用说明](docs/api.md)。扩展端口只支持经过认证的 WebSocket 中继，普通 HTTP 请求返回 404。演示商店随应用打包，在浏览器中加载内嵌资源，无需本地网站服务。

- 双击打包应用或运行 `npm start` 即可使用。macOS 关闭窗口后后台继续运行，可从 Dock / 菜单栏重新打开；通过菜单“退出”或 Cmd+Q 会停止任务、关闭代理浏览器并释放中继。Windows / Linux 关闭最后一个窗口会退出应用。
- 应用只启动一个桌面实例；重复启动会聚焦已有窗口。后台异常退出时工作台会提示重新打开应用，不会自动重跑任务。
- 模型配置、历史、配对令牌和专用浏览器配置沿用 `~/.openbrowseruse`，可直接使用原网页版本的数据。`OBU_DATA_DIR`、`BROWSER_PROFILE_DIR` 等环境变量继续有效。
- 扩展服务优先监听 `127.0.0.1:4318`；端口被占用时桌面应用使用可用端口。设置中的“扩展服务器地址”显示实际地址，请在扩展配对界面同步填写。可用 `OBU_DESKTOP_PORT` 指定首选端口（`0` 表示随机端口）。
- “导出”使用原生保存对话框；“打开 Chrome 扩展目录”可定位随应用一起分发的扩展。

生成桌面安装包：

```bash
npm run icons           # macOS 上从已选橙色原稿生成 ICNS / ICO / PNG 与扩展图标
npm run pack            # 当前平台的可运行应用目录，输出到 dist/
npm run dist            # macOS DMG/ZIP、Windows NSIS 或 Linux AppImage
npm run test:desktop    # 真实 Electron + Chrome 扩展集成测试
```

发布包需要在目标系统构建和验证。默认 macOS 构建跳过签名；对外分发需覆盖 `build.mac.identity` 并配置 Developer ID 签名和公证，Windows 可配置代码签名；仓库不含签名证书，也不会自动发布。构建时不会把本机的 Key、会话数据库或浏览器配置打包进去。首次启动开发版或打包时会下载 Electron 运行时。

正式发布 macOS ARM64 包使用 `npm run release:mac`。先在钥匙串安装带私钥的 Developer ID Application 证书，并用 `xcrun notarytool store-credentials` 交互式配置公证凭据；设置 `CSC_NAME` 为证书中的公司名称或 SHA-1、`APPLE_KEYCHAIN_PROFILE` 为凭据名称。发布脚本会先检查证书和登录，再强制签名、启用 Hardened Runtime、提交 Apple 公证、装订并验证票据，最后生成 `dist/SHA256SUMS.txt`。缺少签名或公证配置时直接失败，不会把未签名包当作正式发布包。证书、私钥和密码不存入仓库。首次创建 Developer ID 证书需要团队 Account Holder 操作，普通 Admin 账号不能代为创建。

在“模型设置”里选择服务类型：

- **Anthropic Claude**：模型默认 `claude-opus-5-5`，Base URL 留空即官方地址。Key 可在界面填写；留空时使用 `ANTHROPIC_API_KEY` 或 `ant auth login` 的凭据。“思考强度”对应 `output_config.effort`，默认 high。
- **DeepSeek**：Base URL 留空即 `https://api.deepseek.com`，模型默认 `deepseek-flash`（也可用 `deepseek-v4-pro`），填写 DeepSeek 的 API Key（或设置 `DEEPSEEK_API_KEY`）。DeepSeek 默认开启思考模式：工具调用期间会把 `reasoning_content` 原样回传（否则接口返回 400），思考内容显示在对话中；“思考强度”映射为 `reasoning_effort`（low → low，medium / high / xhigh → high，max → max）。DeepSeek 默认开启截图输入，图像识别请选择 `deepseek-flash`；按[官方视觉接口](https://api-docs.deepseek.com/zh-cn/guides/vision/)将截图以 user 消息中的 base64 `image_url` 发送，使用 `detail: original`。`computer screenshot` 查看全图，`computer zoom` 提供无损 PNG 局部截图，可用于小字、验证码等图片识别。设置中可关闭“发送截图”；自动模式的审查使用同一模型。
- **OpenAI 兼容服务**：Base URL 如 `https://api.openai.com/v1`（不要附加 `/chat/completions`），填写模型 ID 和 Key。模型必须支持 tools / function calling。“发送截图”仅在模型支持视觉时开启。

保存配置，输入目标（需要打开的网址直接写在目标里），选择权限模式，点击“开始执行”。

浏览器设置、受保护网站列表、模型配置和 API Key 保存到 `~/.openbrowseruse/model-config.json`（可用 `OBU_DATA_DIR` 指定目录），服务重启后自动恢复。Key 以明文保存在本机文件，API 响应不会返回 Key。保存时 Key 留空会保留同一服务的已有 Key；勾选“清除已保存的 Key”后保存会同步清除磁盘中的 Key。切换服务商或 Base URL 会清除旧 Key。已保存的模型配置优先于启动环境变量；没有配置文件时使用环境变量初始化。

桌面工作台通过 IPC 实时更新：浏览器视图是代理当前标签页的实时画面（CDP screencast），“对话”面板按时间显示你的消息、代理的说明，以及每次工具调用的卡片（点开可看输入和结果）。执行过程中可以在对话框里补充说明，下一步生效；代理用 `ask_user` 提问时，对话框里的回复就是答案。

“暂停 / 接管”会取消当前模型请求，在当前浏览器操作结束后暂停。可以直接操作浏览器窗口，然后点击“继续执行”。模型回答后浏览器保持打开，可以继续对话，或点击“关闭浏览器”结束会话。

任务在模型请求前、浏览器动作前后、等待用户及结束时（演示除外）保存检查点到 `~/.openbrowseruse/sessions.db`（node:sqlite，可用 `OBU_DATA_DIR` 修改），不含截图。在“历史会话”中可以回放对话和工具卡片、导出 JSON。每轮最终回答和完整事件历史都会保留；实时工作台只展示最近 400 条事件，导出包含完整记录。历史回放按页加载，每页 100 条；导出包含完整记录及脱敏后的原文存档。点击“从检查点恢复”可重新建立浏览器并继续任务：恢复阶段进度、历史摘要和未知结果的动作记录，先重新观察页面、核验上次结果，再决定下一步。不会自动重放点击或提交，也不会恢复原生思考块、旧元素引用或已关闭的临时登录状态。

密码、令牌、验证码和支付敏感字段的已识别输入，以及带有明确密码/API Key 标签的文字，会在状态 API、会话文件和导出中脱敏；浏览器操作和模型上下文仍使用原始值。旧会话在数据库首次打开时清理可识别的凭据，原时间戳不变。自由文本、任意脚本输出和截图不能保证自动识别所有秘密。`metrics` 记录每次模型请求的耗时、模型与原始 token usage（服务商未返回时为 null）、工具尝试耗时，以及 Agent 层重试次数；SDK 内部重试不单独计数。

## 权限

任务的权限模式（参考 Claude in Chrome）：

| 模式 | 行为 |
|---|---|
| 逐步确认（可选） | 每次点击、输入、按键、表单填写都在工作台确认 |
| 自动 · 审查风险 | 先跑固定规则，再由审查模型（Claude 默认 `claude-haiku-5-5`，其他服务用主模型）判断：安全的直接执行，有后果的（购买、发送、删除、发布、提交个人信息）请你确认，明显违背你意图的直接阻止。审查失败或无法解析时一律请你确认 |
| 直接执行（默认） | 所有工具直接执行，不受网站权限、字段类型、受保护网站或脚本确认限制 |

可选确认模式及操作记录：

- **网站权限**：除跳过确认模式外，首次访问或首次操作一个新网站（目标里写明的网址除外）时会询问，可选“允许这一步 / 始终允许此网站 / 禁止此网站”。“始终允许”和“禁止”保存在 `~/.openbrowseruse/permissions.json`（可用 `OBU_DATA_DIR` 修改），在“浏览器设置 → 网站权限”中撤销。
- 默认受保护网站列表为空。用户自行配置的受保护网站仅在可选确认模式下生效。密码、验证码、文件上传和支付字段不再要求人工接管。
- `javascript` 与其他工具一样，默认直接执行。
- 每个被执行、拒绝或阻止的操作都记入任务的 `audit` 列表（时间、网站、工具、决定来源），随“导出记录”一起导出。

## 浏览器设置

在“浏览器设置”中选择代理使用的浏览器：

- **独立会话**（默认）：每次任务启动全新浏览器，不保留 Cookie 和登录。
- **使用持久化浏览器配置**：专用配置目录（默认 `~/.openbrowseruse/profile`，可用 `BROWSER_PROFILE_DIR` 修改）保留登录，与个人 Chrome 分开。点击“打开登录浏览器”手动登录需要的网站，关闭后再执行任务（同一配置不能被两个窗口同时使用）。
- **Chrome 扩展（推荐）**：代理在你日常使用的 Chrome 里工作，使用你的登录状态，类似 Claude in Chrome。见下一节。
- **连接我正在运行的 Chrome（CDP）**：用 `--remote-debugging-port=9222` 启动 Chrome，代理连接 `http://127.0.0.1:9222`，在你的登录状态下工作。代理只读取、操作和关闭它自己打开的标签页；停止时断开连接，不关闭你的浏览器。CDP 支持本机或远程 HTTP(S)/WS(S) 地址。

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.openbrowseruse/chrome-cdp"
```

（新版 Chrome 不允许对默认配置开启远程调试，需要指定单独的 `--user-data-dir`。）

可访问 localhost 和内网，但代理标签页禁止访问工作台的 /api 和 /relay 管理接口；旧地址权限选项不再生效。

## Chrome 扩展

`extension/` 是一个 Manifest V3 扩展，让代理在你自己的 Chrome 里工作：

1. 打开桌面应用（源码运行 `npm start`）。
2. 打开 `chrome://extensions`，开启“开发者模式”，点“加载已解压的扩展程序”，选择 `extension` 文件夹（桌面版可在“设置 → 浏览器 → Chrome 扩展”中点击“打开 Chrome 扩展目录”，需要 Chrome 125+）。
3. 在工作台“设置 → 浏览器”中选择“Chrome 扩展”，保存，复制“配对令牌”。
4. 点 Chrome 工具栏上的 Open Browser Use 图标打开侧边栏，点“配对”，填写工作台显示的“扩展服务器地址”、粘贴令牌并保存。侧边栏显示配对和连接状态，点击“打开桌面工作台”可唤起应用；任务、对话、历史和设置统一在桌面应用中管理。

工作方式：扩展通过 WebSocket 连接本机服务（`/relay/extension`，需要令牌，并且只接受 `chrome-extension://` 来源）。服务端的中继把它模拟成一个 Chrome 调试端点，Playwright 照常连接，所有工具、元素引用、实时画面和权限规则都不变。扩展只为它自己打开的标签页挂上 `chrome.debugger`，这些标签页放在名为“Open Browser Use”的橙色标签组里，代理打开的弹出窗口也归入其中；你自己的标签页不会被读取、操作或关闭，即使服务端直接请求也会被扩展拒绝。停止任务时关闭代理的标签页并释放调试器。

注意：

- 更新项目后，请在 `chrome://extensions` 重新加载扩展。启动任务前会验证协议版本和截图能力；旧扩展或握手未完成时会提示重新加载，不会继续执行任务。
- 调试期间 Chrome 会在顶部显示“正在调试此浏览器”的提示条；点“取消”会断开代理对该标签页的控制。
- 扩展模式保留浏览器窗口的实际视口（随窗口和侧边栏大小变化），截图使用 CSS 像素，与点击坐标一致。
- 扩展尚未上架 Chrome 应用商店，需要以开发者模式加载。令牌保存在 `~/.openbrowseruse/extension-token`，删除后重启服务会生成新令牌。
- 扩展模式只能由工作台使用；MCP 服务器暂不支持（`BROWSER_MODE=extension` 时按独立会话处理）。

## 给 Claude Code / Codex 使用（MCP）

面向外部业务系统，现已提供可选的 HTTP API，见 [使用说明](docs/api.md) 和 [OpenAPI 契约](docs/openapi.json)。它负责自然语言任务的执行管理；下述 stdio MCP 提供底层浏览器工具。

`bin/mcp.js` 是一个 stdio MCP 服务器，把同一套浏览器工具（read_page、find、get_page_text、computer、navigate、tabs、form_input、控制台/网络、javascript）提供给编程代理，例如让 Claude Code 检查本机开发服务器。不需要启动工作台，也不使用模型 Key：决策由调用它的代理完成。

Claude Code：

```bash
claude mcp add --transport stdio openbrowseruse --env BROWSER_MODE=persistent -- node /path/to/OpenBrowserUse/bin/mcp.js
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.openbrowseruse]
command = "node"
args = ["/path/to/OpenBrowserUse/bin/mcp.js"]
env = { BROWSER_MODE = "persistent" }
```

MCP 服务器直接执行所有工具，不读取网站权限或拦截密码、文件、支付字段。`javascript` 默认可用，旧 `MCP_ALLOW_JAVASCRIPT` 开关不再生效。浏览器在第一次调用工具时启动，客户端断开时关闭（CDP 模式只关闭自己的标签页）。可用环境变量：`BROWSER_MODE`、`BROWSER_CDP_URL`、`BROWSER_PROFILE_DIR`、`BROWSER_HEADLESS=1`、`OBU_DATA_DIR`、`OBU_WORKBENCH_ORIGIN`（默认 `http://127.0.0.1:4318`）。

注意：持久化配置同一时间只能被一个浏览器使用，工作台和 MCP 服务器不要同时用 `persistent` 模式。

## 环境配置

```bash
export MODEL_PROVIDER=anthropic        # 或 deepseek / openai
export MODEL_NAME=claude-opus-5-5
export ANTHROPIC_API_KEY=...           # Anthropic；OpenAI 兼容服务用 MODEL_API_KEY / MODEL_BASE_URL
npm start
```

浏览器按 Chrome → Edge → Playwright Chromium 的顺序自动选择，可用 `BROWSER_CHANNEL=chrome|msedge|chromium` 指定。浏览器设置的默认值可用 `BROWSER_MODE=ephemeral|persistent|extension|cdp`、`BROWSER_CDP_URL`、`BROWSER_PROFILE_DIR` 设置。端口由 `PORT` 配置，默认 4318，仅绑定 `127.0.0.1`。不要把真实 Key 写入仓库。

## 实现结构

```text
desktop/                 Electron 主进程、本地工作台桥接和独立后台入口
lib/application.js       桌面后台的配置、任务和会话接口
lib/runtime.js           本机监听、端口分配、中继和退出清理
lib/http-api.js          HTTP API、持久化资源和幂等请求
lib/api-events.js        持久化事件、SSE 回放及断线重连
lib/api-lifecycle.js     FIFO 队列、闲置关闭和历史清理
lib/queue-payload.js     待执行任务负载加密
lib/runs.js              每轮独立执行记录
lib/runtime-lock.js      数据目录进程锁
bin/server.js            可选无界面 HTTP API 入口
bin/mcp.js               MCP 服务器入口（stdio），实现在 lib/mcp.js
lib/agent.js             工具调用循环、确认、暂停/恢复、追问、执行中补充、实时画面、停止
lib/sessions.js          会话保存（node:sqlite）
lib/extension/           Chrome 扩展中继（模拟 CDP 端点）和配对令牌
extension/               Chrome 扩展（MV3：后台连接、chrome.debugger、标签组、侧边栏）
lib/prompt.js            系统提示词（固定内容，便于缓存）
lib/providers/           anthropic.js（SDK 流式、自适应思考、拒绝回退）、openai.js、demo.js
lib/tools/               read_page / find / get_page_text、computer、navigate / tabs / form_input、控制台/网络/javascript
lib/permissions/         权限模式、网站授权、规则、受保护网站、审查模型
lib/browser/             会话、跨 iframe 和 Shadow DOM 的元素引用、URL 解析、浏览器选择
desktop/renderer/        中文桌面工作台，仅使用 preload IPC 桥接
assets/demo/             本地演示商店，由 lib/demo.js 内嵌加载
test/app.test.js         真实浏览器 + 模拟 OpenAI / Anthropic 接口的集成测试
```

任务输入、追加消息和人工补充回答不设本地字符上限，工具步数和模型轮数不限。模型设置可填写上下文窗口（默认 128,000 token）和输出预留（默认 16,000，实际最多为窗口的四分之一），请按所选服务的真实容量配置；不会根据模型名猜测容量。界面显示上下文估算、压缩次数、阶段进度及上次请求耗时。

上下文管理使用 UTF-8 字节数作保守文本估算，每张图片暂按 4,096 token 预留，包含系统提示和工具定义；这不是服务商 tokenizer 的精确计数，视觉计费也可能不同。超过单段预算的文本在首轮请求前存为资料，模型通过 `memory_read` 列目录、按关键词定位或分段读取。历史接近预算时，保留最近完整工具交互，旧交互生成摘要并保留可检索原文。摘要失败退回带原文引用的摘录；不会因摘要失败丢弃原文。原文存档不含历史截图，会脱敏已识别凭据；摘要可能遗漏细节，需回查原文。不能拆分的最近交互或固定工具定义仍超过预算时明确停止，不盲目重试。

长任务通过 `task_progress` 保存目标、约束、阶段、证据和下一步；这些是模型报告，实际完成状态仍需核验。相同动作连续失败 8 次，或连续约 25 次返回完全相同结果时暂停，用户可接管后继续。网络故障、429 和服务端错误最多尝试 6 次，使用可取消的指数退避；认证及参数错误直接停止。输出截断不执行工具，补齐“未执行”的工具结果后允许用户继续。

会话使用增量事件表和独立资料表，检查点保存任务元数据与摘要；工具卡片变化和新事件增量写入，历史回放分页读取。旧格式记录兼容读取。运行中的完整事件列表仍驻留内存，极端规模任务尚不保证恒定内存占用。

实时状态先截取最近 400 条事件，再脱敏并按变化推送，由订阅者共享序列化结果，图片只走 frame 通道；已有新鲜实时画面时不再额外截图。

循环：模型收到目标 → 检查上下文预算 → 调用工具（可一次多个）→ 保存结果与阶段进度 → 直到模型不再调用工具，给出答案。旧截图仅保留最近两张，旧文本按预算摘要并存档；完整会话和存档仍可导出。

工具：

| 工具 | 作用 |
|---|---|
| `read_page` | 可访问性树，每个可交互元素有稳定的 `ref_N`，覆盖 iframe 和开放 Shadow DOM |
| `find` | 按描述查找元素，返回 ref |
| `get_page_text` | 读取正文文字 |
| `computer` | 截图、坐标或 ref 点击（左/右/双击/三击）、输入、组合键、滚动、拖拽、悬停、局部放大、等待 |
| `form_input` | 按 ref 设置输入框、下拉框、复选框 |
| `navigate` / `tabs` | 打开网址、前进后退；列出、新建、切换、关闭标签页 |
| `read_console_messages` / `read_network_requests` | 控制台输出和网络请求 |
| `javascript` | 在页面执行脚本 |
| `ask_user` | 请用户回答或接管 |

Anthropic 请求使用 `messages.stream`，开启自适应思考；支持的模型会把工具调用之间的进度说明显示在执行记录中。直连官方 API 时开启服务端拒绝回退（`fallbacks: "default"`）；自定义 Base URL 时不发送。所有服务只保留最近 2 张截图。

## 验证

```bash
npm test
```

测试使用真实无头浏览器和本机模拟模型接口（OpenAI 兼容 JSON 和 Anthropic SSE 流），不消耗模型额度。覆盖 Chrome 扩展（真实加载扩展：配对、标签组隔离、实时画面、侧边栏）、MCP 服务器（stdio 客户端实测）、IPC 实时状态和画面、执行中补充、会话保存与回放、工具 schema、iframe / Shadow DOM 引用、坐标点击、密码框输入、IPC 调用来源检查、HTTP 网页入口不可用、Key 不回传、切换服务清除 Key、逐步确认、追问、暂停恢复、人工补充、拒绝、错误上限、本地演示、Markdown 安全渲染和桌面导出。截图输出在 `artifacts/`。

扩展测试需要能加载解压扩展的 Chromium / Chrome for Testing（正式版 Chrome 已不支持 `--load-extension`）：默认使用 Playwright 自带或缓存中的 Chromium，也可用 `OBU_TEST_CHROMIUM=<可执行文件路径>` 指定；找不到时跳过。

HTTP API 的接口契约和真实浏览器 + 模拟模型集成测试包含在 `npm test` 中。已用本机配置的真实 DeepSeek 完成 HTTP API 公开页面读取、续聊、历史结果保留及关闭会话验证；尚未用真实 Anthropic / OpenAI Key 做端到端验证。

## 当前边界

- 网页对话框自动关闭，浏览器接受下载；文件上传和密码输入可由代理完成。持久化配置和 CDP 模式下，代理可以使用这些登录状态执行操作，请只对信任的任务使用自动或跳过确认模式。
- 封闭 Shadow DOM 和纯 Canvas 页面没有 ref，需要截图 + 坐标操作。
- 模型可见任务、网页文字、截图和工具结果。请按所选服务商的数据处理方式选择浏览内容。
- 逐步确认模式可以控制每一步；自动模式依赖规则和审查模型，不能保证识别全部敏感操作；直接执行模式不做本地权限拦截。导航本身也可能引发站点行为。
- 除工作台管理接口外，浏览器不限制目标地址。工作台 API 仍验证请求来源并校验参数；没有账号体系，不适合直接暴露到公网。
- 单浏览器执行，支持 FIFO 任务队列；没有账号体系或生产部署配置。模型的文字说明按轮更新，尚未逐字流式显示。node:sqlite 在 Node 22 中仍是实验特性（它的启动警告已被屏蔽）。

模型设置在关闭当前浏览器会话后才能修改，续聊使用原会话的模型。界面中的“本轮结束”只表示模型回答完毕，不表示业务结果已验证；导出记录使用 outcome=unverified 标识。JavaScript 工具有 10 秒执行期限，暂停会取消脚本等待并尝试终止执行；取消后需重新观察页面，已产生的副作用不会撤销。
