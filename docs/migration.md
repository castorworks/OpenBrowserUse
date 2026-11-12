# 升级与迁移

[返回文档导航](README.md)

升级前先停止后台并备份应用数据；若使用持久化登录，同时备份浏览器配置目录，目录说明见 [配置参考](configuration.md)。更新源码后运行 `npm ci`，使用扩展时在 `chrome://extensions` 重新加载扩展。

## 直接 CDP 模式已移除

当前可选浏览器模式为 `ephemeral`、`persistent`、`extension`。`BROWSER_MODE=cdp` 会报错，`BROWSER_CDP_URL` 不再使用。这不代表移除了扩展内部使用的 CDP 中继协议。

旧 CDP 配置不会静默换用另一个浏览器执行任务：桌面用户需重新选择并保存浏览器模式；独立服务可显式设置有效的 `BROWSER_MODE` 后重启完成迁移。未完成选择时，API 创建会话和提交任务返回 `409 browser_selection_required`；显式请求 `browser_mode=cdp` 返回 422。

旧历史保留原模式名称。尚未执行的旧 CDP 队列任务标记失败，需选好模式后重新提交。需要使用自己的 Chrome 登录状态时，按 [扩展自动连接说明](desktop.md#chrome-扩展自动连接)操作。

## Anthropic 模型接口已移除

当前仅保留 OpenAI 兼容 Chat Completions 与 DeepSeek；不再提供 Anthropic Messages 或读取其环境变量凭据。MCP 继续保留，Claude Code 等外部 MCP 客户端仍可使用浏览器工具。

读取旧 Anthropic 配置时，运行时会清空旧模型、地址及 Key 并要求重新配置，不会把旧 Key 发送给其他服务。桌面保存新模型设置即可；独立服务可显式设置 `MODEL_PROVIDER=openai|deepseek`、`MODEL_NAME`、`MODEL_BASE_URL`、`MODEL_API_KEY` 后重启完成迁移。磁盘中的旧配置只有保存新配置后才被替换。

未开始的旧 Anthropic 队列任务会失败，需重新配置后提交。历史结果继续保留。

## 任务状态与恢复

桌面和 HTTP 统一通过任务服务管理 Session、Run、Job。每轮续聊创建独立 Run，已经结束的结果不会被后续关闭会话改写。恢复带 Run 元数据的检查点会创建新 Session 和 Run，保留原记录；只有最后一轮有可恢复的会话检查点。

旧版本无 Run 元数据的历史仍使用兼容读取与恢复路径，不生成无法还原的历史轮次。重启后已开始的任务标记 interrupted，不自动重放浏览器操作；未开始的有效队列任务继续调度。

## Electron 与独立服务共用后台

桌面默认自动连接同一用户已运行的本机服务（按中继端口发现，支持不同数据目录），没有服务时才启动自己的后台，见 [双终端启动示例](service.md#electron-连接已运行的本机服务含-windows)。升级后重启独立服务以生成发现记录，再启动 Electron，无需手填 URL 或 Token。旧 `OBU_SERVICE_URL` 保留为显式覆盖；清除它后恢复自动发现。连接已有服务时退出桌面不会停止服务。

不要同时启动两个共享应用数据目录的后台。接入模式下 Electron 不打开服务数据库或申请运行时锁。

旧的 localhost / 内网访问开关已从界面、保存配置和浏览器参数中移除；读取旧配置时忽略这些字段，旧桌面发送的字段仍可被接收但不保存。`BROWSER_ALLOW_LOCALHOST`、`BROWSER_ALLOW_PRIVATE` 及 `MCP_ALLOW_JAVASCRIPT` 不再控制工具执行；当前权限行为见 [桌面权限说明](desktop.md) 和 [MCP 接入](mcp.md)。


## 扩展自动连接取代手动配对

重新加载 Chrome 扩展并重启后台后，扩展固定连接 `127.0.0.1:4318`。旧扩展中的服务器地址和令牌不再读取；应用不再生成或使用 `extension-token` 文件，遗留文件可删除。扩展移除了 storage 权限及配对页面，桌面移除了令牌复制入口和内部配对接口。

若原先使用自定义中继端口，请改回 4318。桌面不再在端口冲突时切换到随机端口；已有独立服务时桌面自动连接同一用户的服务，避免启动第二个后台。`OBU_API_TOKEN` 仍用于标准 API 和 Electron 连接已有服务，不受本次变更影响。

用户级跨目录发现需要更新后的独立服务生成索引。如果升级后仍提示 4318 被占用，请重启独立服务后再打开 Electron；不会强制终止不明的端口占用进程。
