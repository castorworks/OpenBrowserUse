# 外部服务部署

服务可以独立于 Electron 运行。外部系统通过 HTTP JSON 提交任务，用轮询或 SSE 获取执行状态及结果。推荐独立任务使用 `/v1/jobs`，需要同一浏览器续聊时使用 Session/Run 接口。完整字段见 [API 文档](api.md)。

## 本机或服务器启动

```bash
npm ci --omit=dev
npx playwright install --with-deps chromium
cp .env.example .env
# 编辑 .env：配置模型名称、地址、Key，并填入 openssl rand -hex 32 生成的 API Token
npm run start:service
```

服务默认无界面运行；`BROWSER_HEADLESS=0` 可在有桌面环境的机器上显示浏览器。默认监听 `127.0.0.1:4319`。设置 `OBU_API_HOST=0.0.0.0` 可接受其他机器的请求，也支持指定 IPv4/IPv6 地址。`OBU_API_PORT` 控制 HTTP 端口；旧 `PORT` 仍仅控制本机扩展中继，外部客户端不要使用中继端口。

`OBU_DATA_DIR` 控制 SQLite、配置及队列密钥的存储位置，默认使用用户目录。建议服务使用独立数据目录；保存过的模型配置优先于环境变量。不要让多个实例共享同一目录。环境变量修改后需要重启。

## Docker Compose

先准备 `.env`，然后：

```bash
docker compose up -d --build
docker compose logs -f browser
curl http://127.0.0.1:4319/readyz
```

镜像仅安装服务运行依赖和匹配版本的 Chromium，不启动 Electron；以非 root 用户运行。Compose 提供持久化命名卷、浏览器共享内存、健康检查、自动重启和 30 秒退出宽限。

默认只向宿主机 loopback 发布端口，便于在宿主机使用 HTTPS 反向代理；[Nginx 配置示例](../deploy/nginx.conf.example)关闭 SSE 缓冲。局域网直接访问可在 `.env` 设置 `OBU_PUBLISH_HOST=0.0.0.0` 后重新创建容器。外网部署应通过 HTTPS 入口传输 Bearer Token，并限制网络访问。模型 Key 只配置在服务端，不提供给调用方。

容器中使用 ephemeral 浏览器即可；桌面 Chrome 扩展和宿主机登录状态不会自动进入容器。备份需要同时保存数据卷中的数据库和 `queue-key`；不要执行 `docker compose down -v`，除非确实要删除全部数据。

## 外部调用

```bash
export OBU_API_URL='http://127.0.0.1:4319'
# 使用服务端配置的 OBU_API_TOKEN
node --env-file=.env examples/submit-job.mjs '打开 https://example.com 并概括内容'
```

示例提交一次任务并轮询，输出 Job/Run ID 与最终结果；等待人工输入时返回提示。网络中断后使用已输出的 ID 查询，不要重新提交同一个业务任务。生产接入方应为每个业务请求保存稳定的 `Idempotency-Key`，重试沿用原 key；不同业务请求使用不同 key。

- `GET /healthz`、`GET /readyz`：无鉴权的最小进程健康检查，不返回业务数据；初始化完成后才监听，退出时停止接受新任务。健康不代表模型凭据有效，也不代表浏览器有空闲容量。
- `GET /v1/status`：带 Bearer Token 获取容量与当前占用。
- `GET /v1/openapi.json`：带 Bearer Token 获取机器可读契约，可用于生成客户端；servers 使用相对 `/v1`。
- `POST /v1/jobs`：返回 202 与 Job/Session/Run ID。轮询 Job 或订阅 `/v1/runs/{id}/events/stream`。
- SIGINT/SIGTERM：关闭事件流、停止后台并释放资源；最多等待 25 秒。重启不会自动重放已开始的浏览器动作，未开始的队列任务继续调度。

这是单租户服务：同一个 Token 的调用方共享历史和控制权限，一个实例同时执行一个浏览器任务，其余任务排队。尚不提供租户隔离、并行浏览器池、Webhook 或浏览器直连 CORS。网页产品应由自己的后端调用本服务，避免把服务 Token 放入前端。扩容应使用独立数据目录的实例，由上游按 Session 粘性路由，不能直接把续聊请求随机分配到多个实例。

## 本机 Chrome 扩展模式

服务和 Chrome 都在本机时，可以在 `.env` 设置 `BROWSER_MODE=extension`，直接运行 `npm run start:service`。在 Chrome 加载 `extension/` 目录，打开扩展侧边栏，将服务器地址设为 `http://127.0.0.1:4318`，配对令牌读取数据目录中的 `extension-token` 文件（默认 `~/.openbrowseruse/extension-token`）。扩展令牌与 HTTP API Token 是两个独立凭据。Chrome 和扩展保持运行，外部调用方仍使用 HTTP API 端口 4319。

直接 CDP 连接模式已移除。旧配置不会自动换用另一个浏览器执行任务：桌面用户需要在浏览器设置中重新选择并保存模式；独立服务可显式设置 `BROWSER_MODE=extension|persistent|ephemeral` 完成旧配置迁移。`BROWSER_MODE=cdp` 会提示错误，`BROWSER_CDP_URL` 不再使用。旧历史保留原模式名称；尚未执行的旧 CDP 队列任务标记失败，需选好新模式后重新提交。

## 模型协议

仅支持 OpenAI 兼容 Chat Completions 和 DeepSeek，不再提供 Anthropic Messages 接口或读取 Anthropic 凭据。MCP 接口继续保留，Claude Code 等 MCP 客户端仍可使用浏览器工具，它们不通过本服务调用模型。

旧 Anthropic 配置会要求重新配置模型名称、地址和 Key，旧 Key 不会复用到其他服务。桌面中保存新的模型设置即可；独立服务可显式设置 `MODEL_PROVIDER=openai|deepseek`、`MODEL_NAME`、`MODEL_BASE_URL`、`MODEL_API_KEY` 后重启完成迁移。未开始的旧 Anthropic 队列任务会失败，需重新配置后提交；历史结果仍可查看。
