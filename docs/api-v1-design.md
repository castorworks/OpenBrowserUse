# OpenBrowserUse HTTP API v1 设计

状态：完整目标设计，已实现首版子集。日期：2026-11-11。基于仓库 v0.3.1。

当前可用端点、限制和行为以 [使用说明](api.md) 及 [OpenAPI 契约](openapi.json) 为准。已增加 SSE、截图、导出、删除、FIFO 队列、生命周期管理及虚拟光标。关闭会话异步返回 202；只恢复会话最后一轮检查点；历史迁移采用新增表及保留旧记录方式。下文保留最初设计背景，与现行接口不一致之处以使用说明为准。

## 1. 目标与范围

让业务系统通过 HTTP 提交自然语言目标、跟踪浏览器代理执行、处理人工确认并取得结果。采用 REST 风格资源、JSON、SSE 事件流；使用 OpenAPI 3.1.1 描述最终契约。现有 stdio MCP 继续提供底层浏览器工具。

首版服务单用户、单活动浏览器会话、单活动执行，不提供任务队列、多租户、Webhook、远程桌面或 HTTP 底层工具调用。暂停及等待人工输入仍占执行槽位；请求冲突立即返回 409。新增接口默认关闭，不改变桌面启动行为。

## 2. 部署与访问

- 建议新增独立 HTTP 监听器，默认 `127.0.0.1:4319`，前缀 `/v1`；扩展中继继续使用原端口。建议启动配置 `OBU_API_ENABLED=1`、`OBU_API_PORT=4319`、`OBU_API_TOKEN`，这些配置尚未实现。
- 桌面模式中，HTTP 与 IPC 使用同一个应用服务、执行锁及存储。后续增加 `bin/server.js` 无界面入口，复用相同服务；同一个数据目录只能启动一个拥有浏览器的后台进程。
- 所有端点（含状态、事件与图片）要求 `Authorization: Bearer <token>`。API token 独立于模型 Key、扩展配对令牌；禁止通过 URL 传 token。不返回配置密钥或配对令牌。
- 首版一个 token 代表本机所有者，可访问全部 API 会话。默认不启用 CORS，不使用 cookie；明确配置允许来源才支持浏览器跨域调用。远程访问须通过 HTTPS 入口，不能将本地单用户凭据模型描述为多租户授权。
- 浏览器代理的管理地址阻断必须增加 API 端口，同时覆盖 localhost 别名、IPv4/IPv6 和实际配置地址，避免网页经代理调用管理接口。
- 模型、浏览器模式、持久化目录由服务端配置；请求仅能选择已经配置的浏览器模式，不接受任意文件路径、模型 Key 或模型 Base URL。

## 3. 资源模型

**Session（会话）**保存浏览器生命周期及对话上下文；**Run（执行）**代表一次用户目标到代理结束的一轮执行。同一会话续聊创建新 Run，旧 Run 的结果不覆盖。**Interaction（交互）**代表一次待回答问题或待批准动作；必须按 ID 回复，避免延迟响应批准到另一个动作。

ID 使用 UUID，客户端当作不透明字符串。时间使用 UTC RFC 3339 字符串；JSON 字段统一 snake_case。响应只返回公开 DTO，不序列化 Agent、controller、原始 provider 上下文或密钥。

Session 字段：`id`、`status`（open/closed）、`browser_mode`（ephemeral/persistent/extension）、`browser_status`（not_started/starting/ready/closed）、`permission_mode`（ask/auto/skip）、`created_at`、`updated_at`、`active_run_id`（可空）、`last_run_id`（可空）、`model`（provider/name）。创建时固定配置快照；模型及权限设置在该会话内不可更改。permission_mode 默认 skip，与现有行为一致。

Run 字段：`id`、`session_id`、`status`、`goal`、`start_url`（可空）、`created_at`、`started_at`、`finished_at`（后两者可空）、`result`（可空）、`error`（可空）、`pending_interaction_id`（可空）、`recovered_from_run_id`（可空）、`metrics`、`revision`（单调递增整数）。metrics 提供模型请求数、工具调用数、重试数和 provider 原始 usage；未知 usage 为 null，不估算为零。

result 为 `{ "text": "…", "outcome": "unverified", "evidence": { "observed_page": { "url": "…", "title": "…" }, "failed_tools": 0 } }`；observed_page 可空。首版 outcome 只支持 unverified：completed 表示代理结束本轮回答，不代表业务操作已经验证成功。

## 4. 端点目录

所有路径相对 `/v1`。成功的单资源直接返回资源对象；列表返回 `{ "data": [], "next_cursor": null }`。

| 方法与路径 | 请求 / 行为 | 成功响应 |
|---|---|---|
| GET /status | 版本、ready、max_active_sessions=1、max_active_runs=1、占用情况、浏览器模式可用性 | 200 状态 |
| POST /sessions | `{browser_mode?, permission_mode?}`，默认使用服务端浏览器模式，预留会话槽位，浏览器延迟启动 | 201 Session + Location |
| GET /sessions | `cursor?`、`limit?` | 200 Session 列表 |
| GET /sessions/{session_id} | 获取会话 | 200 Session |
| POST /sessions/{session_id}/close | 空对象；要求无活动 Run，关闭浏览器，释放槽位 | 200 closed Session |
| DELETE /sessions/{session_id} | 仅允许 closed 且无活动 Run；删除会话、Run、事件与检查点 | 204 |
| POST /sessions/{session_id}/runs | `{goal, start_url?}`，创建一次执行；首轮和续聊使用相同入口 | 202 Run + Location |
| GET /sessions/{session_id}/runs | `cursor?`、`limit?` | 200 Run 列表 |
| GET /runs/{run_id} | 状态、最终结果与指标，不附完整历史 | 200 Run |
| POST /runs/{run_id}/messages | `{text}`，仅 starting/running 接受补充指令 | 201 `{id, run_id, text, created_at}` |
| POST /runs/{run_id}/pause | 空对象；请求在当前动作结束后暂停 | 202 Run |
| POST /runs/{run_id}/resume | 空对象；只恢复 paused | 202 Run |
| POST /runs/{run_id}/cancel | 空对象；停止执行并关闭该会话浏览器 | 202 Run；已 cancelled 则 200 |
| GET /runs/{run_id}/interactions | 返回历史交互，`status=pending` 可过滤；支持分页 | 200 Interaction 列表 |
| POST /runs/{run_id}/interactions/{interaction_id}/response | 见交互协议 | 200 已解决的 Interaction |
| GET /runs/{run_id}/events | `after?`（事件序号）、`limit?`；持久化事件，按序返回 | 200 `{data, next_after, has_more}` |
| GET /runs/{run_id}/events/stream | SSE，支持 Last-Event-ID 或 after | 200 text/event-stream |
| GET /sessions/{session_id}/screenshot | 当前可用的最新画面；无画面返回 409 screenshot_unavailable | 200 image/png 或 image/jpeg，以 Content-Type 为准 |
| GET /sessions/{session_id}/export | 导出脱敏的会话、全部 Run、事件和存档；无图片和凭据 | 200 application/json 附件 |
| POST /runs/{run_id}/recover | `{permission_mode?}`；从终态 Run 检查点建立新会话和新 Run | 202 新 Run + Location |

所有 POST 要求 `Content-Type: application/json` 和 `Idempotency-Key`。需要空请求体的操作发送 `{}`。异步 202 表示已持久化接收，执行失败在 Run.error 中报告。Location 指向资源详情；GET /runs 是轮询的主要入口，可返回 `Retry-After: 1`。

不提供批量执行、隐式排队或自动关闭其他客户端的会话。关闭活跃会话返回 409，客户端须先 cancel 并等待终态。closed 会话不能创建 Run；历史恢复使用 recover。恢复要求原 Run 为 completed/failed/cancelled/interrupted、有检查点，且没有 open 会话占槽；无检查点返回 409 checkpoint_unavailable。

## 5. 执行状态与控制语义

| 状态 | 含义 / 允许操作 |
|---|---|
| starting | 初始化浏览器；可 messages、pause、cancel |
| running | 模型或工具执行；可 messages、pause、cancel |
| pausing | 等待动作结束及暂停检查点；仅 cancel |
| paused | 已暂停；可 resume、cancel |
| waiting_input | 等待 interaction 的 answer；可 response、cancel |
| waiting_approval | 等待 interaction 的 decision；可 response、cancel |
| cancelling | 等待取消及清理结束；重复 cancel 返回同一状态 |
| completed | 本轮回答结束，终态，保留浏览器以支持新 Run |
| failed | 执行失败，终态；浏览器可用时允许同会话新 Run |
| cancelled | 取消及浏览器清理完成，终态；会话 closed |
| interrupted | 进程退出或崩溃导致执行中断，终态；会话 closed |

通常迁移：starting → running → completed；starting/running → pausing → paused → running；running → waiting_input/waiting_approval → running；非终态 → cancelling → cancelled。执行错误可从任何非终态进入 failed；清理失败必须记录 error，不得声称浏览器已成功关闭。

终态永远不恢复为 running；续聊或检查点恢复均生成新 Run。进程重启后将未完成 Run 标记 interrupted、旧交互标记 expired，不自动重放浏览器动作；旧 open 会话关闭。恢复创建新浏览器，先观察再核验未知动作，保留 recovered_from_run_id；使用当前服务端模型配置并在新 Session 明示。

控制操作与状态切换在一个串行执行通道中处理。pause 对 paused 返回 200，对 pausing 返回 202；resume 对其他状态返回 409；cancel 对 completed/failed/interrupted 返回 409（关闭浏览器请调用 session close）。请求与完成同时发生时，以锁内校验的状态为准。

## 6. 人工交互

Interaction 包含 `id`、`run_id`、`kind`（input/approval）、`status`（pending/resolved/expired）、`created_at`、`resolved_at`（可空）、`prompt`、`action`（脱敏工具及目标，可空）、`allowed_decisions`、`response`（可空）。首版不设自动批准或超时批准；cancel 或中断使未决交互 expired。

- input 回复：`{"answer":"已完成登录，请继续"}`，非空字符串。
- approval 回复：`{"decision":"approve"}`；可选值 approve/reject/approve_site/deny_site，但必须属于该 Interaction.allowed_decisions。普通动作只允许 approve/reject，网站级确认才允许网站授权。
- 两类请求互斥，拒绝多余字段。拒绝动作后代理收到拒绝结果，可继续寻找其他方案，不必把整个 Run 标为 failed。
- 回复与状态迁移原子提交；同一 Idempotency-Key 重试返回原结果。已解决或已失效交互使用新 key 回复返回 409 interaction_not_pending。客户端不可以用 messages 或 resume 绕过交互 ID。

## 7. 事件与断线重连

事件结构：`{id, run_id, sequence, type, created_at, data}`。id 为 `run_id:sequence`，sequence 是该 Run 从 1 开始的单调递增持久化序号。类型包括 run.created、run.status_changed、message.created、tool.started、tool.completed、interaction.created、interaction.resolved、interaction.expired、run.finished。tool 事件使用稳定 tool_call_id 关联；不把不断修改的桌面卡片对象当成可回放事件。

```text
id: <run_id>:12
event: run.status_changed
data: {"id":"<run_id>:12","run_id":"<run_id>","sequence":12,"type":"run.status_changed","created_at":"2026-11-11T08:00:00Z","data":{"status":"paused","revision":8}}

```

先持久化事件再广播；事件状态、Run 修订号及交互更新同事务提交。连接先回放，再无缝订阅新事件，必须消除查询与订阅之间的丢事件窗口。至少一次投递，客户端按 id 去重。Last-Event-ID 优先于 after，必须属于当前 Run；参数无效或超前返回 400，已经清理的历史位置返回 410 event_cursor_expired。

每 15 秒发送 SSE 注释心跳；慢消费者超过有界缓冲后断开，客户端按最后已处理 ID 重连。run.finished 是最后一条事件；回放至终态后关闭流，客户端应停止重连。HTTP 断开不取消 Run。首版事件随会话保留，删除会话后返回 404。

事件与截图分开；截图不进入 SSE、数据库或默认导出，返回 Cache-Control: no-store。带 Authorization 的事件流建议用 fetch 流读取，不能依赖无法自定义请求头的原生 EventSource。

## 8. 幂等、分页及错误

Idempotency-Key 为 1–128 个可打印 ASCII 字符，作用域为调用凭据身份 + HTTP 方法 + 规范化路径。对校验通过且被接受的 POST，将 key、规范化请求 JSON 摘要、资源变更和原始响应事务持久化；同 key 同参数返回原状态码、响应体及 Location，不再次执行。不同参数返回 409 idempotency_conflict。并发同 key 请求串行合并；不得先产生浏览器副作用再记录请求。

记录至少保存 24 小时；超过窗口重试可能创建新 Run，客户端应保存返回的资源 ID。删除会话时将关联 key 保留为墓碑至窗口结束，重试返回 410 resource_deleted，不重建会话。幂等只保证请求接收不重复，不保证外部网站副作用恰好执行一次。

资源列表 limit 默认 50、范围 1–200；使用不可变的 (created_at,id) 倒序和不透明 cursor，cursor 绑定过滤条件。事件 limit 默认 100、最大 400，next_after 为本页最后一个 sequence（空页沿用 after，默认 0）；它不是资源列表 cursor。

错误使用 RFC 9457 的 application/problem+json：

```json
{
  "type": "urn:openbrowseruse:problem:run-active",
  "title": "已有执行占用当前会话",
  "status": 409,
  "detail": "请等待当前执行结束，或先取消。",
  "instance": "/v1/sessions/00000000-0000-4000-8000-000000000001/runs",
  "code": "run_active",
  "request_id": "00000000-0000-4000-8000-000000000002"
}
```

响应均带服务端生成的 X-Request-ID。400 为 JSON/参数格式错误，401 为凭据缺失或错误（附 WWW-Authenticate: Bearer），403 为调用策略禁止，404 为资源不存在，409 为状态/槽位/幂等冲突，410 为已清理游标或资源，413 为请求体超限，415 为媒体类型错误，422 为字段语义无效，429 为速率限制（附 Retry-After），500 为服务端故障，503 为服务未就绪。

字段校验附 `errors:[{pointer:"/goal",code:"required",message:"…"}]`，不回显敏感输入。Run.error 使用 `{code,message,retryable}`，与 HTTP 请求错误分离；不能仅因 retryable=true 自动重跑有副作用的任务。

建议 HTTP JSON 请求体上限 8 MiB，且通过 /status 公布；goal/text 不另设字符截断，空白内容无效。拒绝未知输入字段；客户端应忽略新增响应字段、容忍未知事件类型。破坏性变更进入 /v2；OpenAPI 明确 required、nullable、枚举、媒体类型、响应头与错误响应。

## 9. 调用流程示例（待实现后可用）

```bash
# API_TOKEN 来自本机服务配置
curl http://127.0.0.1:4319/v1/sessions \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-session-1' \
  -d '{"browser_mode":"ephemeral","permission_mode":"skip"}'

# 将返回的 Session.id 设置为 SESSION_ID
curl "http://127.0.0.1:4319/v1/sessions/$SESSION_ID/runs" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-run-1' \
  -d '{"goal":"读取页面并概括内容","start_url":"https://example.com"}'

# 将返回的 Run.id 设置为 RUN_ID
curl -N "http://127.0.0.1:4319/v1/runs/$RUN_ID/events/stream" \
  -H "Authorization: Bearer $API_TOKEN"
curl "http://127.0.0.1:4319/v1/runs/$RUN_ID" \
  -H "Authorization: Bearer $API_TOKEN"
```

需要人工输入时按 interaction ID 回复；本轮完成后可在同一 Session 新建 Run 续聊。使用结束后 POST session close；取消只保证停止后续执行，已发生的网页提交不可撤销。

## 10. 与现有代码的落地关系

| 现状 | 必要改造 |
|---|---|
| lib/application.js 内部伪路由，操作全局 agent.task | 抽出带 session_id/run_id 校验的应用服务；HTTP 与 IPC 共用，不能把旧路由原样暴露 |
| Agent.start 会关闭旧浏览器；followUp 会覆盖 result/status | 引入 Session/Run 分层与执行槽位，终态 Run 不可变；新会话不得抢占已有浏览器 |
| message 同时承担追加、回答、续聊 | 拆分 steer、respondInteraction、createRun，禁止隐式切换含义 |
| control 使用无 ID 的 resolveGate | 为 gate 分配 interaction_id 并原子校验；桌面端也传同一交互 ID |
| sessions.db 一个 task 对应一条 sessions 记录 | 新增 api_sessions、runs、run_events、interactions、idempotency_requests；检查点明确归属 Run |
| change 推送完整可变状态，frame 单独广播 | 保留桌面订阅；新增持久化事件日志，HTTP SSE 从日志回放 |
| runtime 普通 HTTP 全部 404 | 独立 API listener、鉴权、请求校验和错误映射；原中继端口仍不开放管理 HTTP |
| MCP 自己创建 BrowserSession | 保持独立协议；同一持久化 profile 需跨进程独占锁，冲突可诊断 |

历史迁移采用备份及版本化事务：旧 task 导入一个 closed Session 和一个终态 Run，保留来源 ID；旧活动状态转 interrupted，结果及对话保留。旧记录没有轮次边界时，不伪造逐轮结果。迁移后由统一 repository 供桌面与 API 读取，避免两套会话索引分叉。

所有入口必须经过同一个槽位锁及 profile 锁；桌面已有会话时 API 也返回 session_active。创建 Session 仅预留槽位和持久化配置，首次 Run 才创建浏览器；extension 未配对时拒绝创建该模式会话，执行前再次检查连接。资源接收事务后由调度器启动执行；重启将未完成记录标 interrupted，避免响应丢失后重复执行。

## 11. 实施顺序与验收

1. 根据本设计编写完整 OpenAPI 3.1.1 文件，验证 schema、示例、operationId 及所有响应。此文档不是可直接生成 SDK 的 OpenAPI 文件。
2. 实现 Session/Run 存储、迁移、单槽位锁和按 ID 的交互服务，接入桌面 IPC；保持既有浏览器功能。
3. 实现鉴权 HTTP、幂等、创建/读取/续聊/控制/交互端点；使用模拟模型和真实浏览器验证全流程。
4. 实现事件日志与 SSE、截图、导出、删除和检查点恢复；提供客户端示例，发布 v1 契约。

验收至少覆盖：创建及异步完成；并发提交只接受一个执行；同 key 并发/断线/重启重试不重复创建；不同参数 key 冲突；终态不覆盖；旧 interaction 回复不影响新 gate；pause/cancel 与完成竞态；SSE 回放与实时切换不漏事件、去重、慢消费者重连；进程中断不自动重放动作；删除后 key 墓碑；恢复先核验页面；鉴权及密钥不回传；IPC/HTTP 共享锁；extension 和 persistent 模式资源冲突。截图及自由文本无法保证自动脱敏，API 文档应如实说明。

## 参考标准

- [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)：机器可读 API 契约。
- [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)：HTTP 问题详情格式。

状态机、端点命名、幂等键保存窗口和单执行限制是本项目的设计选择，不是上述标准强制要求。
