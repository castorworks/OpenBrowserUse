# HTTP API 使用说明

[返回文档导航](README.md) · [服务部署](service.md)

本页描述已实现的 v1 接口（契约版本 1.2.0）。机器可读契约见 [OpenAPI 3.1.1](openapi.json)。历史提案见 [归档设计](archive/api-v1-design.md)，不属于当前接口契约。

## 启动

独立部署、Docker 和外部调用示例见 [服务部署](service.md)。在线契约为 `GET /v1/openapi.json`（需 Bearer Token）。

默认 API 根地址为 `http://127.0.0.1:4319/v1`。推荐使用 `npm run start:service` 读取 `.env` 启动；`npm run api` 使用进程环境变量。模型、鉴权 Token、浏览器和数据目录配置见 [配置参考](configuration.md)。

Electron 可启用自带后台的 HTTP API，或连接已有服务；两种模式和 Windows 命令见 [服务部署](service.md)。不要同时运行两个共享数据目录的后台。

## 最小调用

公开 `/v1` 接口的所有请求带 `Authorization: Bearer <token>`。POST 和 DELETE 都必须带 `Idempotency-Key`；POST 还必须带 `Content-Type: application/json`，无参数 POST 发送 `{}`，DELETE 可以不带请求体。同一请求重试使用原 key；不同请求用新 key。同 key 不同 JSON 参数返回 409。

```bash
curl http://127.0.0.1:4319/v1/sessions \
  -H "Authorization: Bearer $OBU_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: session-001' \
  -d '{"permission_mode":"skip"}'
```

保存响应中的 `id` 为 SESSION_ID。创建会话预留唯一槽位，但不会立刻启动浏览器。

```bash
curl "http://127.0.0.1:4319/v1/sessions/$SESSION_ID/runs" \
  -H "Authorization: Bearer $OBU_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: run-001' \
  -d '{"goal":"概括页面内容","start_url":"https://example.com"}'
```

返回 202 和 Run.id，保存为 RUN_ID。202 表示请求已持久化接收，不表示任务已完成。每秒轮询即可：

```bash
curl "http://127.0.0.1:4319/v1/runs/$RUN_ID" \
  -H "Authorization: Bearer $OBU_API_TOKEN"
```

completed、failed、cancelled、interrupted 为终态。completed 的 `result.outcome` 仍为 unverified；最终文字不能代替业务结果核验。failed 的原因在 `error`。HTTP 错误为 `application/problem+json`，响应头 X-Request-ID 用于定位请求。

续聊时向同一 Session 创建新 Run，仅传 goal。每轮保留独立 ID、结果、指标；不再覆盖前一轮。start_url 只允许首轮使用。模型与浏览器设置在会话关闭前不能修改。

## 已实现端点

路径均相对 `/v1`：

| 端点 | 用途 |
|---|---|
| GET /status | 状态、当前占用、能力与请求体上限 |
| POST /sessions | 创建会话；browser_mode 必须匹配服务端配置，permission_mode 为 ask/auto/skip，默认 skip |
| GET /sessions | 会话列表 |
| GET /sessions/{id} | 会话详情 |
| POST /sessions/{id}/runs | 首轮目标或后续目标 |
| GET /sessions/{id}/runs | 历次执行 |
| POST /sessions/{id}/close | 关闭浏览器并释放槽位；首次返回 202，轮询 Session 确认 closed；已关闭返回 200 |
| DELETE /sessions/{id} | 删除已关闭会话、执行、事件、存档；相关幂等请求保留为墓碑 |
| GET /sessions/{id}/screenshot | 新鲜截图，`format=jpeg`（默认）或 `png` |
| GET /sessions/{id}/cursor | 最新代理光标位置和反馈，不含输入内容 |
| GET /sessions/{id}/export | 完整脱敏 JSON 导出，响应为附件 |
| GET /runs/{id}/events | 持久化事件分页，`after=序号`、`limit=1…400` |
| GET /runs/{id}/events/stream | SSE 回放与实时订阅，支持 Last-Event-ID |
| POST /jobs | 提交独立 FIFO 任务，分配 Job、Session 和 Run ID |
| GET /jobs、GET /jobs/{id} | 队列任务列表与详情 |
| POST /jobs/{id}/cancel | 取消排队或正在执行的任务 |
| GET /settings/lifecycle | 读取保留期限、闲置超时、队列容量 |
| POST /settings/lifecycle | 保存生命周期设置（所有字段必填） |
| GET /runs/{id} | 执行状态、结果与指标 |
| POST /runs/{id}/messages | 执行中的补充指令：`{"text":"…"}` |
| POST /runs/{id}/pause | 请求暂停；等待 paused 后才能接管 |
| POST /runs/{id}/resume | 仅恢复 paused |
| POST /runs/{id}/cancel | 停止执行并关闭浏览器；等待 cancelled |
| GET /runs/{id}/interactions | 交互列表，可加 `status=pending` |
| POST /runs/{id}/interactions/{interaction_id}/response | 按 ID 回答问题或决定是否批准 |
| POST /runs/{id}/recover | 从该会话最后一轮的检查点创建新 Session 和 Run |

列表支持 limit（默认 50，最多 200）和不透明 cursor；返回 `{data,next_cursor}`，next_cursor 为 null 表示末页。按创建时间、ID 倒序排列。

只有一个 open 会话、一个活动 Run；等待用户和暂停仍占槽位。直接创建会话/执行遇到占用时返回 409；需要排队时使用 POST /jobs。队列不抢占已有交互会话，存在待执行队列时新建交互会话返回 409 queue_pending。桌面和 HTTP 共用同一锁及会话，桌面中的新执行也会出现在 API 中。关闭有活动 Run 的会话返回 409，应先取消并等待完成。

关闭浏览器失败时会话保持 open，并带 error.code=cleanup_failed；使用新 key 重试关闭。取消只停止后续动作，不撤销网页上已经发生的提交。

## 人工交互

当 Run.status 为 waiting_input 或 waiting_approval，读取 pending_interaction_id 和交互详情。提问回复使用 `{"answer":"已登录，可以继续"}`；审批回复使用 `{"decision":"approve"}`，其他决策为 reject/approve_site/deny_site，且必须出现在当前交互的 allowed_decisions 中。

旧交互已解决或过期时，新请求返回 409；使用相同 key 重试已接受的回复返回原响应。不能通过 resume 或 messages 绕过待回答交互。桌面也使用交互 ID，延迟到达的回复不会批准下一步动作。

## 重启与恢复

后台重启后，已经启动但未结束的 Run 标记 interrupted，未决交互标记 expired，相应会话关闭；不会自动重跑执行过的请求或重放历史浏览器动作。尚未启动的 queued 任务继续按原顺序调度。客户端可读取历史结果，然后显式请求 recover。恢复创建新会话和新 Run，并记录 recovered_from_run_id；重新建立浏览器后先核验页面。原 Run 保留不变。

目前检查点仍按会话保存，所以只有最后一轮可恢复。更早轮次返回 409 checkpoint_unavailable；历史结果仍可查询。旧版本历史保持原格式，可从桌面读取和恢复，不伪造无法还原的历史轮次。

幂等记录存入同一 SQLite 数据库，当前不自动清理。重启后相同 key 返回原接收响应，可能仍显示 starting；必须通过返回的 ID 获取最新状态。幂等保证不重复接收，不保证外部网站副作用恰好发生一次。

## SSE 实时事件

```bash
curl -N "http://127.0.0.1:4319/v1/runs/$RUN_ID/events/stream" \
  -H "Authorization: Bearer $OBU_API_TOKEN"
# 重连时携带最后一条已处理事件的 id（格式为 run_id:sequence）
curl -N "http://127.0.0.1:4319/v1/runs/$RUN_ID/events/stream" \
  -H "Authorization: Bearer $OBU_API_TOKEN" \
  -H "Last-Event-ID: $LAST_EVENT_ID"
```

事件包含 id、run_id、sequence、type、created_at、data。类型为 run.created、run.status_changed、run.finished、message.created、tool.started、tool.completed、interaction.created/resolved/expired 和 cursor.updated。工具事件使用 tool_call_id 配对。

状态变更与对应事件在同一事务中持久化，订阅时先回放，再继续接收实时事件；Last-Event-ID 优先于 after。至少一次投递，客户端按 id 去重。每 15 秒发注释心跳；慢客户端受到有界缓冲限制，断线后从最后已处理 ID 重连。终态事件回放完成后关闭流，客户端应停止重连；后台关闭会结束流，重启后可重新读取状态。

事件中的长文本超过 16,000 字符会截断，并标记 truncated=true；完整结果从 Run 或导出获取。升级前的执行只有历史状态快照，不伪造旧工具事件。SSE 不传图片字节。

## 截图、导出与虚拟鼠标

截图接口返回原始 JPEG/PNG，可直接保存为文件；完成后保留浏览器的交互会话仍能截图，关闭后返回 409。导出返回完整会话、各轮结果、事件、交互、检查点和资料存档，不包括模型配置或截图。所有结果与截图均不缓存。

桌面在实时画面上叠加橙色代理光标、操作标签、点击波纹和拖动轨迹；支持窗口缩放与减少动画偏好。它只是操作反馈，不接管系统鼠标，也不修改网页内容。截图不会烘焙这层光标。

API 接入方可从 cursor.updated 事件或 GET /sessions/{id}/cursor 读取 coordinate、viewport、action、phase，以及拖动的 start_coordinate/end_coordinate。坐标以浏览器视口 CSS 像素为单位；按截图等比缩放后的内容区域换算，注意留白偏移。visible=false 表示隐藏；工作台在最后一个反馈后约 2.5 秒淡出光标，其他接入方可按 at 自行实现同样的超时隐藏。输入操作只报告类型与位置，不包含文字、按键内容或密码。

## 串行任务队列

```bash
curl http://127.0.0.1:4319/v1/jobs \
  -H "Authorization: Bearer $OBU_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: job-001' \
  -d '{"goal":"读取示例页并总结","start_url":"https://example.com","permission_mode":"skip"}'
```

返回 202 Job，含 session_id、run_id，可立即订阅该 Run 的 SSE。Job.status 为 queued/running/completed/failed/cancelled/interrupted，run_status 提供实际执行状态（如 waiting_input）。任务按持久化的 queue_sequence FIFO 顺序启动，始终只有一个浏览器会话执行。每个任务使用独立会话上下文；persistent/extension 模式仍使用所配置的登录状态。

提交时冻结服务端模型和浏览器配置。待执行的原始指令、配置使用 AES-256-GCM 加密存入数据库，密钥位于数据目录的 queue-key（仅本机用户可读写）；不要单独删除该密钥。队列原始负载在开始执行或取消时删除，公开记录仍经过脱敏。配置后来发生变化，不影响已经排队的任务。

排队任务完成、失败或取消后，调度器自动关闭它的浏览器并启动下一项。等待人工回复、审批或暂停时不会跳过它。任务管理的会话不能另建续聊 Run；需续聊时使用普通交互会话，或在任务完成后恢复检查点。队列满时返回 409 queue_full，默认最多等待 100 项。

桌面的“加入队列”可以直接提交任务，浏览器下方可查看和取消任务。已有交互会话会阻塞队列，请关闭该会话，或等待闲置超时自动关闭。

## 会话清理

设置在桌面“设置 → 会话与队列”或 POST /settings/lifecycle 修改：

```json
{"history_retention_days":30,"idle_timeout_seconds":900,"max_queued_jobs":100}
```

history_retention_days 默认 0，表示永久保留；非零时自动删除到期的已关闭会话、执行、事件、队列记录和检查点（包括旧桌面历史）。idle_timeout_seconds 默认 900；0 禁用，执行中、暂停、等待用户或审批不会被当作闲置。清理检查约每 5 秒一次，GET 查询不会延长闲置期限。

DELETE /sessions/{id} 仅允许已关闭会话；排队或执行中的任务应先取消。删除响应为 204，相同删除请求可安全重试；与已删除资源关联的旧创建/控制请求 key 返回 410 resource_deleted，不会重新创建资源。已打开的历史事件流会结束。幂等墓碑保留，避免旧请求复活已清理数据。

## 当前边界

- 服务面向单租户调用，默认绑定 IPv4 loopback，可通过 OBU_API_HOST 设置外部监听地址；部署见 [服务部署](service.md)。除 /healthz 和 /readyz 的最小健康信息外，所有端点鉴权；来自网页的 Origin/Sec-Fetch-Site 请求被拒绝，不支持浏览器 CORS 客户端。Token 至少 32 个非空白字符。
- HTTP JSON 请求体最大 8 MiB，内部桌面桥接也使用该上限；桌面自带后台的 IPC 不受 HTTP 请求体上限约束。
- API 不返回模型 Key 或配对令牌，输出及持久化记录经过现有脱敏逻辑；任意自由文本仍无法保证识别所有秘密。
- 已实现 SSE、HTTP 截图/导出/删除、FIFO 队列和生命周期管理。尚未提供多浏览器并发、Webhook、多用户或 SDK。

测试范围与运行方法见 [开发与发布](development.md#测试范围)。

## 浏览器模式变更

可创建的浏览器模式仅为 `ephemeral`、`persistent`、`extension`。直接 CDP 模式已移除，创建会话时传 `browser_mode=cdp` 返回 422。旧配置尚未重新选择模式时，创建会话和提交队列返回 409 `browser_selection_required`；迁移方法见 [升级与迁移](migration.md)。历史会话保留原模式名称用于审计，不代表该模式仍可使用。
