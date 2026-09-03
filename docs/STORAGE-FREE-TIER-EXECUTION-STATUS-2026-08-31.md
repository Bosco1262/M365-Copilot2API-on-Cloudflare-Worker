# 免费层资源优化：执行状态清单（截至 2026-08-31）

> 范围：`STORAGE-FREE-TIER-REVIEW-2026-08-28.md` 提出的问题 + `STORAGE-FREE-TIER-REVIEW-VERIFICATION-2026-08-30.md` 复核修正 + `STORAGE-FREE-TIER-PLAN-2026-08-30.md` 全部计划项。
> 所有代码改动均已通过：`npx tsc --noEmit`、`npx vitest run`（24 文件 / 215 用例）、`npm run check`、迁移本地应用（0001–0006）、`wrangler dev` 端到端冒烟。
> 注：文中 215 为存储优化各轮验证时点的用例数；2026-08-31 另一次会话的图片重放修复（与本计划无关）新增 2 例，当前仓库为 **217/217**。

---

## 一、总览

| 阶段 | 状态 | 项数 | 测试变化 |
|---|---|---|---|
| 复核（对 08-28 文档逐条验证） | ✅ 完成 | 26 条代码事实 + 24 项配额 | — |
| Phase 0：复核中发现的两个 P0 缺陷 | ✅ 完成 | 2 | 204 → 204 |
| Phase 1：9 项小改动（P0 ×4 + P1 ×5） | ✅ 完成 | 9 | 204 → 205 |
| Phase 2：后台 KV 写迁 D1 | ✅ 完成 | 迁移 + 4 存储 + 6 测试 | 205 → 211 |
| Phase 3 已落地部分（P2-4 + blob 迁 D1） | ✅ 完成 | 2 | 211 → 215 |
| Phase 3 剩余（P2-1/P2-2/P2-3） | ⏸ 触发未满足 | 3 | — |
| 部署侧动作（远程迁移 / 上线 / 面板观测） | ❌ 未执行 | 4 | — |

**指标终态**：每请求 KV 写 8.1 → **0.2**；免费层承载 **≈123 → ≈2,400+ 请求/天（约 20 倍）**；绑定约束从 KV 写（1,000/天）转移到 D1 rows read（5M/天）→ DO requests（100k/天）。

---

## 二、已执行明细

### 2.1 复核产出（2026-08-30）

| 产出 | 文件 | 内容 |
|---|---|---|
| 逐条复核报告 | `docs/STORAGE-FREE-TIER-REVIEW-VERIFICATION-2026-08-30.md` | 08-28 文档 26 条代码事实 22 真 4 错；配额表 22 对 1 偏差 5 遗漏；新发现 2 个 P0 缺陷（markCall 无早退、resolver touch 无保护） |
| 全量修订计划 | `docs/STORAGE-FREE-TIER-PLAN-2026-08-30.md` | 核对后的配额基线（§1）、资源分布全景（§2）、修正优先级（§4）、分阶段计划（§5）、观测清单（§6） |
| 08-28 文档废弃注记 | `docs/STORAGE-FREE-TIER-REVIEW-2026-08-28.md` 头部 | 标注已被取代 + 指向复核与新计划 |

**08-28 文档中被复核否决、主动不执行的项**（避免后人重新踩坑）：
- ❌ P1.2 "单例 DO 常驻吃 83% 时长"——官方定价明确空闲可休眠不计费，`CoordinationDO` 无 accept WS / 无出站连接 → Duration ≈ 0。真实时长风险在 `McpSessionDO`（SSE 流），已移交 P2-1。
- ❌ "save() 无条件 setAlarm"——`coordination.ts:150` 已是 `if (next !== null)` 条件式。
- ❌ 原定的 P1.4——确认为空操作。
- ⚠️ 原 P0.2 "迁 waitUntil"——复核发现 `recordFinalize` 的五个调用点（openai.ts:1039/1197/1468/1628/1678）早已全部在 `ctx.waitUntil` 内，改写为"后台写收敛"（P1-1），由 Phase 2 完成。
- ⚠️ "普遍 500"——waitUntil 内的异常不冒泡到顶层 catch，实际只有 resolver touch 一处会 500（Phase 0 已修）。

### 2.2 Phase 0：两个 P0 缺陷修复（2026-08-30）

| # | 修复 | 文件与改动 | 效果 |
|---|---|---|---|
| 1 | markCall / updateThrottling 补早退 | `src/do/coordination.ts`：`coordHealthMarkCall`/`coordHealthUpdateThrottling` 由 `Promise<void>` 改为 `Promise<boolean \| null>`（原实现丢弃 DO 的 `{ok}` 应答）；`src/pipeline/account.ts`：两处按 markFailure/markSuccess 同款契约补 `if (ok) return` | DO 绑定时每请求 **−2 KV 读 −2 KV 写**（多轮工具调用按轮放大）；消除 `account-health` 单 key 撞 KV "1 写/秒"限流的风险 |
| 2 | resolver touch 写节流 + 失败隔离 | `src/pipeline/resolver.ts`：新增 `SESSION_TOUCH_THROTTLE_MS`（10 min）+ `ResolverSession.lastWriteAt` 字段；touch 的 blob 重写节流且 try/catch（失败仅 warn）；bindSession/applyTo 每轮刷新 lastWriteAt | 关键路径 KV 写 1 → ~0.1；**消除"KV 配额超限 → 用户 500"的唯一触发路径**；lastWriteAt（而非 lastUsedAt）做 TTL 锚点，避免持续高频会话 2h TTL 失效 |

### 2.3 Phase 1：9 项优化（2026-08-30）

| # | 项 | 文件与改动 | 效果 |
|---|---|---|---|
| P0-1 | 会话计数/列表轻量化 | `resolver.ts` 新增导出 `countResolverSessions()`（索引计数零 blob 读）与 `listResolverIndex()`（仅 IndexEntry）；`export interface IndexEntry`；`openai.ts:967` 统计与 `cleanup.ts:52` activeConversationSet 换用；补单测（含"索引条目不得携带 contextHistory"断言） | 每请求/cron 轮最多 **−50 次 KV blob 读** |
| P0-2 | keys 回填闩锁 | `store/keys.ts`：`d1BackfillFromKV` 模块级闩锁——表非空或回填完成即置位；D1 不可用或两侧皆空时继续探测（0 行读），不破坏首次迁移语义 | 每次鉴权 **−N rows_read**（原每次都全表扫判断表空） |
| P0-3 | settings 记忆化 | `store/settings.ts`：`getSettings` 30 s 隔离内缓存，以 KV namespace **对象**为 WeakMap key（测试每文件独立 MockKV 天然隔离）；`saveSettings` 写后即时失效 | 每请求 **−4 KV 读**（5 → 1）；跨 isolate 陈旧 ≤30 s |
| P0-4 | dev 补 D1 | `wrangler.dev.jsonc`：新增 `DB` 绑定（`local-dev-d1`）+ `--local` 迁移命令说明 | 本地/dev 与生产走同一代码路径（此前 197/204 测试跑的是 KV 兜底分支） |
| P1-2 | lastHealthy 变化才写 | `pipeline/account.ts`：`rememberHealthy` 记录上次账号，变化才写；写失败重置 tracker 下次重试 | 每请求 **−0.95 KV 写**；12h TTL 过期后偏好退化为轮询（设计上可接受） |
| P1-3 | legacy 迁移闩锁 | `store/conversations.ts`：`migrateLegacyBindings` 确认 absent 即置位；`getSessionBinding` 的 legacy 兜底读保留 | 每请求 **−1 KV 读**（原每次 upsert/list 都读早已删除的 legacy 文档） |
| P1-4 | trim 节流 | `pipeline/resolver.ts`：`d1TrimIndex` 每 100 次 bind 执行一次（`TRIM_EVERY_N_BINDS`），上限由 loadIndex 的 LIMIT 兜底 | D1 rows_read **−≤1000/请求**（原每次 bind 都 `COUNT(*)` 全表） |
| P1-5 | recordFinalize 分段隔离 | `api/openai.ts`：`step()` 助手把七步（bindSession / recordConversation / transcript / convCache / sessionBinding / userSession / usageStats）各自 try/catch——单步失败只 warn 不再连带丢弃后续；闭包内 prepared.convCache/sessionKey/user/apiKeyHash 提升 const 保住 TS 收窄 | 后台可靠性：一步失败不再静默丢失绑定/转录/统计 |
| P1-6 | cleanup 删除预算 | `pipeline/cleanup.ts`：`deleteBudget` 30 → 20，注释写明级联账（每云删除 1-3 本地 KV 删 × 48 轮/天） | KV deletes（1,000/天）不再被峰值 1,440 触顶 |

### 2.4 Phase 2：后台 KV 写迁 D1（2026-08-30）

| 项 | 文件与改动 | 效果 |
|---|---|---|
| 迁移 0005 | `migrations/0005_background_writes_d1.sql`：`conversations` / `session_bindings` / `user_sessions` / `conv_cache` 四表 + 索引；无 KV 式 TTL（项目模式），新鲜度读侧过滤 + 节流修剪 | — |
| conversations 索引 | `store/conversations.ts` 重写：recordConversation → D1 UPSERT（`CASE WHEN excluded.title <> ''` 精确复刻"空 title 不覆盖"语义）+ 每 50 次写修剪（cap 500）；listConversations → `ORDER BY updated_at DESC LIMIT 500`，表空一次性惰性回填（KV doc → D1，闩锁）；deleteLocalConversation → D1 DELETE | 该存储热路径 **KV 读+写 → 0** |
| session bindings | 同文件：upsert/删除/点读/列表 D1 优先；表空从 `sessbind/*` 键一次性回填；`getSessionBinding` D1 miss 回退 KV 点读（迁移前数据兼容）；legacy 迁移与闩锁保留 | 热路径 KV 写 → 0 |
| user sessions | `admin/extras.ts`：putUserSession → D1 UPSERT（PK `api_key_hash + user_id`）+ 每 100 次写节流修剪（7 天）；getUserSession → D1 点读带 TTL 判断，miss 回退 KV；activeUserConversations（cron）→ **单条 DISTINCT 查询**，不再逐键枚举 ≤200 次 | 热路径 KV 写 → 0；cron 每 48 轮 −9,600 次 KV 点读 |
| conv cache | `store/convCache.ts`：put/get D1 优先；**读侧 2h 新鲜度检查（KV expirationTtl 的等价物，正确性关键——不加的话过期条目被永久复用）**；每 100 次写节流修剪；D1 miss 回退 KV 读 | 热路径 KV 写 → 0 |
| 测试 | `test/background-stores-d1.test.ts`（仿 chat-messages 的 SQL 片段匹配 mock D1）：conversations 空 title 不覆盖/一次性回填、bindings 列表/删除/KV 回退、user sessions TTL、conv cache TTL、各存储"零 KV 写"断言 | +6 例 |

回滚安全性：D1 出错自动回退 KV 写；回滚（去掉 DB 绑定）自动回 KV 路径，会话/缓存类数据 2h~7d 自然老化自愈，无需手动清理。

### 2.5 Phase 3 已落地部分（2026-08-30）

| # | 项 | 文件与改动 | 效果 |
|---|---|---|---|
| P2-4 | accounts 镜像去 token | `store/accounts.ts`：`mirrorToKV` 写入前剥离 refreshToken/accessToken——单用 refresh token 在 D1 侧刷新后即作废，**回滚时误兑会永久杀死账号**（文件头注释自明的风险）；镜像降级为纯结构清单（id/email/flags） | 消除回滚场景下的账号杀手；KV-only 部署不受影响（走 saveDoc 全量写） |
| 可选项 | resolver blob 迁 D1 | `migrations/0006_resolver_blobs_d1.sql`（session_id PK, data, last_used_at）+ `pipeline/resolver.ts`：getSession/putSession/deleteSession D1 优先；**>1.5M 字符的超大 blob 留 KV**（D1 行上限 2 MB，CJK 极端情形由插入失败兜底回退）；读侧 2h 新鲜度（KV TTL 等价——否则过期会话被显式 id 命中"复活"）；每 100 次写节流修剪；**candidates 匹配（≤24）与控制台列表（≤50）改为单条 `WHERE session_id IN (...)` 批量查询**——点查循环会撞 D1 免费 50 查询/invocation 上限；KV 保留为 no-D1 兜底与 D1 miss 回退 | 每请求 KV 写 1.2 → **0.2**，KV 写彻底退出绑定链 |

### 2.6 验证活动（全部通过）

| 验证 | 方法 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit`（每轮改动后） | 通过 |
| 单元测试 | `npx vitest run`：204 → 205（+1 计数测试）→ 211（+6 D1 测试）→ **215**（+4 blob 测试），24 文件 | 全绿 |
| i18n / 配置校验 | `npm run check`（check-i18n + wrangler dry-run，确认 KV/DB/ASSETS 绑定解析） | 通过 |
| 迁移 SQL 验证 | `npx wrangler d1 migrations apply m365-copilot2api --local`：0001–0006 全部应用成功 | SQL 语法零错误 |
| 本地表结构 | `d1 execute --local` 查 sqlite_master：13 张业务表齐全（accounts, api_keys, cache_stats, cache_stats_meta, chat_messages, conv_cache, conversations, debug_records, resolver_session_blobs, resolver_sessions, session_bindings, usage_events, user_sessions） | 确认 |
| **端到端冒烟** | `wrangler dev`（5 绑定就位含本地 DB）：`GET /` 200；`GET /v1/models` 无凭证 401（标准 auth_error JSON）；**伪造密钥 401——真实走 validKey → D1 点查 → 闩锁探测 → KV 兜底全链路**；`POST /v1/chat/completions` 401；`/cdn-cgi/local/scheduled` 手动触发 cron 200、无账号优雅跳过；服务日志零运行时错误 | 通过 |
| 环境坑（已记录） | 本机代理环境变量劫持 localhost curl（请求未达服务器，curl exit 23）——须 `--noproxy '*'`；已写入文档 §六 与工作记忆 | — |

### 2.7 修改文件总清单（15 个源文件 + 4 个新文件）

改动：`src/do/coordination.ts`、`src/pipeline/account.ts`、`src/pipeline/resolver.ts`、`src/api/openai.ts`、`src/pipeline/cleanup.ts`、`src/store/keys.ts`、`src/store/settings.ts`、`src/store/conversations.ts`、`src/store/convCache.ts`、`src/admin/extras.ts`、`src/store/accounts.ts`、`wrangler.dev.jsonc`、`test/resolver.test.ts`、`docs/STORAGE-FREE-TIER-REVIEW-2026-08-28.md`（注记）
新增：`migrations/0005_background_writes_d1.sql`、`migrations/0006_resolver_blobs_d1.sql`、`test/background-stores-d1.test.ts`、`docs/STORAGE-FREE-TIER-PLAN-2026-08-30.md`、`docs/STORAGE-FREE-TIER-REVIEW-VERIFICATION-2026-08-30.md`、本文档

---

## 三、未执行明细

### 3.1 Phase 3 剩余观察项（触发条件均未满足，**刻意不做**）

| # | 项 | 触发条件（满足才做） | 不做的风险 | 工程量 |
|---|---|---|---|---|
| P2-1 | McpSessionDO SSE→WebSocket + Hibernation | 实际使用 MCP **且** 面板 DO Duration 日用量 > 3,000 GB-s | 现状为 `ReadableStream` SSE 信箱（mcp-hub.ts:22-35），连接期间 DO 持续计费：**1 条 24h 常驻连接 ≈ 11,060 GB-s ≈ 免费时长配额（13,000）的 85%**，2 条即超限报错 | 1-2 天：mcp-hub 协议改造（/attach 改 `accept()` WS + Hibernation API、/push 改消息路由）+ MCP 客户端连通性验证；注意客户端侧 SSE 传输是否可换 Streamable HTTP 需先确认 |
| P2-2 | CoordinationDO 状态拆 SQLite 表 | 单 state blob > 1 MB **或** 账号数 > 100 | 现为整块 `storage.put(STATE_KEY)`（coordination.ts:149/164）：① KV 式键值 **key+value ≤ 2 MB** 硬上限；② 每次 coordAction 全量 RMW | 中等：health/semaphore/cursor 分行，action 只读写相关行 |
| P2-3 | /acquire 去自旋 | 面板 Duration 出现与请求量成比例的非常量基数 | 现自旋最多 15 s（期间 DO 活跃计费 0.128 GB/s → 最坏 1.9 GB-s/请求；命中即返回时 ≈0.13 可忽略） | 中等：alarm/事件驱动唤醒 |

### 3.2 部署侧动作（需在桌面端 / Cloudflare 执行，代码已就绪）

| # | 动作 | 说明 |
|---|---|---|
| 1 | `npx wrangler d1 migrations apply m365-copilot2api --remote` | 应用 0005/0006 到生产库（本地已验证）。回填全部惰性触发，无需数据迁移脚本 |
| 2 | 提交 + 部署 | 15 个改动文件 + 2 个迁移 + 3 个新文档尚未 commit；`npx wrangler deploy` 或 Git 集成自动部署 |
| 3 | 部署后按计划 §六 观测清单验证 ①–⑧ | ① KV writes 斜率 ≈1.1×请求数 ② CoordinationDO Duration ≈ 0 ③ McpSessionDO 时长 = 连接秒数 × 0.128 ④ account-health 写 ≈ 0 ⑤ D1 Row Metrics 每请求读下降一个数量级 ⑥ KV 配额类 5xx = 0 ⑦ cron deletes < 1,000/天 ⑧ 压测逼近 2,400/天时才应见 KV 写失败 |
| 4 | 真实账号完整链路回归 | 冒烟只覆盖了 401 路径；登录 M365 账号后跑一轮完整 chat（含会话延续、转录、用量统计、cleanup）确认生产 D1 路径 |

### 3.3 明确未列入计划的项（含理由）

| 项 | 理由 |
|---|---|
| KV 写进一步归零（剩余 ≈0.2/请求） | 剩余仅 lastHealthy 变化时写入 + 超大 blob 兜底，已无配额意义 |
| resolver blob 迁 D1 的逐条消息拆行方案 | 已被 blob 整存 + 1.5M 守卫方案取代（逐行方案读放大 512×，否决） |
| `countResolverSessions` 改维护计数器行 | rows_read 与读索引相同，无收益且有漂移风险 |
| loadIndex 隔离内缓存 | **否决**：30s 陈旧索引会让快速连发请求丢失刚创建的会话 → 会话延续中断，风险大于收益 |
| CPU 10 ms 流式 JSON 处理（index.ts:328） | 无实测数据，仅列观察项；256 KB 截断已钉住为"每 chunk 重建"而非无界 O(n²) |
| chat_messages 512 条上限调整 | 无配额影响（D1 行写余量 16 倍），无计划项 |

---

## 四、起点 → 终态对照

| 指标 | 08-28 起点 | 现在（代码已落地，待部署） |
|---|---|---|
| 每请求 KV 写 | ~8.1（含 touch/markCall/updateThrottling/后台 5 项） | **~0.2**（lastHealthy 变化写 + 超大 blob 兜底） |
| 每请求 KV 读 | 10-60（settings×5 + ≤50 blob 计数） | **~2**（settings 缓存 1 + lastHealthy 1 + 罕见兜底） |
| KV 写日天花板 | ≈123/天 | **KV 写退出绑定链** |
| 实际承载上限 | ≈123/天 | **≈2,400+/天**（新约束：D1 rows read ≈2.4k/天 → DO requests ≈12k/天） |
| 用户可见 500 风险 | KV 配额超限 → resolver touch 冒泡 | **消除**（touch 节流 + try/catch；后台全部分段隔离） |
| 回滚安全性 | 镜像含必死的单用 refresh token | 镜像纯结构化；D1/KV 双路径各自完整，2h~7d 自愈 |
