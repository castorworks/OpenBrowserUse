# 开发与发布

[返回文档导航](README.md) · [架构边界](architecture.md)

## 本地开发

需要 Node.js 22.12+。在仓库根目录运行 `npm ci`；没有 Chrome / Edge 时运行 `npx playwright install chromium`。

| 命令 | 用途 |
|---|---|
| `npm start` / `npm run dev` | Electron 工作台 |
| `npm run start:service` | 读取 `.env` 并启动标准服务 |
| `npm run api` | 使用进程环境变量启动标准服务 |
| `npm run mcp` | stdio MCP 入口 |
| `npm test` | `test/*.test.js` 单元、契约及集成测试 |
| `npm run test:desktop` | 独立的真实 Electron 集成测试 |
| `npm run pack` | 当前平台的可运行应用目录 |
| `npm run dist` | 当前平台安装包，不自动发布 |
| `npm run icons` | 在 macOS 生成应用及扩展图标 |
| `npm run release:mac` | macOS ARM64 签名、公证与发布产物 |

业务规则集中在 `lib/task-service.js`，状态持久化与投影在 `lib/task-state.js`，队列与清理在 `lib/task-scheduler.js`。新增入口应复用这些模块；完整职责见架构文档。`desktop/renderer/` 只通过 preload IPC 访问后台，`extension/` 负责本机服务自动连接和代理标签页，`lib/tools/` 提供浏览器工具。

## 测试范围

常规测试使用真实浏览器和本机模拟模型接口，不消耗模型额度。覆盖工具、权限、历史、HTTP 契约、幂等、队列、SSE、MCP 和扩展等行为。`npm test` 不包含单独的 `test/desktop.integration.js`；涉及 Electron 生命周期、IPC 或连接已有服务时另运行 `npm run test:desktop`。

扩展测试需要能加载解压扩展的 Chromium，默认寻找 Playwright 浏览器；可用 `OBU_TEST_CHROMIUM` 指定可执行文件。常规扩展测试找不到浏览器时跳过，桌面集成测试缺少必要浏览器时失败。`OBU_ELECTRON_EXECUTABLE` 可指定打包应用用于桌面测试。测试产物在 `artifacts/`。

真实模型冒烟脚本为 `node scripts/smoke-api.mjs`，会使用已配置的模型凭据并产生调用费用。它检查公开示例页流程，不代表所有业务、模型和平台均已验收。不要把历史测试记录当作当前运行的验证结果。

## 构建与发布

普通 `pack` / `dist` 输出到 `dist/`；平台目标为 macOS DMG/ZIP、Windows NSIS 和 Linux AppImage，应在目标系统构建与检查。打包应用自带 Node.js，自动化浏览器仍依赖外部 Chrome / Edge 或已安装的 Playwright Chromium。模型凭据、会话数据库和个人浏览器配置不属于打包文件。

默认 macOS 构建不签名。正式 ARM64 发布在 macOS 上使用 `npm run release:mac`，需要钥匙串中可用的 Developer ID Application 证书及私钥，并通过 `notarytool` 配置公证凭据：

- `CSC_NAME`：签名公司名称或证书 SHA-1。
- `APPLE_KEYCHAIN_PROFILE`：公证凭据名称。
- `APPLE_KEYCHAIN`：可选的钥匙串路径。

脚本检查凭据、强制签名、启用 Hardened Runtime、公证并装订票据，最后生成 `dist/SHA256SUMS.txt`；配置缺失时失败，不把未签名包当作正式发布包。具体步骤以 [发布脚本](../scripts/release-mac.mjs) 为准，证书和密码不提交仓库。

## 上下文与执行机制

任务输入、追加消息和人工补充回答不设本地字符上限，工具步数和模型轮数不限。HTTP API 和连接已有服务的桌面桥接仍有 8 MiB 请求体上限。模型设置可填写上下文窗口（默认 128,000 token）和输出预留（默认 16,000，实际最多为窗口的四分之一），请按所选服务的真实容量配置；不会根据模型名猜测容量。界面显示上下文估算、压缩次数、阶段进度及上次请求耗时。

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

模型统一通过 Chat Completions 接口调用。DeepSeek 使用独立的思考参数与 reasoning_content 回传逻辑；所有服务只保留最近 2 张截图。
