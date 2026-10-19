# My Browser Use

一个本地运行的 AI 浏览器代理。输入自然语言目标，模型像 Claude in Chrome 一样通过工具调用读取页面、点击、输入、切换标签页，界面显示截图、每一步工具调用和结果；完成后可以在同一个浏览器里继续对话。默认使用 Anthropic Claude（`claude-opus-5-5`），也支持 DeepSeek 和兼容 OpenAI 的 Chat Completions 服务（需支持 function calling）。

## 开始使用

需要 Node.js 22+ 和 Chrome / Edge（都没有时运行 `npx playwright install chromium`）。

```bash
npm install
npm start
```

打开 http://127.0.0.1:4318 。点击“先体验本地演示”可以无需 Key 验证真实浏览器和工具循环。**演示使用固定脚本，不代表模型智能。**

在“模型设置”里选择服务类型：

- **Anthropic Claude**：模型默认 `claude-opus-5-5`，Base URL 留空即官方地址。Key 可在界面填写；留空时使用 `ANTHROPIC_API_KEY` 或 `ant auth login` 的凭据。“思考强度”对应 `output_config.effort`，默认 high。
- **DeepSeek**：Base URL 留空即 `https://api.deepseek.com`，模型默认 `deepseek-flash`（也可用 `deepseek-v4-pro`），填写 DeepSeek 的 API Key（或设置 `DEEPSEEK_API_KEY`）。DeepSeek 默认开启思考模式：工具调用期间会把 `reasoning_content` 原样回传（否则接口返回 400），思考内容显示在对话中；“思考强度”映射为 `reasoning_effort`（low → low，medium / high / xhigh → high，max → max）。DeepSeek 不接收截图，代理用 read_page 等文字工具观察页面；自动模式的审查也使用同一模型。
- **OpenAI 兼容服务**：Base URL 如 `https://api.openai.com/v1`（不要附加 `/chat/completions`），填写模型 ID 和 Key。模型必须支持 tools / function calling。“发送截图”仅在模型支持视觉时开启。

保存配置，输入目标和起始网页，选择权限模式，点击“开始执行”。

工作台通过服务器推送（SSE）实时更新：浏览器视图是代理当前标签页的实时画面（CDP screencast），“对话”面板按时间显示你的消息、代理的说明，以及每次工具调用的卡片（点开可看输入和结果）。执行过程中可以在对话框里补充说明，下一步生效；代理用 `ask_user` 提问时，对话框里的回复就是答案。

“暂停 / 接管”会取消当前模型请求，在当前浏览器操作结束后暂停。可以直接操作浏览器窗口，然后点击“继续执行”。模型回答后浏览器保持打开，可以继续对话，或点击“关闭浏览器”结束会话。

每个任务结束时（演示除外）保存到 `~/.openbrowseruse/sessions.db`（node:sqlite，可用 `OBU_DATA_DIR` 修改），不含截图。在“历史会话”中可以回放对话和工具卡片、导出 JSON。

## 权限

任务的权限模式（参考 Claude in Chrome）：

| 模式 | 行为 |
|---|---|
| 逐步确认（默认） | 每次点击、输入、按键、表单填写都在工作台确认 |
| 自动 · 审查风险 | 先跑固定规则，再由审查模型（Claude 默认 `claude-haiku-5-5`，其他服务用主模型）判断：安全的直接执行，有后果的（购买、发送、删除、发布、提交个人信息）请你确认，明显违背你意图的直接阻止。审查失败或无法解析时一律请你确认 |
| 跳过确认 | 不确认，只保留下面的硬性限制 |

在所有模式下：

- **网站权限**：除跳过确认模式外，首次访问或首次操作一个新网站（起始网页除外）时会询问，可选“允许这一步 / 始终允许此网站 / 禁止此网站”。“始终允许”和“禁止”保存在 `~/.openbrowseruse/permissions.json`（可用 `OBU_DATA_DIR` 修改），在“浏览器设置 → 网站权限”中撤销。
- **硬性限制**：受保护网站（银行、证券、支付、加密货币交易所，列表可在浏览器设置中编辑）只能阅读不能操作；密码、文件上传和支付信息字段必须由你本人操作；提交到其他网站的表单和带“购买/发送/删除”等字样的按钮会请你确认（跳过确认模式除外）。
- `javascript` 工具始终需要确认。
- 每个被执行、拒绝或阻止的操作都记入任务的 `audit` 列表（时间、网站、工具、决定来源），随“导出记录”一起导出。

## 浏览器设置

在“浏览器设置”中选择代理使用的浏览器：

- **独立会话**（默认）：每次任务启动全新浏览器，不保留 Cookie 和登录。
- **使用持久化浏览器配置**：专用配置目录（默认 `~/.openbrowseruse/profile`，可用 `BROWSER_PROFILE_DIR` 修改）保留登录，与个人 Chrome 分开。点击“打开登录浏览器”手动登录需要的网站，关闭后再执行任务（同一配置不能被两个窗口同时使用）。
- **连接我正在运行的 Chrome（CDP）**：用 `--remote-debugging-port=9222` 启动 Chrome，代理连接 `http://127.0.0.1:9222`，在你的登录状态下工作。代理只读取、操作和关闭它自己打开的标签页；停止时断开连接，不关闭你的浏览器。CDP 地址只能是本机地址。

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.openbrowseruse/chrome-cdp"
```

（新版 Chrome 不允许对默认配置开启远程调试，需要指定单独的 `--user-data-dir`。）

地址限制：“允许访问 localhost”默认开启，可让代理检查本机开发服务器；“允许访问内网地址”默认关闭。工作台自身的端口始终禁止访问（内置演示页除外）。

## 给 Claude Code / Codex 使用（MCP）

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

MCP 服务器没有人工确认界面，因此按“跳过确认”模式运行，但硬性限制仍然有效：受保护网站只读、已禁止的网站（与工作台共用 `permissions.json`）、密码/文件/支付字段、工作台端口。`javascript` 默认关闭，需要时加 `MCP_ALLOW_JAVASCRIPT=1`。浏览器在第一次调用工具时启动，客户端断开时关闭（CDP 模式只关闭自己的标签页）。可用环境变量：`BROWSER_MODE`、`BROWSER_CDP_URL`、`BROWSER_PROFILE_DIR`、`BROWSER_ALLOW_LOCALHOST=0`、`BROWSER_ALLOW_PRIVATE=1`、`BROWSER_HEADLESS=1`、`OBU_DATA_DIR`、`OBU_WORKBENCH_ORIGIN`（默认 `http://127.0.0.1:4318`，禁止访问）。

注意：持久化配置同一时间只能被一个浏览器使用，工作台和 MCP 服务器不要同时用 `persistent` 模式。

## 环境配置

```bash
export MODEL_PROVIDER=anthropic        # 或 deepseek / openai
export MODEL_NAME=claude-opus-5-5
export ANTHROPIC_API_KEY=...           # Anthropic；OpenAI 兼容服务用 MODEL_API_KEY / MODEL_BASE_URL
npm start
```

浏览器按 Chrome → Edge → Playwright Chromium 的顺序自动选择，可用 `BROWSER_CHANNEL=chrome|msedge|chromium` 指定。浏览器设置的默认值可用 `BROWSER_MODE=ephemeral|persistent|cdp`、`BROWSER_CDP_URL`、`BROWSER_PROFILE_DIR`、`BROWSER_ALLOW_LOCALHOST=0`、`BROWSER_ALLOW_PRIVATE=1` 设置。端口由 `PORT` 配置，默认 4318，仅绑定 `127.0.0.1`。不要把真实 Key 写入仓库。

## 实现结构

```text
server.js                本地 HTTP API、配置、请求来源检查
bin/mcp.js               MCP 服务器入口（stdio），实现在 lib/mcp.js
lib/agent.js             工具调用循环、确认、暂停/恢复、追问、执行中补充、实时画面、停止
lib/sessions.js          会话保存（node:sqlite）
lib/prompt.js            系统提示词（固定内容，便于缓存）
lib/providers/           anthropic.js（SDK 流式、自适应思考、拒绝回退）、openai.js、demo.js
lib/tools/               read_page / find / get_page_text、computer、navigate / tabs / form_input、控制台/网络/javascript
lib/permissions/         权限模式、网站授权、规则、受保护网站、审查模型
lib/browser/             会话、跨 iframe 和 Shadow DOM 的元素引用、URL 限制、浏览器选择
public/                  中文工作台和本地演示商店
test/app.test.js         真实浏览器 + 模拟 OpenAI / Anthropic 接口的集成测试
```

循环：模型收到目标 → 调用工具（可一次多个）→ 结果（文本或截图）返回模型 → 直到模型不再调用工具，给出答案。对话历史只追加不改写，配合提示缓存和 Claude 的思考块保留规则。

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
| `javascript` | 在页面执行脚本（始终需要确认） |
| `ask_user` | 请用户回答或接管 |

Anthropic 请求使用 `messages.stream`，开启自适应思考；支持的模型会把工具调用之间的进度说明显示在执行记录中。直连官方 API 时开启服务端拒绝回退（`fallbacks: "default"`）；自定义 Base URL 时不发送。OpenAI 兼容服务只保留最近 2 张截图。

## 验证

```bash
npm test
```

测试使用真实无头浏览器和本机模拟模型接口（OpenAI 兼容 JSON 和 Anthropic SSE 流），不消耗模型额度。覆盖 MCP 服务器（stdio 客户端实测）、SSE 实时状态和画面、执行中补充、会话保存与回放、工具 schema、iframe / Shadow DOM 引用、坐标点击、密码框拦截、来源检查、Key 不回传、切换服务清除 Key、逐步确认、追问、暂停恢复、人工补充、拒绝、错误上限、演示和移动端布局。截图输出在 `artifacts/`。

尚未用真实 Anthropic / OpenAI Key 做端到端验证。

## 当前边界

- 网页对话框自动关闭，下载不被接受，文件上传和密码输入交给人工。持久化配置和 CDP 模式下，代理可以使用这些登录状态执行操作，请只对信任的任务使用自动或跳过确认模式。
- CDP 模式下，代理标签页打开的新弹出窗口，其第一个请求可能在地址限制生效前发出。
- 封闭 Shadow DOM 和纯 Canvas 页面没有 ref，需要截图 + 坐标操作。
- 模型可见任务、网页文字、截图和工具结果。请按所选服务商的数据处理方式选择浏览内容。
- 逐步确认模式可以控制每一步；自动模式依赖规则和审查模型，不能保证识别全部敏感操作；跳过确认模式只剩硬性限制。导航本身也可能引发站点行为。
- 限制 HTTP(S)、按设置拦截本机和常见私网字面地址、阻止受控浏览器访问工作台端口，并验证控制台请求来源。这不是针对恶意网站的完整网络沙箱。不要对公网暴露此服务。
- 单任务；没有账号体系或生产部署配置。模型的文字说明按轮更新，尚未逐字流式显示。node:sqlite 在 Node 22 中仍是实验特性，第一次读写会话时会打印一条警告。
