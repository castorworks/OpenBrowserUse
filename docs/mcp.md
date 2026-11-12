# MCP 接入

[返回文档导航](README.md)

面向外部业务系统，现已提供可选的 HTTP API，见 [使用说明](api.md) 和 [OpenAPI 契约](openapi.json)。它负责自然语言任务的执行管理；下述 stdio MCP 提供底层浏览器工具。

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

MCP 服务器直接执行所暴露的工具，不读取网站权限或拦截密码、文件、支付字段。`javascript` 默认可用，旧 `MCP_ALLOW_JAVASCRIPT` 开关不再生效。浏览器在第一次调用工具时启动，客户端断开时关闭。可用环境变量：`BROWSER_MODE=ephemeral|persistent`、`BROWSER_PROFILE_DIR`、`BROWSER_HEADLESS=1`、`OBU_DATA_DIR`、`OBU_WORKBENCH_ORIGIN`（默认 `http://127.0.0.1:4318`）。

注意：持久化配置同一时间只能被一个浏览器使用，工作台和 MCP 服务器不要同时用 `persistent` 模式。


## 与 HTTP 服务的区别

HTTP 服务接收自然语言目标，由服务端模型驱动任务；MCP 暴露工具，模型决策在调用方，不需要本服务的模型 Key。移除 Anthropic 模型接口不影响 MCP 客户端接入。

MCP 自己创建浏览器，不连接标准服务的任务队列，也不支持 Chrome 扩展中继。当前实现对 `BROWSER_MODE=extension` 回退为独立会话，因此 MCP 应明确只配置 `ephemeral` 或 `persistent`。直接 CDP 模式会报错。

不要让 MCP 与其他实例同时使用同一个持久化浏览器目录；可通过 `BROWSER_PROFILE_DIR` 为 MCP 指定独立目录。完整变量说明见 [配置参考](configuration.md)。以上客户端配置示例中的路径需要替换为本机绝对路径。
