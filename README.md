# My Browser Use

一个本地运行的 AI 浏览器代理。输入自然语言目标，模型像 Claude in Chrome 一样通过工具调用读取页面、点击、输入、切换标签页，界面显示截图、每一步工具调用和结果；完成后可以在同一个浏览器里继续对话。默认使用 Anthropic Claude（`claude-opus-5-5`），也支持兼容 OpenAI 的 Chat Completions 服务（需支持 function calling）。

## 开始使用

需要 Node.js 22+ 和 Chrome / Edge（都没有时运行 `npx playwright install chromium`）。

```bash
npm install
npm start
```

打开 http://127.0.0.1:4318 。点击“先体验本地演示”可以无需 Key 验证真实浏览器和工具循环。**演示使用固定脚本，不代表模型智能。**

在“模型设置”里选择服务类型：

- **Anthropic Claude**：模型默认 `claude-opus-5-5`，Base URL 留空即官方地址。Key 可在界面填写；留空时使用 `ANTHROPIC_API_KEY` 或 `ant auth login` 的凭据。“思考强度”对应 `output_config.effort`，默认 high。
- **OpenAI 兼容服务**：Base URL 如 `https://api.openai.com/v1`（不要附加 `/chat/completions`），填写模型 ID 和 Key。模型必须支持 tools / function calling。“发送截图”仅在模型支持视觉时开启。

保存配置，输入目标和起始网页，点击“开始执行”。默认每次点击、输入、按键、表单填写都需要在工作台确认；可信站点可启用“自动执行页面交互”。`javascript` 工具无论如何都需要确认。

“暂停 / 接管”会取消当前模型请求，在当前浏览器操作结束后暂停。可以直接操作浏览器窗口，然后点击“继续执行”。模型会在登录、验证码、密码或需要补充信息时用 `ask_user` 请求人工接管。模型回答后浏览器保持打开，可在“继续对话”中追问，或点击“关闭浏览器”结束会话。

## 环境配置

```bash
export MODEL_PROVIDER=anthropic        # 或 openai
export MODEL_NAME=claude-opus-5-5
export ANTHROPIC_API_KEY=...           # Anthropic；OpenAI 兼容服务用 MODEL_API_KEY / MODEL_BASE_URL
npm start
```

浏览器按 Chrome → Edge → Playwright Chromium 的顺序自动选择，可用 `BROWSER_CHANNEL=chrome|msedge|chromium` 指定。端口由 `PORT` 配置，默认 4318，仅绑定 `127.0.0.1`。不要把真实 Key 写入仓库。

## 实现结构

```text
server.js                本地 HTTP API、配置、请求来源检查
lib/agent.js             工具调用循环、确认、暂停/恢复、追问、停止
lib/prompt.js            系统提示词（固定内容，便于缓存）
lib/providers/           anthropic.js（SDK 流式、自适应思考、拒绝回退）、openai.js、demo.js
lib/tools/               read_page / find / get_page_text、computer、navigate / tabs / form_input、控制台/网络/javascript
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

测试使用真实无头浏览器和本机模拟模型接口（OpenAI 兼容 JSON 和 Anthropic SSE 流），不消耗模型额度。覆盖工具 schema、iframe / Shadow DOM 引用、坐标点击、密码框拦截、来源检查、Key 不回传、切换服务清除 Key、逐步确认、追问、暂停恢复、人工补充、拒绝、错误上限、演示和移动端布局。截图输出在 `artifacts/`。

尚未用真实 Anthropic / OpenAI Key 做端到端验证。

## 当前边界

- 每个任务新建独立浏览器会话，不复用个人浏览器的 Cookie，不持久化登录（计划中的下一阶段）。网页对话框自动关闭，下载不被接受，文件上传和密码输入交给人工。
- 封闭 Shadow DOM 和纯 Canvas 页面没有 ref，需要截图 + 坐标操作。
- 模型可见任务、网页文字、截图和工具结果。请按所选服务商的数据处理方式选择浏览内容。
- 默认交互确认可以控制逐步执行；自动模式依赖模型判断，不能保证识别全部敏感操作。导航本身也可能引发站点行为。
- 限制 HTTP(S)、拦截常见私网字面地址、阻止受控浏览器访问控制台 API，并验证控制台请求来源。这不是针对恶意网站的完整网络沙箱。不要对公网暴露此服务。
- 单任务、内存状态；没有账号体系、长期任务库或生产部署配置。工作台每秒轮询状态，尚未流式推送。
