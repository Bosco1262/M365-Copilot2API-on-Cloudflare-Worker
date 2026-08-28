# 上游对齐对比文档（API 访问全流程 / 鉴权与安全 / 账号生命周期）

> 生成日期：2026-08-27
> 对比对象：**本地移植参照副本** `M365-Copilot2API-main`（非 git 仓库）
> 基准定位：本地副本 = 上游 [HEXUXIU/M365-Copilot2API](https://github.com/HEXUXIU/M365-Copilot2API) **master @ commit `e9250a69e35f90f4bbfb8423d52f13ffdd7a3a9b`**（"docs: one-line install commands; ci: auto-refresh README links"），全量逐字节一致（`diff -rq` 零差异，2026-08-27 验证）
> 版本位置：**v0.6.0（`99872ace`）之后 3 个 commit、v0.6.1（`adaf9f1`）之前**，即「v0.6.0 + `1b1d53e`(SSE/connpool/delta) + `0ffe0f7`(CI matrix) + `e9250a6`(docs)」
> 当前项目：`M365-Copilot2API-on-Cloudflare-Worker`（TypeScript / Cloudflare Workers + D1 + KV + Durable Objects）
> 状态口径：**✅ 已对齐**（Aligned）｜**🔶 有意保留差异**（Intentional divergence，含平台限制、用户选择、增强型差异，均已人工确认，非待办）
> 追踪建议：本文件为版本追踪基准，以**本地副本 e9250a6** 为锚点；上游每次发版后按末尾"版本追踪"一节核对差异。

---

## 0. 参照版本说明（重要）

### 0.1 本地副本定位结论

经逐 commit 下载 GitHub 源码全量比对（`diff -rq`）：

| 候选版本 | 与本地副本差异 | 结论 |
|---------|--------------|------|
| v0.6.0（`99872ace`） | 3 文件（client.go / connpool.go / recover.go） | 本地副本更新（含 `1b1d53e` 内容） |
| `1b1d53e`（perf: SSE/connpool） | 2 文件（release.yml / README.md） | 本地副本更新（含 `0ffe0f7`/`e9250a6` 内容） |
| **`e9250a6`（docs/ci）** | **0 差异** | **✅ 本地副本 = 该 commit 快照** |

**基准 = 上游 master @ `e9250a69e35f90f4bbfb8423d52f13ffdd7a3a9b`**（下文"上游"均指此基准）。

### 0.2 与正式发布 tag 的关系

```
v0.6.0 (99872ace) ── 1b1d53e ── 0ffe0f7 ── e9250a6 ← 本地副本基准 ── 0eed0c5 ── adaf9f1 = v0.6.1
   └─ 协议对齐+HAR        └─ SSE/连接池   └─ CI matrix   └─ docs/README          └─ throttling/failover/错误码 └─ dashboard
```

- 本地副本 = **v0.6.0 + `1b1d53e`（SSE Flush 修复、连接池 keepalive pump、writeAtCursor delta）** + CI/README 更新（与本项目无关）
- **不含** v0.6.1 的两个功能 commit：`0eed0c5`（结构化 metering throttling + 15min 冷却 + permissive failover + OpenAI 错误码 `code/param` + 全局熔断收窄）与 `adaf9f1`（dashboard 配额可视化）
- v0.6.1 相对本基准的待跟进项见 §5 版本追踪（共 5 项，P1 两项：metering throttling、全局熔断范围）

---

## 1. 总体对齐状态

| 模块 | 对齐状态 | 结论摘要 |
|------|---------|---------|
| **API 访问全流程** | ✅ 已对齐（含 1 处待定差异 + 4 类有意保留） | 协议层载荷逐项对齐或超集（本地副本已含 `1b1d53e` 的 delta 流式增强）；**1 处待定**：`conversationSignature` 接线（上游 v0.6.0 有、本地副本 e9250a6 重构丢失、本项目随副本未带）；有意保留：WS 连接池[平台]、并发门控降级[用户选择]、Anthropic 真流式[增强]、admin 密码未配置检查 |
| **鉴权与安全** | ✅ 已对齐（A1–A12，含 3 类有意保留） | A1/A2/A4/A5/A6/A7/A9/A11 完全对齐；A8 已补 Permissions-Policy；A3 已补 COORD 未绑定本地锁定兜底；A10 [平台] 附件 SSRF；有意保留：A12/K2 refresh token 明文[用户选择]、K6 admin 密码 SHA-256[用户选择]、ROPC organizations 端点修复 |
| **账号生命周期** | ✅ 已对齐（B1–B8 全部落地，含 2 类有意保留） | B1 并发预筛+动态 Retry-After、B2 lastHealthy 偏好+并发检查、B3 全分类冷却+全局熔断+quotaAttempts+旋钮、B4 限流确认探测、B6 并发满不进候选、B7 failover 原账号冷却、B8 MarkCall+视图字段+格式对齐；有意保留：B5 图片冷却窗口（至 UTC 午夜 vs 24h）、B6 等待语义（15s vs 阻塞） |

---

## 2. 模块一：API 访问全流程

> 范围：`/v1/chat/completions`、`/v1/messages`、`/v1/responses`、`/v1/images/*` 的请求准备 → 账号选择/并发 → ChatHub 协议层（SignalR WS）→ 流式/工具调用 → 响应组装。
> 上游（本地副本 e9250a6）：`internal/web/server.go`、`internal/chathub/client.go` 等；本项目：`src/api/*`、`src/chathub/*`、`src/pipeline/*`。

### 2.1 关键特性对比

| # | 特性 | 上游（本地副本 e9250a6） | 本项目 | 状态 |
|---|------|------------------------|--------|------|
| F1 | 请求体上限 / bad json | 10MiB + 400 | `index.ts` 400 bad json（H3） | ✅ 对齐 |
| F2 | tone 解析（model→tone，effort 升级） | `reasoningTone` | `catalog.ts reasoningTone` | ✅ 对齐 |
| F3 | functions→tools / function_call→tool_choice 归一化 | server.go:1554-1564 | openai.ts | ✅ 对齐 |
| F4 | 上下文滑动窗口预算 + 截断头 | `slidingWindow` + `X-M365-Context-Truncated` | `src/pipeline/contextBudget.ts`（A2） | ✅ 对齐 |
| F5 | 工具消息校验（tool_call_id） | `validateToolConversation` | `validateToolConversation`（A3） | ✅ 对齐 |
| F6 | maxToolRounds 409 | `buildAgentLedger + CanContinue` | `ledgerCanContinue`（router 分支） | ✅ 对齐 |
| F7 | 会话复用（sessionKey / resolver / convCache） | sessionResolver / convCache（acc+model+sysHash） | resolver.ts / convCache.ts 逐字移植 | ✅ 对齐 |
| F8 | 流式 router 预调用 | server.go:1810-1881 | streamChatCompletions 预调用块（D1） | ✅ 对齐 |
| F9 | 流式 holdback 尾缓冲 | 3-rune | holdback.ts RUNE_HOLDBACK=3（D2） | ✅ 对齐 |
| F10 | failover 守卫 | 仅限流/鉴权 + 流式已流守卫 + resolver 会话清除 | canFailover + emittedAny（A1/B7） | ✅ 对齐 |
| F11 | tone=Magic 空完成兜底 | server.go:2467-2475 | openai.ts | ✅ 对齐 |
| F12 | 无效工具 repair | 流式/非流式 REPAIR RULE | 流式+非流式 repair（A5） | ✅ 对齐 |
| F13 | 图片多模态回传 | `res.Images` → image_url data URI（上游 images.go 无 SSRF 校验） | openai.ts downloadImageAsDataURI（两端一致无校验） | ✅ 对齐 |
| F14 | 图片额度/内容策略标记 | ErrImageLimit / ErrOffensiveContent → MarkImageLimited | ImageLimitError/ContentPolicyError + markImageLimited（A7） | ✅ 对齐 |
| F15 | 限流确认探测 | `confirmRateLimitNotice`（上游为死代码，未接线） | `markFailureAfterConfirm` 已接线（E2，B4） | ✅ 对齐（TS 为增强） |
| F16 | Anthropic tool_use / stop_sequences | protocol_compat.go 结构化转换 | anthropic.ts 结构化 tool_use + stop_sequences（C9/C10） | ✅ 对齐 |
| F17 | Responses custom exec 桥接 | custom_tool_call + workspace 指令 | responses.ts（A8） | ✅ 对齐 |
| F18 | Responses 历史隔离 | 内存 `tenant\0session` 双隔离 | KV `resp-history/{tenant}/{session}/{id}` + 256 上限（E4） | ✅ 对齐（机制不同[平台]） |
| F19 | 元数据输出（throttling/scores/metrics/events） | X-M365-Throttling/Scores/Metrics + m365.events | compatM365Metadata + 头输出 + `M365_INCLUDE_UPSTREAM_EVENTS`（E1） | ✅ 对齐 |
| F20 | writeAtCursor token 级 delta | **本地副本已含 `1b1d53e` 的 delta 增强**（v0.6.0 为恒 emitSnapshot） | 与本地副本一致（token 级 delta） | ✅ 对齐（超集，优于 v0.6.0） |
| F21 | **conversationSignature 透传** | 上游 v0.6.0 有接线（client.go:1473-1474）；**本地副本 e9250a6 重构 arg0 时丢失** | 未接线（随本地副本移植） | 🔶 待定（详见 2.3-①） |
| F22 | ChatHub 载荷保真（variants/optionsSets/allowedMessageTypes/clientInfo/isStartOfSession=false/Metrics 真实时间戳） | 62 项/42 项/30 项/9 字段 | protocol.ts 逐项对齐（B1-B10） | ✅ 对齐 |
| F23 | 附件远程下载 + SSRF | ssrf.go（DNS 解析复查） | client.ts validateRemoteDownloadURL（IP 字面量+黑名单+每跳复查） | ✅ 对齐（[平台] 见 2.3-④） |
| F24 | 图片生成/编辑/文件端点 | images.go | src/api/images.ts（F1-F4） | ✅ 对齐 |
| F25 | prompt 级工具协议注入 | 上游同样受 hasPlugins 恒 true 影响（注入死代码） | injectToolProtocol 已绕过（D3，TS 先行修复） | ✅ 对齐（TS 为增强） |

### 2.2 已对齐（行为等价）关键点摘要

API Key 提取、tone 解析、prompt 扁平化（system/developer 归并 + 4000 字符工具结果截断）、tool_choice 允许矩阵、fenced/native 工具检测、schema 校验、buildToolResponse 512 字符分片、tool refusal/沙箱幻觉纠正重试、completionEvidence 门禁、contentPolicy 503、CSP/安全头（见模块二）。

### 2.3 有意保留 / 待定差异及理由

| # | 差异 | 上游行为 | 本项目行为 | 类型 | 理由 |
|---|------|---------|-----------|------|------|
| ① | **conversationSignature 未接线** | v0.6.0 有接线；**本地副本 e9250a6 已丢失**（重构 arg0 时遗漏） | 不携带该字段（随本地副本移植） | 待定 | 该字段为会话签名令牌，缺省不影响正常对话续接；与移植参照副本行为一致、避免引入未经实测字段。**如上游实测必需可一行补回**（protocol.ts chatPayload 增加可选字段） |
| ② | WS 连接池 connpool | 连接复用 + parking 保活（`1b1d53e` 增强） | 每请求新建 WS（多一次握手 RTT） | [平台] | Workers isolate 无法跨请求持有连接（J2） |
| ③ | 并发门控降级 | 并发满直接 429 | COORD 未绑定时静默不门控 | [用户选择] | 单 operator 部署 COORD 常绑定；未绑定降级保持可用性（K4，C5） |
| ④ | 附件 SSRF 域名解析复查 | `net.LookupIP` 解析后逐 IP 复查 | 仅 IP 字面量 + 域名黑名单（nip.io/.internal/.local） | [平台] | Workers 无运行时 DNS API；其余行为（仅 https、每跳复查 ≤5 跳、10MiB）对齐 |
| ⑤ | Anthropic 流式形态 | 内适配非流式、完成后重放 SSE | 真流式（message_start → 逐块 delta） | 增强 | 真增量优于"完成后重放"，首 token 延迟更低（C11，用户特意保留） |
| ⑥ | admin 密码未配置检查 | 非 /v1 控制台路径先查 `adminPassword==""` → 503 | 无等价检查 | 保留 | Worker 有 `ADMIN_PASSWORD` env 与默认 bootstrap 密码，缺省即用（C16） |

---

## 3. 模块二：鉴权与安全

> 范围：API Key 提取/存储、Admin 登录/会话、OAuth PKCE/ROPC/刷新、安全响应头、X-Request-ID、SSRF、CSP。
> 该模块文件在 v0.6.0 / 本地副本 e9250a6 / v0.6.1 间无实质差异（仅 gofmt），以下结论对三者均成立。

### 3.1 逐项对比（A1–A12）

| # | 功能点 | 上游（本地副本 e9250a6） | 本项目 | 状态 |
|---|--------|------------------------|--------|------|
| A1 | API Key 提取（X-API-Key / Bearer） | server.go:599-617，前缀 m365_ 仅限生成 | `src/api/auth.ts` 逐行对应 | ✅ 对齐 |
| A2 | API Key 存储（仅 SHA-256 哈希） | keys.go，落盘 0600 | `src/store/keys.ts`（D1 表 + KV 镜像，D1 模式撤销即时生效） | ✅ 对齐（更强） |
| A3 | Admin 登录 / 会话 / 失败锁定 | bcrypt + 进程内 5 次/15min 锁定 | SHA-256[用户选择] + COORD 锁定 + **isolate 本地兜底**（2026-08-27 已补） | ✅ 对齐（密码算法有意差异） |
| A4 | 强制改密 / 登出失效 / SameSite | 改密清全会话 + Cookie HttpOnly+SameSite=Lax | 一致 + 改密清空 KV 会话 | ✅ 对齐 |
| A5 | OAuth PKCE / nativeclient 粘贴流 | pkce.go S256、state 内存 10min TTL | `src/auth/oauth.ts` + KV state 600s TTL | ✅ 对齐 |
| A6 | Token 刷新单飞防抖 | 进程内 inflight map | isolate 合并 + **COORD 命名互斥 `refresh:<id>` 30s** + 轮询 ≤15s | ✅ 对齐（跨 isolate 更强） |
| A7 | ROPC 密码登录 | 恒 organizations 端点（**默认 authority 下拼接出 404 缺陷**） | origin 拼法恒 organizations（修复上游 404） | ✅ 对齐（修复上游缺陷） |
| A8 | 安全响应头 | nosniff / DENY / no-referrer / **Permissions-Policy** | 全对齐（2026-08-27 补 Permissions-Policy） | ✅ 对齐 |
| A9 | X-Request-ID 关联 | 全请求服务端生成 | 全 API + 页面均带（2026-08-27 补页面） | ✅ 对齐 |
| A10 | 附件 SSRF 防护 | ssrf.go DNS 复查 | client.ts IP 字面量+黑名单+每跳复查 | ✅ 对齐（[平台] DNS 复查受限，见 2.3-④） |
| A11 | 完整 CSP | security_http.go 全响应 CSP（含外部 CDN） | `assets/_headers` + `withSecurityHeaders` 全页面/API（**比上游更严**，无外部 CDN） | ✅ 对齐（更严） |
| A12 | refresh token 落盘加密 | AES-256-GCM（无主密钥时用内置 fallback key） | 明文存 KV/D1（Cloudflare 边界保护） | 🔶 有意保留（K2） |

### 3.2 有意保留差异及理由

| # | 差异 | 上游 | 本项目 | 理由 |
|---|------|------|--------|------|
| S1 | Admin 密码哈希 | bcrypt（DefaultCost） | SHA-256 hex | [用户选择 K6]：Workers 无同步 bcrypt 成本优势；SHA-256 满足密码比对目标，历史强度策略曾移植后回退 |
| S2 | refresh token 存储 | AES-GCM 加密落盘 | 明文 KV/D1 | [用户选择 K2/A12]：KV/D1 由 Cloudflare 静态加密与边界保护，个人自部署威胁模型下收益低；上游无主密钥时也是内置密钥"弱保护" |
| S3 | ROPC 端点拼接 | `Authority()+"/organizations/..."`（common 下 404） | `origin + "/organizations/..."`（默认即有效） | 修复上游拼接缺陷，语义一致（恒 organizations），`M365_TOKEN_ENDPOINT` 不影响 ROPC |
| S4 | Secure Cookie 判定 | 仅 TLS 或 loopback+XFP https | 任意 https/XFP-https | 更宽松更安全（公网部署恒 https），无风险 |
| S5 | PKCE state 存储 | 进程内存 10min | KV 600s TTL | [平台]：跨 isolate 可用，TTL 语义相近 |
| S6 | Admin 密码强度策略 | 12 位 + 4 类 + 黑名单 + zxcvbn + 历史 5 条 | ≥6 位 + 3 条 | [用户选择 K6]：曾移植后回退，个人自部署按需取舍 |

---

## 4. 模块三：账号生命周期

> 范围：账号轮询/偏好/健康冷却/限流确认/图片额度/并发限制/故障转移/账号 API。
> 该模块文件在 v0.6.0 / 本地副本 e9250a6 间**零差异**（account_health.go / account_concurrency.go / server.go 账号部分一致）；v0.6.1 的 metering throttling 相关属待跟进（见 §5）。B1–B8 全部修复于 2026-08-27。

### 4.1 逐项对比（B1–B8）

| # | 功能点 | 上游（本地副本 e9250a6） | 本项目 | 状态 |
|---|--------|------------------------|--------|------|
| B1 | 账号轮询 round-robin | 进程内游标 `nextIdx % n`，maxAccountProbe=16 | COORD DO 原子游标（/next-account + /next-healthy）/ KV cursor 兜底；**选号并发预筛** + **全冷却 Retry-After 动态 EarliestRecovery（≥5s）** | ✅ 对齐（跨 isolate 更强） |
| B2 | lastHealthyAccount 偏好 | 内存字段，无 TTL | KV `account-last-healthy`（12h TTL）+ **偏好命中补并发检查** | ✅ 对齐 |
| B3 | 健康/冷却 | 19 类分类冷却 + 全局熔断（30s 窗口≥10 请求失败率≥50%）+ quotaAttempts 指数退避 | `classifyError`/`cooldownMsForCategory` 全分类移植（401=2min/403=24h/429 指数 30s·2^(n-1)/503=15s/传输类 15-30s/UPSTREAM_STRUCTURED=10s）+ 熔断进 DO + quotaAttempts + `rateLimitCooldownSeconds` 旋钮 | ✅ 对齐（含 1 处 v0.6.1 收窄差异，见 §5） |
| B4 | 限流确认探测 | `confirmRateLimitNotice`（死代码） | `markFailureAfterConfirm` 已接线（"Reply with exactly: OK" 30s 探测） | ✅ 对齐（TS 为增强） |
| B5 | 图片额度/内容策略标记 | `MarkImageLimited` 24h 滚动窗口；imageGen 三函数死代码 | `markImageLimited` **至 UTC 午夜** + `imageLimited` 独立标志 | 🔶 有意保留（见 4.2-①） |
| B6 | 账号并发限制（默认 8） | `Acquire` 阻塞排队，选号跳过并发满账号 | DO 信号量（**15s 有界等待后 429**）+ **并发满不进候选**（/next-healthy 预筛）；未绑定不门控[用户选择 K4] | ✅ 对齐（等待语义有意差异） |
| B7 | 故障转移 failover | 成功/失败分支均 MarkFailure(原账号) + MarkImageLimited | `failoverChat` 成功/失败路径均 `markFailureAfterConfirm(原账号)` + markImageLimited | ✅ 对齐 |
| B8 | 账号 API | 列表/刷新/删除/清冷却/schedule/token-health/bind-proxy | 全端点 + **MarkCall 计数** + **视图字段**（callCount/rateLimited/imageLimited/authFailed/authFailReason/throttling/concurrency）+ **token-health Go duration 格式**；bind-proxy 随代理池删除[平台 J1] | ✅ 对齐 |

### 4.2 有意保留差异及理由

| # | 差异 | 上游 | 本项目 | 理由 |
|---|------|------|--------|------|
| ① | 图片冷却窗口 | `MarkImageLimited` 24h 滚动 | 至 UTC 午夜 | 上游 imageLimitUntil 语义与"每日配额"存在偏差；至午夜更贴合配额周期。触发路径（ErrImageLimit/imageLimitNotice）完全一致 |
| ② | 并发等待语义 | 阻塞排队直到槽位（无超时） | 15s 有界等待后 429 + Retry-After | Workers 请求时长预算下不可无限排队；配合 /next-healthy 预筛，并发满时直接选健康账号 |
| ③ | 未绑定 COORD 的并发门控 | 进程内恒门控 | 静默不门控 | [用户选择 K4]：单 operator 部署 COORD 常绑定；未绑定降级保持可用性 |
| ④ | 健康状态存储 | 进程内存（单实例） | COORD DO（跨 isolate 强一致）+ KV 兜底 | [平台]：Workers 多 isolate 需要共享状态，DO 方案强于上游进程内 |

---

## 5. 版本追踪（本地副本 e9250a6 之后的待跟进项）

本地副本之后上游又发布了 **v0.6.1**（`adaf9f1`，2026-08-27），相对本基准新增两个功能 commit（`0eed0c5`、`adaf9f1`）。与本项目相关的待跟进项：

| 优先级 | 变更（v0.6.1） | 上游行为 | 本项目现状 | 说明 |
|--------|---------------|---------|-----------|------|
| 🔴 P1 | **metering throttling + 15min 冷却** | client 层 `ErrMeteringThrottled`（type:2 metering 3 处触发）；`recordAccountChatResult` 统一记录（UpdateThrottling + ParseMetering + applyMeteringCooldown）；account_health 新增 lastMeterError/lastMeterAccess/remainingAllowance + UpdateMetering/GetMetering | 未移植（无 ErrMeteringThrottled 检测、无 metering 冷却、无对应健康字段） | 影响配额账号健康管理精度 |
| 🔴 P1 | **全局熔断范围收窄** | 熔断只统计传输类错误（SOCKS5/DNS/TCP/TLS/WS 类）；429/403 等账号级错误不再触发 | `circuitRecord` 对非 CLIENT_CANCELED/GLOBAL_UNAVAILABLE 都计入（**429 也会触发熔断**） | 本项目当前比 v0.6.1 更敏感，需收窄 |
| 🟠 P2 | **permissive failover** | 限流错误即使绑定会话也允许 failover（`(限流\|\|鉴权) && (限流 \|\| 会话可清)`）；failover 分支删除显式 MarkFailure/MarkSuccess（统一到 chatWithAccount 层） | `canFailover` 要求会话非绑定 | 会话绑定场景的限流容错差异 |
| 🟠 P2 | **OpenAI 错误码合规** | 错误响应 JSON 增加 `code`（=type）与 `param: null` | `writeOpenAIError` 无这两个字段 | 客户端兼容性 |
| 🟡 P3 | **dashboard 配额可视化** | per-model 配额 + 冷却时间线 + metering 徽章（web/index.html） | 控制台无此卡片 | 可选 UI 增强 |
| — | Vercel 入口（api/index.go）/ CI matrix / README | 部署与文档 | 与本项目无关（Workers 部署） | 不跟进 |

**发版核对清单**：上游新 tag 后 `diff -rq` 与本地副本 `internal/`，重点文件：`chathub/client.go`、`chathub/connpool.go`、`web/recover.go`、`web/account_health.go`、`web/account_concurrency.go`、`web/stream.go`、`web/protocol_errors.go`、`web/keys.go`、`web/admin_security.go`、`web/security_http.go`、`auth/*.go`。每次改动后跑 `npm run check` 回归。

---

## 附录：差异文件与对照位置

| 功能 | 上游（本地副本 e9250a6） | 本项目 |
|------|------------------------|--------|
| ChatHub 协议载荷 | `internal/chathub/client.go` | `src/chathub/protocol.ts` + `client.ts` |
| API 入口/路由 | `internal/web/server.go` | `src/index.ts` + `src/router.ts` |
| API Key | `internal/web/keys.go` | `src/store/keys.ts` + `src/api/auth.ts` |
| Admin 安全 | `internal/web/admin_security.go` | `src/store/admin.ts` + `src/admin/handlers.ts` |
| OAuth | `internal/auth/{pkce,token,cache}.go` | `src/auth/oauth.ts` + `src/store/accounts.ts` |
| 安全头/CSP | `internal/web/security_http.go` | `src/index.ts` + `assets/_headers` + `src/pages.ts` |
| 账号健康 | `internal/web/account_health.go` | `src/pipeline/account.ts` + `src/do/coordination.ts` |
| 账号并发 | `internal/web/account_concurrency.go` | `src/do/coordination.ts`（信号量） |
| 账号 API | `internal/web/server.go` | `src/admin/handlers.ts` |
| 错误分类 | `internal/web/account_health.go` | `src/errors.ts` |
