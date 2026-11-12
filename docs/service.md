# 外部服务部署

[返回文档导航](README.md) · [配置参考](configuration.md)

服务可以独立于 Electron 运行。外部系统通过 HTTP JSON 提交任务，用轮询或 SSE 获取执行状态及结果。推荐独立任务使用 `/v1/jobs`，需要同一浏览器续聊时使用 Session/Run 接口。完整字段见 [API 文档](api.md)。

## 本机或服务器启动

```bash
npm ci --omit=dev
# 同一源码目录还需运行 Electron 时，改用 npm ci 安装完整依赖
npx playwright install --with-deps chromium
cp .env.example .env
# 编辑 .env：配置模型名称、地址、Key 和 API Token
npm run start:service
```

Windows PowerShell 用 `Copy-Item .env.example .env` 复制配置。可用以下跨平台命令生成随机 API Token，填入 `.env` 并保存给调用方：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`start:service` 自动读取 `.env`；`npm run api` 和 `npm start` 不自动读取，需由终端传入变量。已有模型及浏览器配置优先于环境变量。

服务默认无界面运行；`BROWSER_HEADLESS=0` 可在有桌面环境的机器上显示浏览器。默认监听 `127.0.0.1:4319`。设置 `OBU_API_HOST=0.0.0.0` 可接受其他机器的请求，也支持指定 IPv4/IPv6 地址。`OBU_API_PORT` 控制 HTTP 端口；旧 `PORT` 仍仅控制本机扩展中继，外部客户端不要使用中继端口。

`OBU_DATA_DIR` 控制 SQLite、配置及队列密钥的存储位置，默认使用用户目录。建议服务使用独立数据目录；保存过的模型配置优先于环境变量。不要让多个实例共享同一目录。环境变量修改后需要重启。

## 本机 Chrome 扩展模式

服务和 Chrome 都在本机时，可以在 `.env` 设置 `BROWSER_MODE=extension`，直接运行 `npm run start:service`。在 Chrome 加载 `extension/` 目录后，扩展自动连接 `127.0.0.1:4318`，无需输入地址或令牌。保持中继端口为 4318；未启动服务时侧边栏显示“等待本机服务”，服务启动后自动重连。标准 API 仍要求 `OBU_API_TOKEN`。Chrome 和扩展保持运行，外部调用方仍使用 HTTP API 端口 4319。

同一台机器只运行一套供扩展连接的后台；端口已占用时不会自动切换。若独立服务已经运行，桌面会自动连接同一用户的本机服务。

若已经保存过浏览器设置，先在桌面修改为扩展模式，环境变量不会覆盖正常的已保存配置。旧 CDP、Anthropic 配置的处理见 [升级与迁移](migration.md)。模型参数见 [配置参考](configuration.md)。

## Electron 连接已运行的本机服务（含 Windows）

直接启动 Electron 即可。它先按中继端口查询用户级服务索引，再查询当前数据目录中的服务记录：

- 找到服务：自动使用记录中的本机地址和凭据连接，不启动第二个后台。退出桌面仅断开连接，服务、浏览器和任务继续运行。
- 没有服务（或遗留记录对应的服务已退出）：启动并拥有自己的后台，退出应用时关闭。若设置 `OBU_API_ENABLED=1`，自带后台同时提供标准 API。
- 已发现服务但鉴权失败、协议不兼容或连接超时：明确报错，不启动替代后台。

Windows PowerShell 示例，先在一个终端启动服务（提前配置 `.env` 中的模型和 API Token）：

```powershell
npm run start:service
```

另一个终端直接启动桌面，也可双击打包应用：

```powershell
npm start
```

默认双方使用 `~/.openbrowseruse`，无需设置 `OBU_SERVICE_URL` 或重复填写 Token。服务可使用自定义 `OBU_DATA_DIR`，桌面通过用户级索引自动找到它，无需使用相同目录。默认按 4318 中继端口查找；自定义中继端口时桌面需使用相同 `PORT` / `OBU_DESKTOP_PORT`。仅绑定非本机网卡的服务和容器内的数据目录不参与默认自动发现。

服务就绪后将本机地址、PID 和 API Token 写入数据目录中的 `runtime-service.json`，同时写入 `~/.openbrowseruse/services/relay-<端口>.json` 用户级索引（文件创建权限 `0600`），正常停止时删除。端口或数据目录被占用时，桌面会短暂重试发现，兼容服务正在启动的情况。凭据只供本机用户的后台进程读取，不传给 renderer、不通过 API 返回。外部 API 调用仍必须提供 Bearer Token。Windows 上请使用当前用户私有的数据目录。

`OBU_SERVICE_URL` 仍可作为高级选项指定其他数据目录中的服务，需同时设置对应 `OBU_API_TOKEN`。只接受本机 HTTP 根地址（127.0.0.1、localhost 或 ::1），不含 `/v1`；显式指定但连接失败时不会回退到自带后台。

连接成功后顶部显示“已连接独立服务”。服务暂时断开时，桌面自动重新订阅状态、画面和代理光标，不重发命令，也不改为启动自带后台。需要切回自带后台时先停止独立服务、清除显式 `OBU_SERVICE_URL`（若有），再重新打开 Electron。

桌面桥接使用 `/internal/desktop/v1/request` 与 `/internal/desktop/v1/events`，与标准业务 API 共享鉴权和请求体上限，并额外限制为本机连接及允许的操作清单。桥接不提供服务退出命令；它是内部桌面协议，不替代外部系统使用的 `/v1` API。桌面桥接命令不自动重试，也不使用业务 API 的幂等键约定。

## Docker Compose

先准备 `.env`，然后：

```bash
docker compose up -d --build
docker compose logs -f browser
curl http://127.0.0.1:4319/readyz
```

镜像仅安装服务运行依赖和匹配版本的 Chromium，不启动 Electron；以非 root 用户运行。Compose 提供持久化命名卷、浏览器共享内存、健康检查、自动重启和 30 秒退出宽限。

默认只向宿主机 loopback 发布端口，便于在宿主机使用 HTTPS 反向代理；[Nginx 配置示例](../deploy/nginx.conf.example)关闭 SSE 缓冲。局域网直接访问可在 `.env` 设置 `OBU_PUBLISH_HOST=0.0.0.0` 后重新创建容器。外网部署应通过 HTTPS 入口传输 Bearer Token，并限制网络访问。模型 Key 只配置在服务端，不提供给调用方。

容器默认使用 ephemeral 浏览器；若需要持久化登录，额外设置 `BROWSER_MODE=persistent` 和 `BROWSER_PROFILE_DIR=/data/profile`，因为 `OBU_DATA_DIR=/data` 不会改变浏览器配置目录。桌面 Chrome 扩展和宿主机登录状态不会自动进入容器；现有 Compose 也未发布扩展中继端口，需要连接宿主机 Chrome 时优先使用本机 Node 服务。备份需要同时保存数据卷中的数据库和 `queue-key`；不要执行 `docker compose down -v`，除非确实要删除全部数据。

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
