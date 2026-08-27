# 对齐检测清单（除模型调用及传输之外）

> 生成日期：2026-08-27
> 用途：逐项检测 Worker 版与上游 Go 版在**鉴权、账号、存储、会话、控制台端点、图片、MCP、中间件、安全**等方面的对齐状态。
> 范围说明：**模型调用及传输**（ChatHub 协议层 payload 构造、tone 路由、工具调用链路、流式/非流式处理、SSE 格式、A3/A5/A9/A10 等）已在 `docs/api-flow-code-diff.md`（0.5 节 + 第三/四轮）确认对齐，不在本清单内。
> 状态图例：✅ 对齐（可勾选验证）｜⚠️ 部分/简化｜❌ 未做｜[平台] Workers 限制｜[用户选择] 有意保留（无需处理）｜[死代码] 上游未使用
> 检测方法：对每项查看"检测要点"中的代码位置与行为，确认与上游一致。

---

## A. 鉴权与安全

| # | 功能点 | 上游（Go） | Worker（TS） | 状态 | 检测要点 |
|---|--------|-----------|-------------|------|---------|
| A1 | API Key 提取（X-API-Key / Bearer） | server.go:603-617 | `src/api/auth.ts` | ✅ | 两种头均可、前缀 m365_ 校验 |
| A2 | API Key 存储（仅哈希） | keys.go | `src/store/keys.ts` | ✅ | KV 只存 SHA-256，不回读明文 |
| A3 | Admin 登录 / 会话 | admin_security.go | `src/store/admin.ts` | ⚠️ | 密码 SHA-256（上游 bcrypt，[用户选择]）；失败锁定 5 次/15min——COORD 绑定时经 CoordinationDO、未绑定 isolate 本地计数兜底（2026-08-27 已补） |
| A4 | 强制改密 / 登出失效 / SameSite | admin_security.go | `src/store/admin.ts` | ✅ | Cookie HttpOnly+SameSite=Lax，改密后全会话失效 |
| A5 | OAuth PKCE / nativeclient 粘贴流 | pkce.go | `src/auth/oauth.ts` | ✅ | S256、state KV 600s TTL、loopback 关窗页 |
| A6 | Token 刷新单飞防抖 | auth/token.go | `src/auth/oauth.ts` + `src/do/coordination.ts` | ✅ | COORD 命名互斥 `refresh:<id>` 30s TTL，未抢到方轮询 KV ≤15s |
| A7 | ROPC 密码登录 | server.go | `src/auth/oauth.ts` ropcToken / provision | ✅ | ROPC 恒走 organizations 租户端点（对齐上游 token.go；2026-08-27 改：authority origin + `/organizations/oauth2/v2.0/token`，规避上游默认 common/organizations 404 拼接缺陷） |
| A8 | 安全响应头 | server.go | `src/index.ts` withSecurityHeaders + `assets/_headers` | ✅ | nosniff / X-Frame-Options DENY / Referrer-Policy / Permissions-Policy / CSP（2026-08-27 已补全） |
| A9 | X-Request-ID 关联 | http_trace.go | `src/index.ts` withRequestId | ✅ | 所有响应含内部 requestId（页面路径亦含，2026-08-27 已补） |
| A10 | 附件 SSRF 防护 | chathub/ssrf.go | `src/chathub/client.ts` validateRemoteDownloadURL/downloadImage | ⚠️ [平台] | scheme 必须 https、IP 字面量拒绝私网/云元数据段、nip.io/.internal/.local 拦截、每跳重定向复查（≤5 跳/10MiB）；域名解析复查依赖 CF 边缘（无运行时 DNS API）；openai.ts 图片回传与上游 images.go 一致无校验 |
| A11 | 完整 CSP 头 | server.go | `assets/_headers` + `src/index.ts` withSecurityHeaders | ✅ | Static Assets 全页面 CSP（比上游严格，无外部 CDN）+ API/JSON 响应 CSP（2026-08-27 已补） |
| A12 | refresh token 落盘加密 | auth/cache.go AES-GCM | `src/store/accounts.ts` 明文 | [用户选择] | 明文 JSON 存 KV，依赖 KV 边界安全——已确认选择，非待办 |

## B. 账号生命周期

| # | 功能点 | 上游 | Worker | 状态 | 检测要点 |
|---|--------|------|--------|------|---------|
| B1 | 账号轮询 round-robin | account_health.go | `src/pipeline/account.ts` + COORD | ✅ | COORD 绑定时游标存 DO，未绑定 KV nextIdx；MAX_ACCOUNT_PROBE=16 一致；**已修：选号并发预筛并入 DO /next-healthy、全冷却 Retry-After 动态 EarliestRecovery（≥5s）、并发满 429 Retry-After 1（2026-08-27）** |
| B2 | lastHealthyAccount 偏好 | server.go:1041-1052 | account.ts | ✅ | C4 已修：优先上次健康账号；KV 12h TTL（上游内存无 TTL）；**已修：偏好命中补 concurrencyAvailable 检查（2026-08-27）** |
| B3 | 健康/冷却（限流、auth 失败、恢复时间） | account_health.go | `src/pipeline/account.ts` + COORD | ✅ | **已修（2026-08-27）：classifyError+cooldownMsForCategory 移植上游全分类（401=2min/403=24h/429 指数退避 30s·2^(n-1) 上限 30min/503=15s/传输类 15-30s/UPSTREAM_STRUCTURED=10s/UNKNOWN=min(rateLimitCooldown,30s)）、全局熔断进 DO（30s 窗口≥10 请求失败率≥50%→open 30s）、quotaAttempts 进 DO+KV、rateLimitCooldownSeconds 旋钮（I13）**；KV 兜底路径保留完整逻辑+isolate 本地熔断 |
| B4 | 限流确认探测 | server.go:100-131 | openai.ts markFailureAfterConfirm | ✅ | E2 已补（上游该函数为死代码，TS 按语义接线） |
| B5 | 图片额度/内容策略标记 | client.go + accountPool | account.ts markImageLimited | ⚠️ | 触发路径✓（ErrImageLimit/imageLimitNotice→markImageLimited；images 端点 429+Retry-After 86400）；冷却窗口差异：Worker 至 UTC 午夜 vs 上游 24h 滚动；上游 imageGen 三函数死代码 |
| B6 | 账号并发限制（默认 8） | account_concurrency.go | COORD 信号量 | ⚠️ [用户选择] | COORD 绑定时限流+429+Retry-After；未绑定静默不门控（有意保留）；**已修：并发满账号不进入候选（/next-healthy 预筛，2026-08-27）**；上游阻塞排队 vs Worker 15s 有界等待后 429 |
| B7 | 故障转移 failover | server.go | openai.ts canFailover/failoverChat | ✅ | 仅限流/鉴权 + 流式已流守卫 + resolver 会话清除 + 第二账号错误；**已修：failover 成功/失败路径均标记原账号失败（markFailureAfterConfirm+markImageLimited，对齐上游 server.go:1267/2059/2068，2026-08-27）** |
| B8 | 账号 API（列表/刷新/删除/清冷却/schedule/token-health） | server.go | `src/admin/handlers.ts` | ✅ | /api/accounts* 全端点✓、admin 鉴权两端一致✓；**已修（2026-08-27）：MarkCall 移植（chatCall/流式/images/admin chat 埋点，DO /health/mark-call + KV 兜底）、视图补 callCount/rateLimited(limited 标志)/imageLimited(独立标志)/authFailed/authFailReason/throttling/concurrency（DO /semaphore/snapshot）、token-health GET expires_in 改 Go duration 格式**；boundProxy 随代理池删除（J1） |

## C. 存储与状态

| # | 功能点 | 上游 | Worker | 状态 | 检测要点 |
|---|--------|------|--------|------|---------|
| C1 | 数据持久化 | JSON 文件 + persistStore | KV 文档键 + D1 行（优先） | ⚠️ [平台] | **2026-08-27 storage audit 后**：D1 绑定时 api_keys/accounts/cache_stats 迁 D1 行（0003）、resolver 索引迁 D1（0004）、usage/debug 迁 D1（0001），KV 文档降级为镜像+回退（仅结构性变更写镜像）；未绑 D1 时 KV 文档即时写替代落盘循环 |
| C2 | 敏感数据 | atomicfile 0600 + 加密 | KV/D1 边界 | [用户选择] | 见 A12；refresh token 明文存 KV 文档或 accounts 表，依赖平台边界安全——已确认选择，非待办 |
| C3 | 用量统计 | usage.jsonl（5 万条滚动） | KV 日桶（90 天、单桶 5000 条）或 D1 usage_events | ⚠️ [简化] | Free 计划面板最多读约 30 桶；**待修：D1 分支 usage_events 无 TTL/滚动清理**（0001 迁移的 DELETE 仅 apply 时执行一次，cron 未含 usage 清理，与上游 5 万条上限不对齐） |
| C4 | 调试日志 | debug.go 文件 | KV 环形（≤256KiB/条、**48h TTL**、500 条）或 D1 debug_records（7 天） | ⚠️ [简化] | 500 条上限/256KiB 截断/敏感键脱敏/仅 debug 等级捕获均对齐；流式经 tee 聚合补录 responseBody；D1 分支保留 7 天（cron DELETE） |
| C5 | D1 可选绑定 | —（无） | migrations 0001-0004 + chatMessages.ts | 🟦 新增 | 0001 usage_events/debug_records、0002 chat_messages、0003 api_keys/accounts/cache_stats（storage audit）、0004 resolver_sessions（storage review）；各 store D1 优先 + KV 镜像/懒回填 + 未绑定自动回退 KV |
| C6 | DO 协调（锁定/游标/信号量/刷新互斥） | 进程内 | `src/do/coordination.ts` | ✅ | COORD 绑定时跨 isolate 强一致；未绑定回退 isolate 行为 |

## D. 会话与对话

| # | 功能点 | 上游 | Worker | 状态 | 检测要点 |
|---|--------|------|--------|------|---------|
| D1 | 内容键会话复用（显式 ID>前缀>后缀，IP+UA 指纹，512 上限，LRU 1000） | session_resolver.go | `src/pipeline/resolver.ts` | ✅ | 逐字移植；README"Jaccard"为上游文档滞后 |
| D2 | SESSION/CONTEXT TTL 旋钮 | env | 固定 2h | ❌ | M365_SESSION_TTL_MINUTES / M365_CONTEXT_TTL_MINUTES 未读取 |
| D3 | 用户级会话（body.user → 固定账号+对话） | sessions.go | `src/admin/extras.ts` | ✅ | tenant=SHA-256(API key)，7 天 TTL（旋钮未读取） |
| D4 | convCache 增量复用 | conv_cache.go | `src/store/convCache.ts` | ✅ | account+model 粒度（C7 已对齐）、sysHash、2h TTL |
| D5 | 自动清理（闲置 2h/keepN=5/保护集/删联动/30 删除预算） | auto_cleanup.go | `src/pipeline/cleanup.ts` Cron | ✅ | Cron 每 30 分钟；单次 30 删除预算 [简化] |
| D6 | 白名单（KV 持久化+保护集+控制台卡片） | conversation_manager.go | `src/admin/extras.ts` | ✅ | /api/conversations/whitelist |
| D7 | 云端对话列表 | m365cloud.go | `src/pipeline/m365cloud.ts` | ⚠️ | RefreshNavPane 已移植；**缺解析器会话合并行**（gateway 来源标记、chatName 推导、messageCount） |
| D8 | 对话详情 | 云端实时拉取 | D1 `chat_messages` 转录 | ⚠️ [简化] | 仅记录本版本部署后的 /v1 轮次；D1 未绑定返回空时间线+detail_unavailable |
| D9 | 对话删除/清理联动 | conversation_manager.go | handlers + cleanup | ✅ | 本地索引+绑定+转录联动删除 |
| D10 | 云端批量清理 | m365cloud.go | `handleM365Cleanup` | ❌ | 占位（返回 deleted:[]），Cron 自动清理是等价物 |

## E. 管理 / 控制台端点

| # | 功能点 | 上游 | Worker | 状态 | 检测要点 |
|---|--------|------|--------|------|---------|
| E1 | /api/admin/keys CRUD | keys.go | handlers | ✅ | 仅哈希、回读语义一致 |
| E2 | /api/admin/models 列表/测试/同步 | codex_catalog.go + server.go | handlers | ✅ | 测试走真实 ChatHub；同步两级探测（匿名 CDN → 账号 Bearer），KV 持久化 discoveredTones（上游仅内存 24h TTL [简化]） |
| E3 | /api/admin/settings GET/PUT | settings.go | handlers | ⚠️ | 校验规则基本一致；上游允许空 modelMappings、Worker 要求至少一条（[用户选择]）；tone 校验上游动态白名单、Worker 纯格式 |
| E4 | /api/admin/deployments 系列 | deployments.go | handlers | ⚠️ | GET 空数组占位；创建/探活 501（自部署管理自身无意义） |
| E5 | /api/admin/migrate/usage-kv-to-d1 | — | extras.handleUsageKvBackfill | 🟦 新增 | D1 一次性回填 |
| E6 | /api/plugins | plugins.go | extras.handlePluginsList | ✅ | 2026-08-27 复核确认完整（substrate 透传+5min KV 缓存+双通道鉴权） |
| E7 | /api/chat · /api/chat/stream | server.go chatOnce + stream.go | `src/admin/chat.ts` | ✅ | 归一化事件+语义事件+done 帧，完成后发送同上游 |
| E8 | /api/conversations 列表/删除/清理 | sessions.go | handlers | ⚠️ | 返回显式绑定（sessions.json 等价物）；cleanup 三模式映射到 Cron 清理 |
| E9 | /api/stats · /api/stats/reset | cache_stats.go | handlers | ✅ | 缓存命中统计真实数据 |
| E10 | /api/usage · /api/usage/logs | usage_http.go | handlers | ⚠️ | 聚合口径一致；存储为 KV 日桶（C3） |
| E11 | /api/health | server.go | handlers | ⚠️ | accountConcurrency 恒 `{}`（不回读 DO 实时占用，避免额外往返） |
| E12 | /api/version | version.go | handlers | ⚠️ | version `0.5.0-cfworker.x`、go 字段 cloudflare-workers、uptimeSeconds 恒 0 [平台] |
| E13 | /api/update | server.go | handlers | ✅ | 上游本身只读 stub（updateAvailable 恒 false） |
| E14 | /v1/memory/* + /api/admin/memory/* | memory_handlers.go | extras | ✅ | substrate 透传 5 头逐字对齐；变更要求管理员会话；admin 变体新增 |
| E15 | 控制台前端页面 | web/*.html | assets/*.html | ✅ | 同源页面托管；「代理池」页已移除、「部署」「调试日志」空数据 |

## F. 图片生成

| # | 功能点 | 上游 | Worker | 状态 | 检测要点 |
|---|--------|------|--------|------|---------|
| F1 | /v1/images/generations | images.go | `src/api/images.ts` | ✅ | 提示词模板、事件图片提取、配额 429+Retry-After 86400、Designer 域名换 token |
| F2 | /v1/images/edits（multipart） | images.go | images.ts | ✅ | operation=edit 复用生成管线 |
| F3 | /v1/images/files/<id> | m365cloud.go | images.ts + KV | ⚠️ [简化] | KV 15min TTL、15MB 上限（超限仅 b64_json）；上游内存 20MB |
| F4 | 图片回传（image_url 块） | server.go:2705-2712 | openai.ts downloadImageAsDataURI | ✅ | A6 已修 |

## G. MCP

| # | 功能点 | 上游 | Worker | 状态 | 检测要点 |
|---|--------|------|--------|------|---------|
| G1 | MCP SSE server（endpoint 握手/JSON-RPC 分发/错误码） | internal/mcp/server.go | `src/mcp/server.ts` | ✅ | initialize/tools/list/tools/call；-32000/-32700/-32601 逐字对齐 |
| G2 | 全局工具注册表 | tools.go | server.ts globalToolRegistry | ✅ | /v1/chat 请求工具自动合并 |
| G3 | 出站 SSE 客户端（桥接） | internal/mcp/client.go | `src/mcp/outbound.ts` | ✅ | 30s 队列语义、超时回占位文案；stdio 不适用 [平台] |
| G4 | MCP 会话（跨 isolate） | server.go 会话表 | `src/do/mcp-hub.ts` DO | ✅ | MCP_HUB 绑定时跨 isolate；未绑定 isolate 内存 |

## H. 中间件与可观测

| # | 功能点 | 上游 | Worker | 状态 | 检测要点 |
|---|--------|------|--------|------|---------|
| H1 | 访问日志 httpTrace | http_trace.go | Workers 内置日志/wrangler tail | ⚠️ [平台] | X-Request-ID 已补齐 |
| H2 | panic 恢复 | recover.go | index.ts try/catch 500 JSON | ✅ | fetch 入口统一 |
| H3 | 请求体上限 | server.go 10MiB | index.ts | ✅ | 400 bad json |
| H4 | M365_TRACE 详细 trace | server.go | — | ❌ | 仅 console.error 关键路径 |
| H5 | public_identity 清洗 | public_identity.go（默认关） | — | ❌ | 上游默认关闭的可选特性，个人自部署收益低 |

## I. 环境变量对照

| # | 变量 | 状态 | 说明 |
|---|------|------|------|
| I1 | ADMIN_PASSWORD / M365_BROWSER_* / M365_CLIENT_ID / M365_AUTHORITY / M365_REDIRECT_URI / M365_SCOPE | ✅ | vars/secrets 生效 |
| I2 | M365_AUTHORIZE/TOKEN/DEVICE/DEVICE_TOKEN_ENDPOINT | ✅ | A9 已补（2026-08-27）；ROPC 除外（恒 organizations，对齐上游 token.go） |
| I3 | M365_CHAT_TIMEOUT_SECONDS / M365_AUTO_CLEANUP* | ✅ | 生效 |
| I4 | M365_INCLUDE_UPSTREAM_EVENTS | ✅ | A3 已补（2026-08-27） |
| I5 | M365_ENABLE_MEMORY_V2 等 8 个 flags | ✅ | 播种 settings.featureFlags → optionsSets；memoryV2 默认开，其余效果待上游 payload 实测 |
| I6 | M365_LISTEN / M365_DATA_DIR / M365_CONFIG / M365_TOKEN_CACHE / M365_SESSION_CACHE / M365_API_KEYS / M365_USAGE_LOG / M365_DEBUG_LOG / M365_PERSIST_INTERVAL | — [平台] | 无文件系统/端口概念 |
| I7 | M365_PROXY_POOL / M365_PROXY_INSECURE_TLS / M365_PROXY_HEALTH_URL / outbound.EnvProxy | ❌ [平台] | 代理池已删除 |
| I8 | M365_SESSION_TTL_MINUTES / M365_CONTEXT_TTL_MINUTES | ❌ | 固定 2h（D2） |
| I9 | M365_USER_SESSION_TTL_MINUTES | ❌ | 固定 7 天（D3） |
| I10 | M365_PUBLIC_IDENTITY_POLICY | ❌ | 随 public_identity（H5） |
| I11 | M365_TRACE | ❌ | 随 H4 |
| I12 | M365_MAX_TOOL_CALLS_PER_TURN / M365_MAX_TOOL_ROUNDS | ✅ | 经 settings 生效（控制台可编辑） |
| I13 | M365_RATE_LIMIT_COOLDOWN_SECONDS / M365_MAX_CONVERSATION_MESSAGES | ⚠️ | M365_RATE_LIMIT_COOLDOWN_SECONDS 已移植（settings.rateLimitCooldownSeconds，5-3600 校验，2026-08-27）；M365_MAX_CONVERSATION_MESSAGES 未移植（仅上游 logThrottlingWarning 使用） |
| I14 | M365_CONTEXT_SIMILARITY | — [死代码] | 上游代码中不存在 |

## J. 平台裁剪（Workers 限制，非缺陷）

| # | 功能点 | 说明 |
|---|--------|------|
| J1 | 出站代理池（HTTP/SOCKS） | 已彻底移除（含控制台页面、账号 Proxy 列、绑定端点） |
| J2 | WS 连接池 connpool | isolate 无法跨请求持有连接；每请求新建（多一次握手 RTT） |
| J3 | 连接预热 preheater | [死代码] 上游本身是 stub |
| J4 | 文件系统类（atomicfile/persistStore/graceful shutdown） | KV 即时写替代 |
| J5 | MCP stdio 出站 | 无子进程，走 SSE 传输 |
| J6 | 部署方式（Dockerfile/compose/manage.py/pkce_gateway.py） | wrangler dev/deploy 替代 |
| J7 | Device Code 流 | [死代码] 上游未挂接任何路由；FOCI clientId 逻辑已移植 |

## K. 用户选择差异（已确认，无需处理）

| # | 差异 | 说明 |
|---|------|------|
| K1 | 高度自定义模型映射表 | 默认 11 条内置（上游 3 条 sol/terra/luna）；未映射模型直接 400（上游内置表回退+effort 升级）；/v1/models 纯 mapping 驱动（上游有 gatewayModels 兜底） |
| K2 | KV 明文存储 | 账号 token 明文存 KV（上游 AES-GCM 加密落盘） |
| K3 | Anthropic 真流式 | 真增量优于上游"完成后重放" |
| K4 | 并发门控降级 | COORD 未绑定时静默不门控（上游直接 429） |
| K5 | 模型路由严格映射 | 同 K1 |
| K6 | admin 密码 SHA-256 | 上游 bcrypt；强度/历史策略曾移植后回退 |

## L. 检测建议（按优先级）

1. **高**：D7 云端对话列表合并解析器会话；D2/D3 TTL 旋钮
2. **中**：I13 上游新增 settings 字段（MaxConversationMessages 未移植）；D10 批量清理；**C3 D1 分支 usage_events 补 cron TTL 清理（DELETE 90 天前，对齐上游 5 万条滚动上限语义）**
3. **低**：H4 M365_TRACE、H5 public_identity、E4 deployments 完整化
4. 每次部署后建议跑 `npm run check`（typecheck + vitest + i18n + wrangler dry-run）做回归
5. **已落地（2026-08-27）**：B1 并发预筛+动态 Retry-After、B2 偏好并发检查、B3 全分类冷却+全局熔断+quotaAttempts+rateLimitCooldownSeconds、B6 并发满不进候选、B7 failover 原账号冷却、B8 MarkCall+视图字段+token-health 格式
6. **已核实（2026-08-27）**：C1-C6 存储与状态逐项复核——C4 KV TTL 实为 48h（清单修正）、C5 migrations 已扩至 0004（清单修正）、C3 D1 分支 usage 清理缺口（新增待办）
