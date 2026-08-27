# 移植完整度对比报告：M365-Copilot2API-on-Cloudflare-Worker vs 上游 M365-Copilot2API

> 对照基准：上游 `internal/` 全部 Go 源文件、`server.go Routes()` 全部路由、README 功能表。
> 最近全面核对：2026-08-26（含严格映射路由、tone 同步鉴权回退、KV 持久化等行为变更）。
> **存储架构（2026-08-26 起，可选启用）**：绑定 D1（binding `DB`）后 usage 事件与调试记录改存 SQLite（`migrations/0001_init.sql`，原子 INSERT 不再丢记录、SQL 分页/过滤），并提供 `POST /api/admin/migrate/usage-kv-to-d1` 一次性回填历史 KV 日桶；migration 0002 另建 `chat_messages` 表存对话查看器转录（/v1/* 成功轮次 user+assistant 各一行）；绑定 DO（`MCP_HUB`→McpSessionDO，SQLite 类）后 MCP 会话跨 isolate 可用；绑定 DO（`COORD`→CoordinationDO，SQLite 类，migrations v2）后管理员登录失败锁定、账号轮询游标、每账号并发信号量与 token 刷新单飞互斥全部跨 isolate 强一致。未绑定的组件自动回退原 KV/isolate 行为。
> 本文档逐项列出实现状态；未实现项均标注原因分类：
> **[平台]** Workers 运行时能力限制（已确认裁剪）｜ **[简化]** 行为等价但实现方式适配 Workers/KV ｜ **[未做]** 尚未移植（技术上可行）｜ **[上游死代码]** 上游存在但未被任何路由调用

---

## 一、对外 API 端点对照（56 条路由）

### /v1/* 兼容端点

| 上游端点 | 状态 | 说明 |
|---|---|---|
| `POST /v1/chat/completions` | ✅ 完整 | 流式+非流式、reasoning_content、function calling（router 规划/fenced/native 检测/schema 校验信任边界/流式参数分片）、多模态图片上传、会话复用增量发送、failover、内容策略拦截、工具拒答/沙盒幻觉纠偏。2026-08-27 补齐：上下文预算滑窗（slidingWindow + X-M365-Context-Truncated 头）、validateToolConversation（400 tool_protocol_error）、failover 守卫（仅限流/鉴权 + 流式已流守卫 + resolver 会话清除）、流式原生工具事件管道 + 无效工具 repair、图片多模态回传（image_url 块）、imageLimit/contentPolicy 账号标记。**模型路由差异**：上游未映射时内置表回退+effort 自动升级（未知模型默认升 Gpt_5_5_Reasoning）；Worker 版严格按映射表执行，未映射直接 400 [应用户要求] |
| `GET /v1/models` | ✅ 完整 | Codex 风格目录全字段，`data`+`models` 双别名 |
| `POST /v1/responses` | ⚠️ 功能等价 | instructions/input 全项转换、previous_response_id 历史（KV 1h TTL）、function_call 投影、SSE 事件序列。**差异**：usage 为启发式估算非 tiktoken o200k [简化]。2026-08-27 补齐：`custom_tool_call` 转换 + custom exec 桥接（workspace 指令注入 + 非 exec 工具剔除）、`function_call_progress` 按上游 parseToolProgress 校验（缺 call_id/message 报错）、**流式改为增量转换**（C12：移植 streamResponsesAdapter，内层 OpenAI SSE 边读边转 response.created/output_text.delta/function_call_arguments.delta/custom_tool_call_input.delta 事件，替代"完成后重放"） |
| `POST /v1/messages` (Anthropic) | ✅ 增强 | system/块转换、thinking/tool_use block。**流式为真增量**（ChatHub onDelta/onReasoning 直接映射 thinking_delta/text_delta，含工具围栏扣留与 tool_use 块切换），优于上游的"完成后重放"实现。2026-08-27（C9/C10）：tool_use block 转结构化 assistant tool_calls（不再渲染为文本）；stop_sequences 透传 o.stop |
| `POST /v1/images/generations` | ✅ 完整 | 提示词模板、事件图片提取、rawResult/text 兜底提取、配额拒绝 429+Retry-After 86400、Designer 域名换 token 下载转存。**差异**：转存用 KV TTL 15min（上限 15MB，超出时仅 b64_json 可用），上游为内存 map 20MB [简化] |
| `POST /v1/images/edits` | ✅ 完整 | multipart 表单（Workers 原生 formData 解析），operation=edit 复用生成管线 |
| `GET /v1/images/files/<id>` | ✅ 完整 | KV 存储 + metadata contentType，UUID 校验 |
| `GET /v1/sessions` | ✅ 完整 | 解析器会话 + 显式绑定合并列表 |
| `POST /v1/sessions` | ✅ 完整 | session_id 查询/创建语义一致 |
| `DELETE /v1/sessions/{id}` | ✅ 完整 | |
| `/v1/mcp/sse` · `/v1/mcp/message` · `/v1/mcp/tools` | ✅ 完整 | MCP SSE server 移植（endpoint 握手帧、JSON-RPC 分发（initialize/tools/list/tools/call）、全局工具注册表（由 /v1/chat 请求工具自动合并 + settings.mcpServers 外部服务器桥接 #19）、tools/list 回退语义与 -32000/-32700/-32601 错误码逐字对齐。**桥接工具**经出站 SSE 客户端执行（30s 队列语义，超时回占位文案 #20）；未桥接的 tools/call 仍返回 no tools available。**差异** [平台]：无 MCP_HUB 绑定时会话表存 isolate 内存；stdio 出站传输不适用（Workers 无子进程），外部服务器走 SSE 传输 |
| `/v1/memory/flags` · `/instructions(+/id)` · `/settings` | ✅ 完整 | substrate 透传代理（Bearer 账号 token + x-anchormailbox 等 5 头逐字对齐），变更操作要求管理员会话 cookie（403 语义一致）；FeatureFlags.memoryV2 开关（settings/env M365_ENABLE_MEMORY_V2）现可关闭 update_memory_plugin/add_custom_instructions 注入，默认开启；控制台另设 /api/admin/memory/* 管理员会话变体（见批次 F 卡片） |
| `GET /api/plugins` | ✅ 完整 | 上游插件清单端点（substrate EventListener 透传 + 每账号 5min KV 缓存）；鉴权为 API key 或管理员会话双通道（上游仅 API-key 中间件）；native 工具事件抽取独立移植（见机制表 native_tools.go 行）。2026-08-27 复核确认已实现，原 [未做] 标记作废 |

### /api/* 管理端点

| 上游端点 | 状态 | 说明 |
|---|---|---|
| `POST /api/admin/login` | ✅ 完整 | 密码 SHA-256 哈希存 KV。仅要求非默认密码+长度 6-256（强度/历史策略曾移植后按用户要求回退）。**差异**：哈希算法为 SHA-256（上游 bcrypt）；失败锁定 5 次/15min 经 CoordinationDO 全局共享（绑定 COORD 时，未绑定为无锁定） |
| `/api/admin/logout` · `/api/admin/session` | ✅ 完整 | |
| `POST /api/admin/change-password` | ✅ 完整 | 含强制改密门禁、全会话失效 |
| `/api/admin/keys` GET/POST/PUT/DELETE | ✅ 完整 | 仅哈希存储、回读语义一致 |
| `GET /api/admin/models` | ✅ 完整 | |
| `POST /api/admin/models/test` | ✅ 完整 | 真实 ChatHub 连通测试，走管理员会话鉴权 |
| `POST /api/admin/models/sync` | ✅ 完整 | 两级探测：匿名 CDN bundle 正则 → 失败时用账号池 accessToken 以 Bearer 重试应用页面及其 bundle（已实测可拉取）。非空结果持久化到 KV `discoveredTones`，保留至下次成功同步覆盖。**与上游差异**：上游结果仅存内存（24h TTL+后台自动重同步，重启即失），校验走动态白名单（liveUpstreamTones 动态优先、回退内置 13 个含 Magic/Gpt_5_2_Auto）；Worker 版无白名单、纯格式校验、KV 持久化、手动覆盖 |
| `GET/PUT /api/admin/settings` | ⚠️ 部分 | 校验规则基本移植。**行为差异**：上游允许空 modelMappings，Worker 版要求至少一条；tone 校验上游为动态白名单、Worker 为纯格式。**OAuth 字段已可热生效**：clientId/authority/redirectUri/scope 保存后经 effectiveOAuthConfig 在授权/刷新流程优先于 env（images 刷新路径仍用 env）[简化]；listenAddress/configPath/tokenCachePath/debugLogPath 等字段在 Workers 上天然无效 [平台]；licenseType/scenario/accountConcurrencyLimit/mcpServers/featureFlags（env M365_ENABLE_* 播种，memoryV2 实际生效）均已入 settings 可持久化 |
| `/api/admin/proxy-pool` | ❌ 已移除 | **[平台→已删除]** Workers fetch 不支持 HTTP/SOCKS 出站代理；应用户要求已彻底移除端点（控制台对应操作将收到 404） |
| `/api/accounts/bind-proxy` | ❌ 已移除 | 同上 |
| `/api/admin/deployments` · `/deployment` · `/deployment/check` | ⚠️ 空实现 | GET 返回 `{"items":[]}`（形状与上游一致）；创建/改 URL/探活返回 501——在 Workers 上自部署管理自身无意义 [应用户要求补齐形状] |
| `/api/admin/debug/logs` · `/debug/detail` | ✅ 完整 | KV 版环形存储：仅 logLevel=debug 时捕获 /v1/* 请求/响应（≤256KiB 截断、24h TTL、最新 500 条），脱敏键表 25 条逐字对齐，响应 JSON 形状一致。**#21 已补齐**：SSE 流式响应经 tee 后台聚合（≤256KiB）后补录 responseBody，与上游流式调试行为一致；M365_TRACE 属 chathub 内部日志，仍走 console |
| `GET /api/health` | ⚠️ 等价 | accountConcurrency 恒为 `{}`（限制器经 CoordinationDO 已生效，但健康端点不回读 DO 实时占用，避免每请求额外往返） |
| `GET /api/version` | ⚠️ 等价 | version 为 `0.5.0-cfworker.x` 标识；go 字段填 `cloudflare-workers`；uptimeSeconds 恒 0（isolate 无常驻概念）；proxyPool 计数字段已随代理池移除 [平台] |
| `GET /api/update` | ✅ 等价 | 上游本身即为只读 stub（updateAvailable 恒 false） |
| `GET /api/accounts` | ✅ 完整 | 冷却/健康快照来自 KV；callCount 恒 0（计数器随并发限制器一并省略）|
| `POST /api/accounts/refresh` | ✅ 完整 | EnsureValid 单飞防抖（isolate 内） |
| `POST /api/accounts/schedule` | ✅ 完整 | |
| `/api/accounts/token-health` GET/POST | ✅ 完整 | expires_in 格式为纯秒数（上游为 Go duration 字符串），仅显示差异 [简化] |
| `POST /api/accounts/clear-cooldown` | ✅ 完整 | |
| `POST /api/accounts/delete` | ✅ 完整 | |
| `POST /api/accounts/provision` | ✅ 完整 | ROPC 密码流移植 |
| `GET /api/auth/start` · `/status` · `/callback` | ✅ 完整 | PKCE S256、state KV TTL 600s、粘贴回调 URL 兼容、loopback 自动关窗页 |
| `POST /api/chat` | ✅ 完整 | |
| `POST /api/chat/stream` | ✅ 完整 | 归一化事件+语义事件+done 帧，与上游同为完成后发送 |
| `GET /api/conversations` | ⚠️ 简化 | 返回显式绑定（sessions.json 等价物）。上游同源；形状含 id/conversationId/title 等，兼容控制台 |
| `POST /api/conversations/delete` | ✅ 完整 | 本地索引+绑定联动删除 |
| `POST /api/conversations/cleanup` | ✅ 模式化 | conversation_manager 三模式已映射到 Cron 清理：`M365_CLEANUP_MODE=after_response\|keep_n\|max_age`（+KEEP_N/MAX_AGE_HOURS 旋钮）；白名单与 userSessions 活跃集并入保护集，删除联动解绑（dropConversation）一致 |
| `/api/conversations/whitelist` | ✅ 完整 | KV 持久化白名单（GET 列表 / POST add·remove 单或批量），并入 Cron 清理保护集，永不回收 |
| `GET /api/m365/conversations` | ⚠️ 简化 | 云端列表已移植（RefreshNavPane action API）。**缺口**：上游会把解析器会话合并进列表（gateway 来源标记、chatName 从历史推导、messageCount 统计），本移植仅返回云端原始行 [未做] |
| `GET /api/m365/conversations/detail` | ⚠️ 等价 | 按 seq 组装 ContextHistory 形状（role/content 消息数组+chatName/messageCount/accountEmail 等）供控制台对话查看器渲染；数据来自 /v1/* 成功轮次在 D1 `chat_messages` 表的转录（migration 0002，单条 64KiB 截断，TTL=cron DELETE 7 天，对话删除联动清除）。**差异**：仅记录本版本部署后的 /v1/* 轮次（无历史回填），控制台 /api/chat 预览对话不入库；D1 未绑定时返回空时间线并带 detail_unavailable 标记 [简化] |
| `POST /api/m365/conversations/delete` | ✅ 完整 | 云端 DeleteConversation + 本地联动 |
| `POST /api/m365/conversations/cleanup` | ❌ 占位 | 循环拉取清空全部对话的逻辑未移植；Cron 自动清理是受预算约束的等价物 [简化] |
| `GET /api/stats` · `POST /api/stats/reset` | ✅ 完整 | 缓存命中统计真实数据（KV） |
| `GET /api/usage` · `/api/usage/logs` | ⚠️ 等价 | 聚合口径一致。**存储差异** [简化]：KV 日桶（90 天过期、单桶 5000 条上限）替代 usage.jsonl 的 5 万条滚动窗口；Free 计划面板最多回读约 30 桶 |
| `/` · `/login` · `/conversation` | ✅ 完整 | Static Assets 托管原版 HTML |
| （未注册路径 fallback） | ✅ | 404 OpenAI 错误格式 |

---

## 二、核心机制对照

| 上游机制 | 状态 | 说明 |
|---|---|---|
| ChatHub SignalR 协议（握手/\x1e 分帧/ping/type1-3 帧/writeAtCursor 快照去重/限流文案检测/5min 总超时/90s 读超时） | ✅ 逐字移植 | `src/chathub/*` |
| WS URL 构造（variants/source 引号等协议细节） | ✅ 逐字移植 | |
| UploadFile 图片上传（form-urlencoded + feature gate 头 + jpeg→jpg 规范化） | ✅ 完整 | |
| 多模态注解注入（ImageFile annotation + connectedFederatedConnections + imageBase64/imageUrl 双路径） | ✅ 完整 | |
| 远程图片下载转 data URL | ✅ 完整 | 2026-08-27（C2）：非 data: URL 先下载（手动重定向跟随 ≤5 跳、每跳重新校验、10MiB 上限）转 data URL 再走 UploadFile；上传前校验 base64 可解码 + ;base64 标记 |
| 附件下载 SSRF 防护（ssrf.go：仅 https 公网地址、DNS 解析复查私网/环回/云元数据段） | ✅ 移植（平台近似） | 2026-08-27（C2）：scheme 必须 https；IP 字面量拒绝私网/环回/链路本地/CGNAT/云元数据/多播段；主机名拦截 169.254.169.254.nip.io/.internal/.local。Workers 无运行时 DNS API，域名复查依赖 CF 边缘出口（平台限制，面已显著缩小） |
| OAuth PKCE（S256、nativeclient 手动粘贴流、AADSTS 错误归类） | ✅ 完整 | |
| Device Code 流（auth/device.go StartDeviceCode/PollDeviceCode） | — | **[上游死代码]** 上游未挂接任何路由；仅 FOCI clientId 影响 refresh endpoint 选择，该逻辑已移植 |
| ROPC 密码登录 | ✅ 完整 | |
| Token 刷新单飞防抖（AAD 刷新令牌一次性） | ✅ 完整 | isolate 内 promise 合并 + CoordinationDO 命名互斥（"refresh:<id>"，30s TTL）跨 isolate 单飞；未抢到的一方轮询 KV 等待远端结果（≤15s），避免烧掉第二枚一次性 refresh token。COORD 未绑定时退回 isolate 内防抖 |
| 账号轮询 round-robin | ✅ 完整 | COORD 绑定时游标存 DO（跨 isolate 原子，KV accounts 文档不再每次写 nextIdx）；未绑定时 nextIdx 持久化 KV |
| 账号健康（限流冷却/auth 失败冷却/MarkSuccess 清除/最早恢复时间） | ✅ 完整 | KV 持久化 |
| 账号并发限制（account_concurrency.go，默认每账号 8） | ✅ 完整 | CoordinationDO 信号量（#11 执行器）：resolveAndValidateAccount 处 acquire（上限=settings.accountConcurrencyLimit，满时 DO 内有界等待后 429+Retry-After 背压）、上游工作结束 finally release；15min 租约 TTL + alarm 兜底回收崩溃 isolate 泄漏的槽位；COORD 未绑定时无门控（靠上游 429 自然背压） |
| 故障转移（429/401/403 且未钉定账号/会话时换号重试） | ✅ 完整 | |
| 内容键会话复用（显式 ID > 严格前缀 > 同后缀 ≥2；IP+UA 指纹隔离；512 条历史上限；LRU 1000） | ✅ 逐字移植 | README 所述"Jaccard 相似度兜底"在上游代码中并不存在（文档滞后），实际为前后缀匹配，已如实移植 |
| 会话/上下文 TTL 环境变量（SESSION_TTL/CONTEXT_TTL_MINUTES） | ❌ 固定 2h | **[未做]** 环境旋钮未读取（M365_CONTEXT_SIMILARITY 上游代码中亦不存在） |
| 用户级会话（body.user → userSessionStore 固定账号+对话） | ✅ 完整 | tenant=SHA-256(API key) 隔离、7 天 TTL 惰性清理、响应后回写；活跃集并入清理保护集 |
| X-Request-ID 响应头关联 | ✅ 完整 | 所有 API 响应（含鉴权失败与 404）携带内部 requestId |
| 对话缓存 convCache（account+model 维度 system-prompt-hash 增量复用） | ✅ 完整 | KV 键 `convcache:<accId|auto>|<model>`（2026-08-27 对齐上游 account+model 粒度，C7）；存 {accountId,conversationId,sessionId,messageCount,sysHash,lastUsedAt}，TTL 2h；prepareCore 无显式 conv 且 sysHash 一致且新条数>缓存时复用并增量 flatten(messages[count:])，命中即钉定缓存账号；recordFinalize 应答轮回写；无系统提示词的对话不参与（隔离保护） |
| 自动清理（闲置 2h / keepN=5 / 活跃保护集 / 删除联动解绑 / 100 轮滑动窗口） | ✅ 完整 | Cron 每 30 分钟执行；新增单次 30 个删除预算（Free 子请求限制保护）[简化] |
| 白名单（conversationManager.WhitelistedIDs 进保护集） | ✅ 完整 | KV 持久化 + 清理保护集 + 控制台白名单管理卡片 |
| WS 连接池（connpool.go Take/Return 复用） | ❌ 裁剪 | **[平台]** isolate 无法跨请求持有连接；每请求新建（上游 Dialer 直连路径同样支持） |
| 连接预热（preheater.go） | — | **[上游死代码]** 上游 Preheater 本身就是 stub（Take 返回 nil、Stats 返回 mode:stub），无功能损失 |
| Function calling router 模式 | ✅ 完整 | CALL_TOOL/JSON 信封/修复轮/并行自适应限制（exec 类串行）。**2026-08-27 补齐流式预调用**：上游 server.go 流式路径（1810-1881）在 `stream:true + tools` 时先跑 `modelToolRouterPrompt`（工具定义内嵌 prompt），命中即输出 tool_calls、NO_TOOL_NEEDED 才 fall-through 到文本流式；Worker 版原仅非流式有预调用，现流式已对齐（含 failover）。同步对齐流式 holdback 尾缓冲 8→3 rune（上游 `server.go:1962`） |
| Function calling fenced 检测（```bash 自动转换+裸 JSON command 扫描+声明校验） | ✅ 完整 | |
| 流式围栏扣留（疑似工具调用文本不外流，确认后整体转分片 tool_calls） | ✅ 完整 | rune 边界保持 |
| 原生事件工具检测（native_tools.go walk + events.go extractToolEvents） | ✅ 完整 | extractToolEvents 递归遍历 update 帧参数所有层级（name/toolName/pluginName/functionName × arguments/args/parameters/input/functionArguments 双字段判定，按 name+JSON(args) 去重）→ nativeToolCalls 仅收声明过的工具名（call_ uuid id）；流式路径同样接入（fenced→native→校验/限额，tool 事件只收集不出文本），且流式请求现同样下发 toolPlugins/MCPServerURL |
| JSON Schema 校验信任边界 | ✅ 完整 | object/array/string/number/integer/boolean/null/enum/required/additionalProperties |
| `<m365-tool-call>` 协议块提取 | ✅ 完整 | |
| 工具响应写出（流式 512B 参数分片 + finish_reason=tool_calls + usage chunk） | ✅ 完整 | |
| Native 规划模式注入（planningMode=native 时把 tools 作为 ChatHub payload `plugins` 下发 + MCPServerURL 插件桥接） | ✅ 完整 | 请求带 tools 时自动合并进 MCP 全局注册表，chatPayload 下发 API plugins + mcp-gateway(MCPServerURL=/v1/mcp/sse) 条目，无工具时回落 BingWebSearch 内置；云端原生 tool 事件 → OpenAI tool_calls 的转换链路已接通（fenced→native→schema 校验/限额，流式与非流式一致） |
| Agent ledger（证据链 RouterContext/CanContinue 轮次熔断/completionEvidenceAllows 收尾校验） | ✅ 完整 | `src/pipeline/ledger.ts` 纯函数移植：每请求从 messages 重建（assistant.tool_calls 建 id→{name,args}、role=tool 按 tool_call_id 回填 Result 并 compact 头 limit/3+尾 limit-head-80）；失败正则逐字对齐；签名计数 name\0args 规范化（trimmed+合法 JSON 键序重排重序列化）≥2 RepeatedCall/≥3 StuckLoop，失败签名（小写+数字→#+截500）≥2 RepeatedFailure/≥3 StuckLoop；CanContinue 依次报轮数达限/StuckLoop/RepeatedFailure/pending 未回填并熔断 router 规划轮；RouterContext（"A completed call is final evidence…"+EVIDENCE_LEDGER JSON+FINAL ANSWER RULE）注入 router 提示词；completionEvidenceAllows 收尾校验（pending→false/无证据却称完成→false/有证据却称无法确认→false），违例且请求带工具时正文替换为固定免责句 |
| validateToolConversation（tool 消息格式前置校验） | ✅ 完整 | 2026-08-27 移植：tool 消息缺 tool_call_id 或引用未知 id → 400 tool_protocol_error（`src/api/openai.ts` validateToolConversation） |
| 工具进度卡（tool_progress.go parseToolProgress + Progress 事件转发） | ⚠️ 部分 | 2026-08-27：Responses 转换已按上游 parseToolProgress 校验（无效报错、有效跳过）；聊天流内 Progress 事件不透传（上游在 chatStream 语义事件里透传——该部分已移植） |
| Codex 模型目录（capabilities 双位置/effort 预设/truncation policy 等 60+ 字段） | ✅ 完整 | |
| 动态 tone 探测（CDN main.*.js 正则抓取） | ✅ 增强 | 匿名 + 鉴权两级探测；结果持久化并接入控制台模型映射下拉框（默认/拉取分组）。**差异**：上游为内存缓存+动态白名单校验；Worker 为 KV 持久化+纯格式校验。**路由差异**：上游内置表回退+effort 自动升级，Worker 严格映射表驱动（未映射 400、删除行即失效）[应用户要求] |
| 用量估算 EstimateTokens（rune×2/3） | ✅ 完整 | |
| Codex usage tiktoken o200k | ⚠️ 启发式 | Worker 不内置词表；heuristic_character_estimate 口径，m365.usage_source 如实标注 [简化] |
| public_identity 公开身份策略（M365_PUBLIC_IDENTITY_POLICY 总开关、身份预设、正文/推理/流式清洗器） | ❌ 未移植 | **[未做]** 上游默认关闭的可选特性（20KB），面向公开反代场景清洗微软痕迹；个人自部署收益低 |
| sanitizePublicAssistantTextForModel 等清洗 | ❌ 未移植 | 随 public_identity 一并归属；基础错误脱敏（不泄 token/URL）已由 describeUpstream 覆盖 |
| 兼容元数据 m365.events（M365_INCLUDE_UPSTREAM_EVENTS=1 时附带原始事件） | ✅ 完整 | 2026-08-27：`m365Metadata` 升级为 compatM365Metadata 全字段版（throttling/suggestedResponses/offense/scores/conversationTransferToken/meteringInformation/spokenText/timestamps/storageMessageId/citations）+ events 开关（envTrue 判定） |
| normalizeJSONText / response_format json(_schema) 注入 | ✅ 完整 | |
| estimateResponsesUsage 协议帧常数 | ✅ 完整 | 常数一致，计数器为启发式 |
| previous_response_id 历史租户隔离 + 1h 过期 + 容量上限 | ✅ 完整 | 2026-08-27：KV 键升级为 `resp-history/{tenant}/{session}/{id}`（`tenant\0session` 双隔离语义），写入带 metadata.at，`maxResponsesPerTenant=256` 超限删最旧（list 前缀），load 时校验 session/tenant；仍为 KV 而非内存 [简化] |
| 管理员安全（强制改密/会话 Cookie HttpOnly+SameSite/SameSite=Lax/登出失效/X-Forwarded-Proto Secure 判定） | ✅ 完整 | |
| 安全响应头（nosniff/X-Frame-Options/Referrer-Policy） | ✅ 完整 | |
| 完整 CSP 头（style/script 白名单域名等） | ❌ 页面缺失 | **[未做]** Static Assets 直接服务页面绕过了 Worker 头注入；需 `_headers` 文件补 CSP |
| httpTrace 访问日志中间件 | ⚠️ 等价 | Workers 内置请求日志（wrangler tail / dashboard）覆盖同一需求；X-Request-ID 响应头已补齐 |
| recover 中间件 | ✅ 等价 | fetch 入口 try/catch 500 JSON |
| 数据文件原子写（atomicfile 0600） | — | **[平台]** KV 无文件语义；敏感数据仅存哈希或服务端密文边界内 |
| refresh token 落盘加密（auth/cache.go AES-GCM，M365_MASTER_KEY） | ❌ 差异 | **[未做]** Worker 版账号 token（含 access/refresh）以明文 JSON 存 KV（`src/store/accounts.ts`），依赖 KV 边界安全；上游落盘前 AES-GCM 加密 |
| 默认模型映射（defaultModelMappings：gpt-5.6-sol/-terra/-luna） | ⚠️ 不同 | 上游默认 3 条 sol/terra/luna → Gpt_5_6_Reasoning；Worker 版默认展开全部 11 个内置模型（含 gpt-image-2→Magic），控制台可直接编辑 [应用户要求] |
| 后台落盘循环 persistStore | — | **[平台]** KV 即时写替代 |
| graceful shutdown | — | **[平台]** 无常驻进程概念 |
| manage.py / Dockerfile / docker-compose | — | 由 wrangler dev/deploy 替代 |
| pkce_auth_gateway.py 本地回调网关 | — | Workers 部署无需；nativeclient 粘贴流 + loopback 自动关窗页均可用 |
| scripts/*.py 探针 | — | 开发期工具，不属于运行时 |
| 测试套件（go test ./...） | ⚠️ 等价替换 | vitest 159 例覆盖协议/解析器/工具/原生事件抽取/agent ledger/协调 DO/对话转录与详情查看器/convCache/出站 MCP 客户端与桥接/流式调试聚合/转换/错误体系关键路径；上游集成类测试（真实 WS 往返）不在单元范围 |

---

## 三、环境变量对照

| 变量 | 状态 |
|---|---|
| ADMIN_PASSWORD / M365_BROWSER_* / M365_CLIENT_ID / M365_AUTHORITY / M365_REDIRECT_URI / M365_SCOPE / M365_DEVICE_* | ✅ 生效（vars/secrets） |
| M365_CHAT_TIMEOUT_SECONDS / M365_AUTO_CLEANUP* | ✅ 生效 |
| M365_INCLUDE_UPSTREAM_EVENTS | ✅ 生效 | m365.events 开关（envTrue：1/true/yes/on）；随完整版 m365Metadata 于 2026-08-27 接线 |
| M365_ENABLE_MEMORY_V2 / DEEP_WORK / COMPUTER_USE / REALTIME_VOICE / SYSTEM_PROMPT_OVERRIDE / DESIGNER_IMAGE_GEN_4O / CODE_CANVAS / SYDNEY_RECONNECT | ⚠️ 播种至 settings | 启动时读入 settings.featureFlags（memoryV2 默认开、其余默认关）；memoryV2 实际生效（门控 memory optionsSets），其余 flag 存储待逐个核对上游 payload 效果后接线 |
| M365_LISTEN / M365_DATA_DIR / M365_CONFIG / M365_TOKEN_CACHE / M365_SESSION_CACHE / M365_API_KEYS / M365_USAGE_LOG / M365_DEBUG_LOG / M365_PERSIST_INTERVAL | — **[平台]** 无文件系统/端口概念 |
| M365_PROXY_POOL / M365_PROXY_INSECURE_TLS / M365_PROXY_HEALTH_URL / outbound.EnvProxy | ❌ **[平台]** 代理池裁剪 |
| M365_SESSION_TTL_MINUTES / M365_CONTEXT_TTL_MINUTES | ❌ **[未做]** 固定 2h 默认值 |
| M365_CONTEXT_SIMILARITY | — **[上游死代码]** 代码中不存在 |
| M365_MAX_TOOL_CALLS_PER_TURN / M365_MAX_TOOL_ROUNDS | ✅ 经 settings 生效 | 两者均为控制台可编辑设置（maxToolCallsPerTurn/maxToolRounds）；后者驱动 agent ledger 的 CanContinue 轮次熔断（env 变量本身不直接读取，与其他 settings 字段一致走 KV） |
| M365_PUBLIC_IDENTITY_POLICY | ❌ 随 public_identity 未移植 |
| M365_TRACE | ❌ **[未做]** 详细 trace 日志未实现（console.error 关键路径已有） |
| M365_USER_SESSION_TTL_MINUTES / M365_ACCOUNT_DEFAULT_CONCURRENCY | ⚠️ 后者经 settings 生效 | 并发上限为控制台可编辑设置 accountConcurrencyLimit（默认 8，由 CoordinationDO 信号量执行）；userSessions TTL 固定 7 天，TTL 旋钮未读取 |
| M365_AUTHORIZE_ENDPOINT / M365_TOKEN_ENDPOINT / M365_DEVICE_ENDPOINT / M365_DEVICE_TOKEN_ENDPOINT | ✅ 生效 | 2026-08-27 对齐上游 config.go：四个精确端点覆写变量优先于 authority 推导（oauthConfig/effectiveOAuthConfig）；ROPC 端点统一走 cfg.tokenEndpoint（原硬编码 organizations 路径） |

---

## 四、控制台功能影响评估

| 控制台页签/功能 | 影响 |
|---|---|
| 登录/改密/仪表盘/账号/API Keys/用量/缓存统计/模型测试/设置（运行时字段） | ✅ 可用 |
| 「模型管理」页（映射+可用性测试合一） | ✅ 增强 | 上游无映射编辑 UI（只能裸调 PUT settings），仅有独立"Model Test"单表；Worker 版为映射编辑+行内测试+状态/延迟/回复一体的合并表格 |
| 「对话」页列表+删除+白名单管理 | ✅ 可用（列表不含 gateway 合并行；白名单卡片支持添加/移除，实时防清理保护） |
| 「对话」页查看器详情（conversation.html?id=） | ✅ 可用 | detail 端点返回 D1 转录消息数组（/v1/* 成功轮次，7 天 TTL），时间线按序渲染 user/assistant 消息 |
| 「代理池」页 | ✅ 已彻底移除：导航入口、页面区块、账号表 Proxy 列/Bind 按钮、相关 JS 函数与 showPage 钩子均从 `assets/index.html` 删除（内联脚本通过 node --check 校验）；i18n 词典残留少量不可见死键，不影响任何功能 |
| 「部署」页 | ❌ 空数据（deployments 占位） |
| 「调试日志」入口 | ❌ 空数据（debug 占位） |
| 设置页 OAuth 字段修改 | ⚠️ 保存成功但不生效（见 settings 行说明） |
| 「对话」页白名单卡片 · 设置页 M365 Memory 卡片（flags/instructions JSON 编辑+按 ID 删除） | ✅ 新增（批次 F；经 /api/admin/memory/* 管理员会话变体驱动 substrate） |

---

## 五、优先级建议（如继续迭代）

1. **高**：`/api/m365/conversations` 合并解析器会话 + `detail` 返回 ContextHistory（控制台体验闭环）
2. **高**：附件 SSRF 校验（scheme/host 白名单级即可）与远程图先下载再上传对齐上游
3. ~~**中**：native 规划模式 payload 注入（tools → plugins）~~ ✅ 已完成（含云端原生 tool 事件→tool_calls 转换链路与 agent ledger，2026-08-26）
4. **中**：SESSION/CONTEXT TTL 旋钮读取；X-Request-ID 响应头；页面 CSP（assets `_headers`）
5. ~~**低**：agent ledger~~ ✅（批次 A）；~~convCache~~ ✅、~~whitelist 控制台卡片~~ ✅、~~MCP SSE 出站客户端~~ ✅（批次 D/E/F，2026-08-26）；余项（userSessions TTL 旋钮、conversation_manager 细粒度清理模式、public_identity）仍待后续
