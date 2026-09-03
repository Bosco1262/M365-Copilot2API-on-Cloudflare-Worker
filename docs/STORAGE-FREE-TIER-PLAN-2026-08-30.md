# 免费层资源优化计划（2026-08-30 全量修订版）

> 本文取代 `STORAGE-FREE-TIER-review-2026-08-28.md` 中的配额基线与实施计划两部分。
> 依据：① 2026-08-30 对 Cloudflare 官方 limits/pricing 页面的重新核对（各页面最后更新于 2026-04 ~ 2026-08）；
> ② `STORAGE-FREE-TIER-REVIEW-VERIFICATION-2026-08-30.md` 的逐条复核结论；
> ③ 当日已完成的两项 P0 代码修复（204/204 测试通过）。
> 所有行号以 2026-08-30 修复后的代码为准。

---

## 一、免费层配额基线（2026-08-30 官方核对）

### 1.1 Workers Free（per account / per invocation）

| 项目 | 数值 | 备注 |
|---|---|---|
| Requests | **100,000 / 天** | UTC 00:00 重置；超限返回 Error 1027 |
| CPU time | **10 ms / invocation** | 按"活跃 CPU"计，等待 I/O 不计 |
| 内存 | 128 MB | |
| 子请求（外部 fetch） | **50 / invocation** | "A subrequest is any request a Worker makes using the Fetch API **or to Cloudflare services like R2, KV, or D1**" |
| 子请求（内部服务） | **1,000 / invocation** | limits 页表格单列 "Subrequests to internal services: 1,000 (Free)"，按 2026-02 changelog 与表格口径，KV/D1/DO 等服务绑定调用归此类 |
| 同时等待响应头的连接 | 6 | |
| Cron Triggers | 5 / account | 单次 wall time 15 分钟 |
| `waitUntil()` | 响应后最多延长 **30 s** | 后台写必须在此窗口内完成 |

> **口径说明**：官方页面没有精确定义 "internal services"。保守起见，本计划按两类分别预算：外部 fetch（ChatHub 调用，~1-3 次/请求，对 50 上限）与 KV+D1+DO 调用（~25-45 次/请求，对 1,000 上限）。即使按最严格口径全部计入 50，现状也贴边——这也是 P0-1（消掉 50 次 blob 读）的额外理由。

### 1.2 Workers KV Free

| 项目 | 数值 | 备注 |
|---|---|---|
| Reads | **100,000 / 天** | |
| Writes（不同 key） | **1,000 / 天** | ← **本项目当前的绑定约束** |
| Deletes | **1,000 / 天** | cleanup cron 理论峰值 1,440/天会触及 |
| List | **1,000 / 天** | |
| 同 key 写入 | **1 次/秒**（免费/付费相同） | 单 key 高频写会被丢弃/末写胜出 |
| 存储 | 1 GB / account；value 25 MiB；key 512 B | |
| 超限行为 | "further operations of that type **will fail with an error**" | 未捕获的 KV 写异常 = 用户可见 500（见 P0 触发路径） |

### 1.3 D1 Free

| 项目 | 数值 |
|---|---|
| Rows read | **5,000,000 / 天** |
| Rows written | **100,000 / 天** |
| 存储 | 5 GB / account（合计）；**单库 500 MB**；**10 库 / account** |
| Queries / invocation | **50**（Free）/ 1000（Paid） |
| SQL 语句长度 | 100 KB；行/字符串/BLOB 2 MB；绑定参数 100；列 100 |
| 并发模型 | 单库单线程串行；1ms 查询 ≈ 1000 qps；过载排队后报 overloaded |
| 超限行为 | 当日读/写超限后 **所有查询报错** |

### 1.4 Durable Objects Free（仅 SQLite backend）

| 项目 | 数值 | 备注 |
|---|---|---|
| Requests | **100,000 / 天** | 含 HTTP、RPC session、WebSocket 消息（20:1 折算）、**alarm 调用** |
| Duration | **13,000 GB-s / 天** | 按 **128 MB 固定**计；"idle and eligible for hibernation are not billed for duration, even before the runtime has hibernated them" |
| SQLite rows read | **5,000,000 / 天** | KV 式 `get/put/list` 按行计费 |
| SQLite rows written | **100,000 / 天** | **每次 `setAlarm()` = 1 行写**；删除也计行 |
| SQL 存储 | **5 GB / account**；单对象 **1 GB（Free）** | KV 式键值：key+value 合计 ≤ 2 MB |
| 出站连接 | 有出站连接（`connect()`/出站 WS）的对象保持活跃并计费，"up to 15 minutes per connection" | |
| 常驻流 | "Durable Objects remain active while a request, RPC call, **response stream**, WebSocket, or pending I/O is in flight" | ← McpSessionDO 的 SSE 长连接持续计费的理论依据 |

### 1.5 与 08-28 文档基线的差异

| 项 | 08-28 文档 | 2026-08-30 核对 |
|---|---|---|
| DO 时长计费 | 隐含"常驻即计费" | 空闲可休眠对象**不计费**（CoordinationDO ≈ 0） |
| 内部服务子请求 | 未区分 | 外部 50 + 内部 1,000 两行分别列出 |
| KV 同 key 写入 | 未列 | 1 次/秒，`account-health` 单 key 每请求 2-3 写会撞上 |
| KV Deletes | 未列 | 1,000/天，cleanup 峰值可触及 |
| DO 单对象存储 | 未列 | Free 1 GB；KV 式键值 key+value ≤ 2 MB |
| D1 库数 | 未列 | 10 库/account（当前仅 1 个，余量充足） |
| DO storage 写计费 | 未列 | setAlarm=1 行写；KV 式方法按行计 |

---

## 二、当前资源分布全景

### 2.1 绑定与实例（wrangler.jsonc）

| 绑定 | 类型 | 实例化方式 |
|---|---|---|
| `m365-copilot2api_KV` | KV | 单 namespace，全部 KV 访问都走它 |
| `DB` | D1 | `m365-copilot2api` 库，migrations/0001-0004；**wrangler.dev.jsonc 缺此绑定**（P0-4） |
| `COORD` → `CoordinationDO` | DO（SQLite） | **单例** `idFromName("gateway-coord")`；整块 `storage.put(STATE_KEY, st)` |
| `MCP_HUB` → `McpSessionDO` | DO（SQLite） | 每 MCP session 一实例；纯内存 SSE 信箱，无存储 |
| Cron | `*/30 * * * *` | 每小时 2 次 cleanup + 清理任务 |

### 2.2 KV key 目录（全部走 `m365-copilot2api_KV`）

| Key / 前缀 | 写入点（路径） | 读取点 | 每请求次数（修复后稳态） |
|---|---|---|---|
| `settings` | 管理台 | getSettings（openai.ts 多处 + account.ts:136/440/497） | **读 5**（P0-3 后 ≈1） |
| `account-last-healthy` | rememberHealthy（account.ts:82，每次 resolveAccount 都写，TTL 12h） | lastHealthyAccountID（account.ts:92） | 写 1、读 1（P1-2 后写 ≈0.1） |
| `account-health` | no-DO fallback：markFailure/markImageLimited/markCall/updateThrottling/markSuccess | 同左 + 管理台 | **0**（DO 绑定后，今日修复生效） |
| `resolver/<sessionId>` | touch（resolver.ts:347，已节流 10 min + try/catch）、bindSession（:494/507，每轮必写） | getSession（resolve 候选 1-25 次） | 读 1-25、写 ~1.1 |
| `resolver-index` | no-D1 fallback / backfill | loadIndex fallback | 0（D1 绑定时） |
| `resolver-sessions` | 一次性 legacy 迁移源 | — | 0 |
| `conversations` | recordConversation RMW（conversations.ts:89-104，≤500 条单文档） | listConversations | **读 1 + 写 1**（P1-1 迁 D1） |
| `sessbind/<id>` | upsertSessionBinding（conversations.ts:49-51） | 管理台/恢复 | **写 1**（P1-1 迁 D1） |
| `sessions` | legacy 文档 | migrateLegacyBindings **每次 upsert/list 都读**（conversations.ts:26-39） | 读 1（P1-3 闩锁后 0） |
| 用户会话（extras.ts:95 `userSessionKey`） | putUserSession（recordFinalize，条件性） | 管理台 | 写 ~0.7（P1-1 迁 D1） |
| conv-cache 桶 key | putConvCache（openai.ts:927）/ getConvCache（prepareCore） | | 读 1 + 写 1 |
| `api-keys` 文档 | keys.ts 结构性变更镜像（create/revoke/delete） | validKey no-D1 fallback | 0（D1 绑定时） |
| accounts 镜像 | 仅登录时写（refreshToken 必然过期） | ensureValid fallback | 0 |
| debug 捕获 | index.ts:328（256 KB 截断） | 管理台 | 按需 |

### 2.3 D1 表目录（rows_read / rows_written 计费对象）

| 表 | 每请求写 | 每请求读 | 说明 |
|---|---|---|---|
| `api_keys` | ~0（lastUsedAt 节流 1/min/key） | **N+1**：validKey 先 `d1BackfillFromKV`→`d1List` 全表（keys.ts:258→95），再 `WHERE hash=?` 点查（:260） | P0-2 闩锁后 → 1 |
| `accounts` | ~0 | listAccounts 全表（account.ts:441，`ORDER BY rowid`） | N = 账号数，小 |
| `resolver_sessions` | bind upsert ~1（含索引行 2） | loadIndex ≤1000（resolver.ts:155-161）+ **d1TrimIndex `COUNT(*)` 全表每次 bind**（:197） | P1-4 后读大降 |
| `chat_messages` | 2 / 轮（user+assistant，chatMessages.ts:51-54） | 管理台 | |
| `usage_events` | 1（usage.ts:23） | 管理台 + 每日 prune（usage.ts:238） | |
| `cache_stats` + `cache_stats_meta` | 2（cacheStats.ts:83-90） | 管理台 | |
| `debug_records` | 按需 | 管理台 + 7 天清理（index.ts:475） | |

### 2.4 DO 实例

| 实例 | 存储 | 行为 | 计费影响 |
|---|---|---|---|
| `CoordinationDO`（单例） | 整块 `storage.put(STATE_KEY)`（coordination.ts:149/164） | /acquire 自旋最多 15 s；save() 已条件化 setAlarm（:150 `if (next !== null)`） | 空闲可休眠 → **时长 ≈ 0**；每请求 5-9 次 DO request + 每次 action 全量 RMW 1-2 行 |
| `McpSessionDO`（每会话） | 无存储 | `ReadableStream` SSE 信箱（mcp-hub.ts:22-35），非 WebSocket | **SSE 连接期间持续计费**：1 条 24h 常驻连接 ≈ 0.128 GB × 86,400 s ≈ **11,060 GB-s ≈ 免费时长配额的 85%** |

### 2.5 每请求预算与天花板（DB + COORD 绑定、单轮、修复后稳态）

| 资源 | 每请求消耗（区间/均值） | 免费配额 | 天花板 ≈ 配额÷均值 | 是否绑定 |
|---|---|---|---|---|
| KV writes | **5.1**（bind 1 + conversations 1 + sessbind 1 + convCache 1 + lastHealthy 1 + userSession 0.7 + touch 0.1…，按条件重叠取 ~5） | 1,000/天 | **≈ 195 / 天** | ★ **绑定约束** |
| KV reads | 10-34（settings 5 + lastHealthy 1 + 会话 blob 1-25 + convCache 1 + legacy 1 + conversations 1） | 100,000/天 | ≈ 5k-9k / 天 | 否 |
| KV deletes | cleanup 峰值 30×~2×48 ≈ 2,880 → 实际受陈旧会话数限制 | 1,000/天 | 激进清理时可触及 | 边缘 |
| D1 rows read | 1.2k-2.1k（index ≤1000 + trim COUNT ≤1000 + keys N+1 + accounts N） | 5M/天 | ≈ 2.4k-4k / 天 | 次级绑定 |
| D1 rows written | ~6（chat_messages 2 + cache 2 + usage 1 + bind ~1.2） | 100,000/天 | ≈ 16k / 天 | 否 |
| D1 queries | ~13（Free 上限 50/invocation，waitUntil 计入同一 invocation） | 50 | 余量 3.8× | 注意但安全 |
| DO requests | 5-9（available/semaphore/nextHealthy/acquire/markCall/updateThrottling/markSuccess） | 100,000/天 | ≈ 12k / 天 | 否 |
| DO duration | CoordinationDO ≈ 0；**McpSessionDO = 连接秒数 × 0.128 GB-s**；/acquire 满自旋最坏 1.9 GB-s/请求 | 13,000 GB-s/天 | 1 条常驻 SSE ≈ 85%；满自旋场景 ≈ 6.8k/天 | **MCP 场景绑定** |
| 外部 fetch | 1-3 | 50/invocation | 安全 | 否 |
| 内部服务子请求 | 25-45 | 1,000/invocation | 安全 | 否 |
| Workers requests | 1 | 100,000/天 | — | 否 |

**绑定链**：`KV writes（~195/天）→ D1 rows read（~2.4k/天）→ DO requests（~12k/天）→ Workers requests（100k/天）`。
基线演进（同日全部落地）：修复前 KV 写 ≈ 8.1/请求 → **≈ 123/天**；P0 修复后 ≈ 5.1 → **≈ 195/天**；Phase 1 后 ≈ 4.1 → **≈ 245/天**；Phase 2 后 ≈ 1.2 → **≈ 870/天**；Phase 3（blob 迁 D1）后 ≈ 0.2 → **KV 写退出绑定链**，新约束 = D1 rows read（≈ 2.4k/天，loadIndex ≤1000 行 × 2/请求）→ DO requests（≈ 12k/天）。

---

## 三、今日已完成修复（2026-08-30，204/204 测试通过）

| # | 修复 | 文件 | 内容 | 收益 |
|---|---|---|---|---|
| 1 | markCall / updateThrottling 早退 | `src/do/coordination.ts:683-699`、`src/pipeline/account.ts:226-243` | `coordHealthMarkCall`/`coordHealthUpdateThrottling` 改为返回 `boolean \| null`（原来返回 void 丢弃 DO 应答）；两个调用方按 markFailure/markSuccess 同款契约 `if (ok) return`，DO 绑定时不再做 KV RMW | 每请求 **−2 KV 读 −2 KV 写**（多轮工具调用按轮放大）；消除 `account-health` 单 key 1 写/秒限流风险 |
| 2 | resolver touch 写节流 + 失败隔离 | `src/pipeline/resolver.ts`（`SESSION_TOUCH_THROTTLE_MS`、`ResolverSession.lastWriteAt`、touch 重写、bindSession/applyTo 刷新 lastWriteAt） | blob 重写节流至 ≥10 min（TTL 2h 安全），包 try/catch 降级为 warn；bindSession 每轮刷新 lastWriteAt | 关键路径 KV 写 1 → ~0.1；**消除"KV 配额超限 → 用户 500"的唯一触发路径** |

---

## 四、修正后的问题清单与优先级

> 相比 08-28 文档：删除 P1.2（CoordinationDO 时长——休眠不计费，已证伪）、删除 P1.4（空操作）、改写 P0.2（waitUntil 迁移已基本落地，改为"后台写收敛"）、新增 P0-1/P0-2 与 McpSessionDO 时长风险。

### P0（本周，小改动、纯收益）

| # | 问题 | 位置 | 修复方案 | 收益 |
|---|---|---|---|---|
| P0-1 | 取 `activeSessions` 计数竟全量读 ≤50 个 session blob；cleanup 的 `activeConversationSet` 同样受害 | `openai.ts:967`、`cleanup.ts:52` | 新增 `countResolverSessions(env)`（loadIndex+evictIndex 后取 length）与 `listResolverIndex(env)`（只返回 IndexEntry，不读 blob——IndexEntry 已含 conversationId/lastUsedAt，cleanup 够用）；两处替换 | 每请求/每 cron 轮 **−1~-50 KV 读**；内部子请求余量扩大 |
| P0-2 | 每次鉴权都跑 `d1BackfillFromKV`→`d1List` 全表扫（判断表是否为空） | `keys.ts:256-258→91-102` | 模块级一次性闩锁 `kvBackfilled`（隔离内记忆，首次成功后跳过） | 每请求 **−N rows_read**（N=密钥数） |
| P0-3 | getSettings 无记忆化，每请求 5 次 KV 读 | `store/settings.ts` | 隔离内 30 s 缓存 `{value, expiresAt}`；管理台写入后主动失效本隔离 | **−4 KV 读/请求**（≈ 33% 读配额） |
| P0-4 | wrangler.dev.jsonc 无 D1 绑定，本地/dev 走 KV fallback 分支，与生产行为分叉 | `wrangler.dev.jsonc` | 补 `d1_databases` 绑定 + `wrangler d1 migrations apply` 说明 | 测试/本地路径与生产一致 |

### P1（下周，结构性降耗）

| # | 问题 | 位置 | 修复方案 | 收益 |
|---|---|---|---|---|
| P1-1 | 后台 KV 写 ~5/请求是绑定约束 | conversations.ts、extras.ts、convCache.ts | `conversations` 索引、`sessbind/<id>`、用户会话、conv-cache 迁 D1（迁移 0005，KV 保留为 fallback 与一次性 backfill，仿 keys/resolver 既有模式） | KV 写 5.1 → **≈ 2**，天花板 195 → **≈ 500/天** |
| P1-2 | rememberHealthy 每次 resolveAccount 都写（TTL 12h 但内容只在账号变化时才有意义） | `account.ts:82-90/453/478/490` | 隔离内记上次账号，变化才写（失败重置可重试） | KV 写 −0.95/请求（叠加 P1-1 后天花板 ≈ 870/天） |
| P1-3 | migrateLegacyBindings 每次 upsert/list 都读 legacy 文档（迁移早已完成仍每次读） | `conversations.ts:26-39/51/67` | 模块级闩锁 | −1 KV 读/请求 |
| P1-4 | d1TrimIndex 每次 bind 都 `COUNT(*)` 全表 | `resolver.ts:194-209` | 每 100 次 bind 跑一次（模块计数器），或改用 loadIndex 已 LIMIT 的结果估算 | rows_read −≤1000/请求 |
| P1-5 | recordFinalize 各步骤无独立隔离，一步 throw 跳过其余全部（今日 touch 修复只覆盖了 resolve 侧） | `openai.ts`（recordFinalize 函数体） | 每步独立 try/catch + warn（转录/绑定/统计互不拖累） | 后台可靠性 |
| P1-6 | cleanup 删除预算 30/轮 × 48 轮/天 = 峰值 1,440 > KV deletes 1,000/天 | `cleanup.ts:82` | 预算降为 20/轮；或 cron 内记账当日删除数 | KV deletes 不再触顶 |

### P2（按需，收益大但工程量大）

| # | 问题 | 位置 | 修复方案 | 收益 |
|---|---|---|---|---|
| P2-1 | McpSessionDO 用 `ReadableStream` SSE 保持对象活跃，1 条 24h 连接吃 85% 时长配额；"改 Hibernation"需先做 SSE→WS 协议改造 | `mcp-hub.ts` | `/attach` 改 WebSocket + `accept()` + Hibernation API；`/push` 改 WS 消息路由（或 Worker 层保留 SSE 面向客户端、内部转 WS） | 时长配额从"连接数×全天"降到"消息处理毫秒级"；MCP 常驻场景解锁 |
| P2-2 | CoordinationDO 整块 `storage.put(STATE_KEY)`：每次 action 全量 RMW；KV 式键值 key+value ≤ 2 MB，账号/会话增长后可能触顶 | `coordination.ts:149/164` | 状态拆 SQLite 表（health/semaphore/cursor 分行），action 只读写相关行 | 行级写；消除 2 MB 上限风险 |
| P2-3 | /acquire 最多自旋 15 s（期间 DO 活跃计费 1.9 GB-s；DO request 最多 15 次/请求） | `coordination.ts` | alarm/事件驱动唤醒替代轮询 | 最坏情形时长 −92% |
| P2-4 | accounts KV 镜像只在登录时写，refreshToken 必然过期，fallback 不可用还占存储 | `store/accounts.ts` | 移除镜像或改为"仅结构信息" | 一致性/存储 |

### P3（已证伪 / 观察项）

- ~~CoordinationDO 常驻 24h 吃 83% 时长配额~~：空闲可休眠不计费，实测预期 Duration ≈ 0（见 §六观测项 ②）。
- CPU 10 ms：流式响应逐 chunk JSON 处理（`index.ts:328`，已被 256 KB 截断钉住为"每 chunk 重建 256 KB 字符串"）暂无实测数据，列为观察项。

---

## 五、分阶段实施

### Phase 0 —— 已完成（2026-08-30）
见 §三。回归：`npx tsc --noEmit` + `npx vitest run` 204/204 通过。

### Phase 1 —— 已完成（2026-08-30，与 Phase 0 同日落地）

| 项 | 文件 | 落地改动 |
|---|---|---|
| P0-1 | `resolver.ts` / `openai.ts:967` / `cleanup.ts:52` | 新增并导出 `countResolverSessions()`（索引计数，零 blob 读）与 `listResolverIndex()`（仅 IndexEntry，含 conversationId/lastUsedAt，cleanup 够用）；`export interface IndexEntry`；两处调用点替换；补 1 个单测（含"索引条目不得携带 contextHistory"断言） |
| P0-2 | `keys.ts` | `d1BackfillFromKV` 隔离内闩锁：表非空或完成回填后置位；D1 不可用或两侧皆空时继续探测（0 行读），不破坏首次迁移语义 |
| P0-3 | `settings.ts` | `getSettings` 30 s 隔离内缓存，**以 KV namespace 对象为 WeakMap key**（测试各自构建 env，天然隔离）；`saveSettings` 写后即时失效；跨 isolate 陈旧上限 30 s |
| P0-4 | `wrangler.dev.jsonc` | 补 `DB` D1 绑定（`local-dev-d1`），附 `--local` 迁移命令说明，本地与生产走同一代码路径 |
| P1-2 | `account.ts` | `rememberHealthy` 记录上次账号，变化才写；写失败重置 tracker 下次重试；12 h TTL 过期后偏好退化为轮询（设计上可接受，注释已写明） |
| P1-3 | `conversations.ts` | `migrateLegacyBindings` 闩锁（确认 absent 即置位）；`getSessionBinding` 的 legacy 兜底读保留 |
| P1-4 | `resolver.ts` | `d1TrimIndex` 每 100 次 bind 执行一次（上限已由 loadIndex 的 LIMIT 兜底） |
| P1-5 | `openai.ts` `recordFinalize` | `step()` 分段隔离七步：bindSession / recordConversation / transcript / convCache / sessionBinding / userSession / usageStats——单步失败只 warn，不再连带丢弃后续（原 transcript 已有独立 catch，其余六步为新增） |
| P1-6 | `cleanup.ts:82` | 删除预算 30 → 20，注释写明级联账：每次云删除伴随 1-3 次本地 KV 删除 × 48 轮/天 |

回归：`npx tsc --noEmit` + `npx vitest run`（205 用例）+ `npm run check`（i18n）。

效果核对（对照 §2.5）：KV 读/请求 10-34 → **5-8**（settings 5→1、计数 blob 50→0、legacy 探测 1→0）；D1 rows read 去掉 keys 全表扫与 trim COUNT 两个大头；KV 写 ≈ 5.1 → **≈ 4.1/请求**（大头要等 Phase 2 迁 D1）。

### Phase 2 —— 已完成（2026-08-30，与 Phase 1 同日落地）

| 项 | 文件 | 落地改动 |
|---|---|---|
| 迁移 | `migrations/0005_background_writes_d1.sql` | 新建 `conversations` / `session_bindings` / `user_sessions` / `conv_cache` 四表 + 常用索引；无 KV 式 TTL（项目模式，见 0004 注释）：新鲜度在读侧过滤，陈旧行走"节流修剪" |
| conversations | `store/conversations.ts` | recordConversation → D1 UPSERT（保留"title 非空才覆盖"语义）+ 每 50 次写节流修剪（cap 500）；listConversations → D1 `ORDER BY updated_at DESC LIMIT 500`，表空时从 KV doc 一次性回填；deleteLocalConversation → D1 DELETE。热路径零 KV 写 |
| session bindings | `store/conversations.ts` | upsert/删除/点读/列表 D1 优先；表空时从 `sessbind/*` 键一次性回填；getSessionBinding 在 D1 miss 时回退 KV 点读（兼容迁移前数据）；legacy 迁移及其闩锁保留 |
| user sessions | `admin/extras.ts` | putUserSession → D1 UPSERT（PK `api_key_hash + user_id`）+ 每 100 次写节流修剪（7 天）；getUserSession → D1 点读带 TTL 判断，miss 回退 KV；activeUserConversations（cron）→ 单条 DISTINCT 查询，不再逐键枚举 |
| conv cache | `store/convCache.ts` | put/get D1 优先；**读侧 2h 新鲜度检查（KV TTL 等价）**；每 100 次写节流修剪；D1 miss 回退 KV 读（兼容迁移前条目） |
| 测试 | `test/background-stores-d1.test.ts` | 6 例：conversations D1 写入与空 title 不覆盖、一次性回填、bindings 列表/删除与 KV 回退读、user sessions TTL、conv cache TTL 与"零 KV 写"断言 |

回归：`npx tsc --noEmit` + `npx vitest run`（24 文件 / **211 用例**）+ `npm run check` 全绿。

效果（对照 §2.5）：后台 KV 写 4 → **0**；每请求 KV 写 ≈ 4.1 → **≈ 1.2**（bind 1 + touch ~0.1 + lastHealthy ~0.05），天花板 ≈ 245 → **≈ 870/天**。KV 读 −4/req（由 D1 点查替代；D1 rows read +~3/req，距 5M/天仍然两个数量级余量）。

上线与回滚：`npx wrangler d1 migrations apply m365-copilot2api --remote` 后生效；conversations 与 bindings 在首次读取时惰性回填（控制台/cleanup 触发），user sessions 与 conv cache 无需回填（KV 回退读兼容）。回滚（去掉 DB 绑定）自动回到 KV 路径，届时数据为"迁移前最后状态 + 逐步老化重回"，会话与缓存类数据在 2h~7d 内自愈。

### Phase 3 —— 部分完成（2026-08-30）

已落地：

| 项 | 文件 | 落地改动 |
|---|---|---|
| P2-4 镜像清理 | `store/accounts.ts` | `mirrorToKV` 写入前剥离 refreshToken/accessToken——单用 refresh token 在 D1 侧刷新后即作废，回滚时误兑会**永久杀死账号**（文件头注释自明的风险）；镜像降级为纯结构清单（id/email/flags）。KV-only 部署不受影响（走 saveDoc 全量写） |
| Resolver blob 迁 D1（原"暂未列入"可选项） | `migrations/0006_resolver_blobs_d1.sql` + `pipeline/resolver.ts` | getSession/putSession/deleteSession D1 优先；**>1.5M 字符的超大 blob 留 KV**（D1 行上限 2 MB，CJK 极端情形由插入失败兜底回退）；读侧 2h 新鲜度（KV TTL 等价）；每 100 次写节流修剪；**candidates 匹配与控制台列表改为单条 IN 批量查询**——点查循环会撞 D1 免费 50 查询/invocation 上限；KV 保留为 no-D1 兜底与 D1 miss 回退（迁移前数据兼容） |

回归：0001–0006 全部本地应用成功（SQL 语法验证）；`npx tsc --noEmit` + `npx vitest run`（24 文件 / **215 用例**）+ `npm run check` 全绿。

效果：每请求 KV 写 ≈ 1.2 → **≈ 0.2**（仅剩 lastHealthy 变化时写入 + 超大 blob 兜底），**KV 写彻底退出绑定链**。新天花板由 D1 rows read（≈ 2.4k/天）与 DO requests（≈ 12k/天）决定——按当前消耗结构，免费层实际可承载 **≈ 2,400+ 请求/天**（较最初 ≈ 123/天提升约 20 倍）。

剩余（触发条件未满足，保持观察）：
- **P2-1 SSE→WS**：触发条件 = 实际使用 MCP 且面板 Duration 日用量 > 3,000 GB-s。工程量：mcp-hub 协议改造 + MCP 客户端验证（1-2 天）。
- **P2-2 DO 状态拆表**：触发条件 = 单 state blob > 1 MB 或账号数 > 100。
- **P2-3 /acquire 去自旋**：触发条件 = 面板 Duration 出现与请求量成比例的基数（非 0）。

---

## 六、验证与观测清单

> **2026-08-30 冒烟测试已通过**：`wrangler dev`（全部 5 个绑定就位，含本地 DB）实测 —— `GET /` 200（控制台）；`GET /v1/models` 无凭证/伪造密钥均 401（**伪造密钥真实走 D1 点查 + KV 兜底**，236ms 含本地库预热）；`POST /v1/chat/completions` 401；`/cdn-cgi/local/scheduled` 手动触发 cron 200 且优雅跳过（无账号）；服务日志零运行时错误。本地 D1 确认 13 张业务表齐全（0001–0006 全部生效）。注意：本机代理环境变量会劫持 localhost 请求，curl 需加 `--noproxy '*'`。

| # | 观测项 | 方法 | 预期（修复后） |
|---|---|---|---|
| ① | KV writes 日用量 ≈ 1.1 × 请求数（P1 前 ≈ 5×） | Dashboard → Workers KV → Metrics | Phase 1 后斜率明显下降 |
| ② | CoordinationDO Duration ≈ 0 | Dashboard → Workers → Durable Objects → Metrics | 验证"休眠不计费"（08-28 文档 #2 证伪的实测确认） |
| ③ | McpSessionDO Duration = 连接秒数 × 0.128 GB-s | 同上 | 若启用 MCP：单连接 ≈ 11,060 GB-s/24h，触碰 13,000 上限前必须做 P2-1 |
| ④ | `account-health` 写次数 ≈ 0（DO 绑定时） | `wrangler tail` 过滤 `account-health` / KV 写审计 | 今日修复 #1 的验证 |
| ⑤ | D1 Row Metrics：rows_read/请求 | Dashboard → D1 → Metrics → Row Metrics | P0-2/P1-4 后每请求 read 下降一个数量级 |
| ⑥ | 用户侧 5xx 中 "KV 配额" 类错误 = 0 | `wrangler tail` + 错误分类 | 今日修复 #2 的验证（touch 不再冒泡） |
| ⑦ | cron 轮 KV deletes | KV Metrics | P1-6 后 < 1,000/天 |
| ⑧ | 压测天花板 | 以 10 req/min 持续 1 天（真实负载） | 日请求数逼近 900（Phase 2 后）时才应见到 KV 写失败 |

---

## 七、08-28 文档勘误对照（详见 VERIFICATION-2026-08-30）

| 08-28 结论 | 判定 | 处理 |
|---|---|---|
| #1 KV 写入是绑定约束 | ✔ 成立 | 本计划 §2.5 量化为 123 → 195 → ~900/天 |
| #2 单例 DO 常驻吃 83% 时长 | ✘ 不成立（休眠不计费） | 真实风险移交给 McpSessionDO（P2-1） |
| #3 D1 免费单库 500 MB | ✔ 成立 | §1.3 |
| "迁 waitUntil"（P0-2 原文） | 大部分已落地 | 改写为 P1-1"后台写收敛" |
| save() 无条件 setAlarm | ✘ 不成立（:150 已条件化） | 删除 |
| "普遍 500" | ✘ 不成立（waitUntil 不冒泡） | 收窄为 resolver touch 一处，今日已修 |
| markCall/updateThrottling 无早退（文档遗漏） | ✔ 新发现 | 今日已修 |
| 204 测试（文档写 194） | 已过时 | 实测 204/204 |
