# Open Browser Use

本地运行的 AI 浏览器代理。通过桌面工作台或 HTTP API 提交目标，代理读取网页、点击、输入并返回结果；也可通过 MCP 向外部代理提供浏览器工具。

支持 OpenAI 兼容 Chat Completions 与 DeepSeek，提供 Chrome 扩展、持久化登录、任务队列、实时画面和代理光标反馈。

## 选择使用方式

| 需求 | 入口 | 说明 |
|---|---|---|
| 在桌面操作、查看任务 | `npm start` | Electron 默认启动自己的后台 |
| 让其他程序提交任务 | `npm run start:service` | 独立 HTTP 服务，支持轮询与 SSE |
| 桌面查看已有服务的任务 | 设置 `OBU_SERVICE_URL` 后启动 Electron | 共享任务；退出桌面不停止服务 |
| 让外部代理调用浏览器工具 | `npm run mcp` | stdio MCP，由调用方负责决策 |

## 快速开始

源码运行需要 Node.js 22.12+、npm，以及 Chrome / Edge 或 Playwright Chromium。

```bash
npm ci
# 未安装 Chrome / Edge 时：
npx playwright install chromium
npm start
```

在设置中填写模型名称、Base URL 和 API Key，选择浏览器模式，再输入目标。也可以先点击“本地演示”，无需模型凭据；演示使用固定脚本。

独立服务：

```bash
cp .env.example .env
# 填写模型配置和至少 32 位无空白字符的随机 API Token
npm run start:service
```

Windows PowerShell 使用 `Copy-Item .env.example .env`。默认 API 地址是 `http://127.0.0.1:4319/v1`；Chrome 扩展连接的是中继端口 4318。Windows 双终端启动及 Docker 部署见 [服务部署指南](docs/service.md)。

## 文档

- [文档导航](docs/README.md)：按使用场景查找文档。
- [桌面与 Chrome 扩展](docs/desktop.md)：任务操作、配对、权限和历史。
- [服务部署](docs/service.md)：本机服务、Electron 连接已有服务、Docker。
- [HTTP API](docs/api.md) · [OpenAPI 契约](docs/openapi.json)：外部系统接入。
- [配置参考](docs/configuration.md)：模型、环境变量、端口和数据目录。
- [MCP 接入](docs/mcp.md)：外部代理使用浏览器工具。
- [架构边界](docs/architecture.md) · [开发与发布](docs/development.md)。
- [升级与迁移](docs/migration.md)：移除的模式、旧配置及历史兼容。

## 当前范围

一个服务实例同时执行一个浏览器任务，其余任务可进入 FIFO 队列。同一 API Token 共享历史和控制权限；目前没有多租户隔离、并行浏览器池或 Webhook，也不提供网页工作台。

浏览器模式为独立会话、持久化配置和 Chrome 扩展。直接 CDP 连接及 Anthropic 模型接口已移除，MCP 保留。模型回答完成不代表业务操作已验证成功；取消任务不会撤销网页上已经发生的操作。
