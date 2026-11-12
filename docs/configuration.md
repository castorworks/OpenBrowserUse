# 配置参考

[返回文档导航](README.md)

## 配置来源与优先级

`npm run start:service` 自动读取工作目录中的 `.env`；已经设置的进程环境变量优先于 `.env`。`npm start`、`npm run api` 和 `npm run mcp` 不自动读取 `.env`，需由终端或进程管理器传入变量。

桌面和标准服务共享配置格式。已有 `model-config.json` 中的模型及浏览器设置优先于环境变量；环境变量主要用于首次初始化。旧协议配置的显式迁移是例外，见 [升级与迁移](migration.md)。修改环境变量后需重启；模型设置需先关闭当前浏览器会话才能更改。

## 模型

仅支持 OpenAI 兼容 Chat Completions 与 DeepSeek。模型必须支持 tools / function calling；开启“发送截图”时还需要视觉能力。Base URL 不应附加 `/chat/completions`。

| 变量 | 默认值或说明 |
|---|---|
| `MODEL_PROVIDER` | `openai`，也可选 `deepseek` |
| `MODEL_NAME` | OpenAI 兼容模式须填写；DeepSeek 的本地默认值为 `deepseek-flash`，实际可用名称以所接服务为准 |
| `MODEL_BASE_URL` | OpenAI 默认 `https://api.openai.com/v1`；DeepSeek 默认 `https://api.deepseek.com` |
| `MODEL_API_KEY` | 模型服务凭据 |
| `DEEPSEEK_API_KEY` | DeepSeek 模式下的备用凭据变量 |
| `REVIEWER_MODEL` | 自动权限模式的审查模型；未指定时使用主模型 |

DeepSeek 适配器会回传工具调用需要的 `reasoning_content`，默认开启思考和截图输入。思考强度映射：low → low，medium / high / xhigh → high，max → max。其他兼容服务的能力需要按实际模型配置。

Key 以明文保存在本机 `model-config.json`，写入时使用文件权限 `0600`，不通过状态 API 返回。保存时 Key 留空会保留同一服务的已有 Key；切换服务商或 Base URL 会清除旧 Key；勾选“清除已保存的 Key”并保存会清除磁盘配置中的 Key。

## 服务与桌面

| 变量 | 默认值或说明 |
|---|---|
| `OBU_API_ENABLED` | 桌面默认关闭 HTTP API；设为 `1` 开启。独立服务入口自动开启 |
| `OBU_API_HOST` | `127.0.0.1`，HTTP 监听地址 |
| `OBU_API_PORT` | `4319`；`0` 使用随机空闲端口 |
| `OBU_API_TOKEN` | HTTP Bearer Token，至少 32 个非空白字符；开启 API 时必填 |
| `PORT` | `4318`，本机扩展中继端口，不是 API 端口 |
| `OBU_DESKTOP_PORT` | 桌面自带后台优先使用该端口，再取 `PORT`、4318；占用时启动失败，不自动换端口；扩展自动连接要求使用 4318 |
| `OBU_SERVICE_URL` | Electron 连接已有本机服务的 HTTP 根地址，不包含 `/v1`；使用相同 `OBU_API_TOKEN` |
| `OBU_PUBLISH_HOST` / `OBU_PUBLISH_PORT` | Compose 发布地址，默认 `127.0.0.1:4319`，不是 Node 服务的监听配置 |

桌面和独立服务都不会在中继端口冲突时自动换端口。扩展固定连接 `127.0.0.1:4318`；使用扩展时保持 `PORT` / `OBU_DESKTOP_PORT` 为 4318 或不设置。自定义中继端口仅适用于不使用扩展的场景。HTTP Token 与模型 Key 分别管理；扩展无需配置令牌。部署与 Windows 启动命令见 [服务部署](service.md)。

## 浏览器与目录

| 变量 | 默认值或说明 |
|---|---|
| `BROWSER_MODE` | `ephemeral`；桌面及标准服务还支持 `persistent`、`extension`。MCP 仅支持前两种 |
| `BROWSER_CHANNEL` | 自动选择已安装的 Chrome → Edge → Playwright Chromium；可指定 `chrome`、`msedge`、`chromium` |
| `BROWSER_HEADLESS` | 独立服务默认无界面，设 `0` 显示；Electron/MCP 默认显示，设 `1` 隐藏。扩展模式使用已有 Chrome 窗口 |
| `BROWSER_PROFILE_DIR` | `~/.openbrowseruse/profile`，持久化浏览器目录 |
| `OBU_DATA_DIR` | `~/.openbrowseruse`，应用数据目录 |
| `OBU_WORKBENCH_ORIGIN` | MCP 的管理地址保护配置，默认 `http://127.0.0.1:4318`（设置 `PORT` 时随之改变） |

`~` 表示当前用户目录；Windows 默认位于用户主目录下的 `.openbrowseruse`。**修改 `OBU_DATA_DIR` 不会改变默认 `BROWSER_PROFILE_DIR`**。多个实例必须分开应用数据目录，也不能同时打开同一个持久化浏览器目录。

应用数据包括 `model-config.json`、`sessions.db`、`queue-key`、`permissions.json` 和运行时锁。备份时先停止拥有数据的后台，再保存数据目录；需要登录状态时另行备份浏览器配置目录。队列负载使用 `queue-key` 加密，不要只备份数据库或单独删除密钥。

生命周期设置由桌面或 API 管理：历史保留默认 0 天（永久）、闲置超时 900 秒、最多等待 100 项任务，详见 [会话清理](api.md#会话清理)。

## 上下文与数据范围

上下文窗口默认 128,000 token，输出预留默认 16,000，实际最多为窗口的四分之一；通过模型设置调整，不根据模型名称猜测容量。估算和压缩机制见 [开发与发布](development.md#上下文与执行机制)。

模型会收到任务、网页文字、截图和工具结果。已识别的敏感文字会在公开记录、历史和导出中脱敏，浏览器操作和模型上下文仍使用原始值；自由文本和截图无法保证自动识别所有秘密。
