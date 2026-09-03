# C 部分「存储与状态」逐项对齐核对报告

> 核对日期：2026-08-27
> 对照清单：docs/ALIGNMENT-CHECKLIST-non-model.md C 部分（C1–C6）
> 上游仓库：C:\Github Desktop\M365-Copilot2API-main（Go）
> Worker 仓库：C:\Github Desktop\M365-Copilot2API-on-Cloudflare-Worker（TS）
> 方法：逐项读取两端源码（上游 `internal/web/persist.go`、`atomicfile.go`、`usage.go`、`usage_http.go`、`debug.go`、`settings.go`、`keys.go`、`cache_stats.go`、`sessions.go`、`conversation_manager.go`、`conversation_cache.go`、`internal/auth/cache.go`；Worker `src/kv.ts`、`src/store/*`、`src/pipeline/account.ts`、`src/pipeline/resolver.ts`、`src/do/coordination.ts`、`src/admin/extras.ts`、`src/admin/handlers.ts`、`src/index.ts`、`migrations/*.sql`、`wrangler.jsonc`），核对清单声明的状态与检测要点是否与真实代码一致。
> 状态图例：✅ 对齐｜⚠️ 部分/简化｜❌ 未做｜[平台] Workers 限制｜[用户选择] 有意保留｜[死代码] 上游未使用

> **实施记录（同日追加）**：按本报告完成两项落地（2026-08-27，待 typecheck/vitest 回归）：
> - **默认映射表 tone 大小写**：`DEFAULT_MODEL_MAPPINGS` 中 gpt-image-2 的 `upstreamTone` 由 `magic` 改为 `Magic`，`KNOWN_UPSTREAM_TONES` 同步（对齐上游 `codex_catalog.go:87` 白名单与 `chathub/client.go:164` 的 `defaultTone = "Magic"`）。
> - **全库 tone 统一（2026-08-28 追加）**：用户确认官方 tone 即为 `Magic`，将剩余小写 `magic` 全部同步为大写——`images.ts:195`（图片生成）、`openai.ts:817`（限流探测）、`openai.ts:1069/1071`（empty 兜底判断+重试，原判断对 gpt-image-2 的 Magic 映射已失效）、`catalog.ts:55`（modelTone 死代码）；测试断言（chathub/pipeline）同步，`dist/` 需重新构建。**超前于上游**：上游 web 层（`images.go:104`、`server.go:115/1164/2467-2471`）仍为小写。
> - **C3 D1 usage 清理修复**：`src/store/usage.ts` 新增 `cleanupOld(env, days=90)`（DELETE `usage_events` 中 `ts < now-90d`），挂载到 `src/index.ts` 的 `*/30` cron（debug-records 清理之后）；未绑 D1 时为空操作（KV 日桶靠 90 天 TTL 自过期）。清单 C3 待修项闭环，L 部分同步更新。
>
> **复核更新（2026-09-03）**：用户落地「Storage Free-Tier 优化」系列（见 `docs/STORAGE-FREE-TIER-EXECUTION-STATUS-2026-08-31.md`，含 2026-08-30 复核与计划），本报告已按最新代码逐项复核并更新：
> - **migrations 扩至 0001-0006**（新增 0005 `conversations`/`session_bindings`/`user_sessions`/`conv_cache`、0006 `resolver_session_blobs`），本地 0001-0006 应用验证通过；
> - **D1 优先范围扩大**：conversations 索引、session-key bindings、user sessions、conv cache、resolver blobs 全部 D1 优先（KV 降级为 no-D1 兜底 + 一次性懒回填 + D1-miss 回退），**每请求 KV 写 8.1 → ≈0.2**，KV 写退出绑定链；
> - **新增存储性能机制层**（settings 30s 缓存、回填闩锁、touch/trim 节流、recordFinalize 分段隔离、accounts 镜像去 token 等，见「存储性能机制」小节）；
> - 验证：`tsc --noEmit` 通过；vitest **23 文件 / 217 用例全绿**（含新增 `test/background-stores-d1.test.ts`）。

---

## 汇总（实施后）

| # | 功能点 | 清单原状态 | 实施后状态 | 关键差异 |
|---|--------|-----------|-----------|---------|
| C1 | 数据持久化 | ⚠️ [平台] | ⚠️ [平台]（09-03 复核更新） | D1 行优先范围扩至 0001-0006 全部业务存储；KV 降级为兜底+回填+回退；**每请求 KV 写 8.1 → ≈0.2，KV 写退出绑定链** |
| C2 | 敏感数据 | [用户选择] | [用户选择]（补镜像去 token） | 上游 AES-GCM+0600，Worker 明文（D1 表）；KV 文档镜像已剥离 token（纯结构清单） |
| C3 | 用量统计 | ⚠️ [简化] | ⚠️ [简化]（已修） | D1 分支补 cron TTL 清理，对齐上游 5 万条滚动语义 |
| C4 | 调试日志 | ⚠️ [简化] | ⚠️ [简化]（清单修正） | KV TTL 实为 48h（原 24h 误标）；D1 分支 7 天保留 |
| C5 | D1 可选绑定 | 🟦 新增 | 🟦 新增（扩至 0001-0006） | 新增 0005 四张后台存储表 + 0006 resolver blob 表；13 张业务表齐全 |
| C6 | DO 协调 | ✅ | ✅（补 markCall/throttling 早退） | DO 应答契约补齐（`{ok}` 不再丢弃）；Phase 3 观察项（Hibernation/拆表/去自旋）触发未满足，刻意不做 |

**结论：C 部分 6 项无 ❌ 项。C6 完全对齐；C1/C3/C4 为 [平台]/[简化] 合理裁剪（C3 清理缺口已修、C4 TTL 误标已修正）；C2 为用户确认选择（且 KV 镜像已不含 token，敏感面进一步收窄）；C5 新增能力扩至 6 个迁移。free-tier 优化后，KV 写不再是绑定配额瓶颈（约束转移至 D1 rows read / DO requests）。**

---

## C1 数据持久化 — ⚠️ [平台]（检测要点已更新：D1 行优先架构）

**上游**：
- `persist.go` `persistStore`：内存变更仅标记 dirty，后台循环（`persistLoop`）每 5s `FlushAllPersist()` 合并写盘；间隔可用 `M365_PERSIST_INTERVAL` 调整（≥100ms）；`flushPending` 失败回置 dirty 下次重试；`StopPersistLoop` 供优雅停机。
- `atomicfile.go` `writeFileAtomic`：`MkdirAll(0700)` → 清理 stale tmp → `CreateTemp` → `Chmod(perm)` → 写 → `Sync()` → close → `Rename` → `fsyncDir`；调用方普遍传 `0600`。
- 各 store 均为 JSON 文件 + persistStore：`api-keys.json`（keys.go）、`accounts.json`（auth/cache.go）、`settings.json`（settings.go）、`sessions.json` / `user-sessions.json`（sessions.go）、`conversations.json`（conversation_manager.go）、`cache-stats.json`（cache_stats.go）、`usage.jsonl`（usage.go）。

**Worker**：
- `src/kv.ts`：`getJSON` / `putJSON`（TTL 下限 60s）/ `listPrefix`；KV 即时写，无"落盘循环"概念。
- **D1 行优先（2026-08-27 storage audit 起，2026-08-30/31 free-tier 优化扩大）**：D1 绑定时全部业务存储迁 D1 行——
  - 0001：`usage_events` / `debug_records`；
  - 0002：`chat_messages`；
  - 0003：`api_keys` / `accounts` / `cache_stats`（+`cache_stats_meta`）；
  - 0004：`resolver_sessions`（索引）；
  - **0005（free-tier Phase 2）**：`conversations` / `session_bindings` / `user_sessions` / `conv_cache`——后台 KV 写迁 D1；
  - **0006（free-tier Phase 3）**：`resolver_session_blobs`——每会话 blob（contextHistory ≤512 条）迁 D1。
- KV 文档降级为三种角色：
  - **no-D1 兜底**：未绑 D1 时走原 KV 路径（全量兼容）；
  - **一次性懒回填**：首次读时 KV → D1（keys/accounts/conversations/bindings 均带模块级**闩锁**，避免每次全表扫探测）；
  - **D1-miss 回退**：D1 点查 miss 时回读 KV（迁移前数据兼容）；部分存储保留回退读（如 `getSessionBinding`）。
- **KV 写退出热路径**：后台五项写（bindSession/recordConversation/convCache/sessionBinding/userSession）+ resolver blob + markCall/updateThrottling 全部不再产生每请求 KV 写；剩余 KV 写仅 `lastHealthy` **账号变化时**写入 + >1.5M 字符超大 blob 兜底，**每请求 ≈0.2 次**（此前 ≈8.1）。
- 指标：免费层 KV 写（1,000/天）不再是绑定约束——承载上限从 ≈123 请求/天提升至 **≈2,400+/天**（新约束：D1 rows read 5M/天 → DO requests 100k/天）。

**差异**：
1. 落盘循环 → 即时写：[平台] 合理（KV 无文件系统）；D1 行写更接近上游"原子写盘"语义（行级 UPDATE 带乐观锁，见 C5）。
2. KV 镜像进一步弱化：`accounts.ts` `mirrorToKV` **写入前剥离 refreshToken/accessToken**（镜像降级为纯结构清单——单用 refresh token 在 D1 侧刷新后即作废，回滚误兑会永久杀死账号，见 C2）；`conversations`/`session_bindings` 热路径**不再写镜像**（fallback 副本停留迁移前状态，靠条目自然老化自愈）。
3. 上游全部进程内存态 + 周期落盘；Worker 每次读均经 KV/D1（多一跳 RTT），由 DO 账号缓存（C6 `/accounts-cache`）与 settings 30s 隔离内缓存（见「存储性能机制」）缓解。

---

## C2 敏感数据 — [用户选择]（与 A12 一致，非待办）

**上游**：`internal/auth/cache.go`：
- `encryptRefreshToken`：AES-GCM，密钥由 `M365_MASTER_KEY` + pepper HMAC-SHA256 派生；未设置时使用内置公共 fallback key 并打 WARNING（`cache.go:93`）；
- 落盘 `accounts.json` 权限 0600（`writeFileAtomic`）；解密失败时保留原文、刷新报错（`cache.go:247`）。

**Worker**：`src/store/accounts.ts`：access/refresh token **明文**存 D1 `accounts` 表（0003）或 KV 文档（未绑 D1 时）；无加密层，依赖 KV/D1 平台边界安全。
**free-tier 优化追加（2026-08-30）**：`mirrorToKV` 写入前**剥离 refreshToken/accessToken**——KV 镜像降级为纯结构清单（id/email/flags），KV-only 部署不受影响（走 `saveDoc` 全量写）。这消除了"回滚到 KV 路径后误兑已作废单用 refresh token → 永久杀死账号"的隐患；D1 侧 token 仍明文，用户选择不变。

**结论**：清单 A12/K2 已确认 [用户选择]，本次复核确认敏感面收窄（KV 镜像不再含 token），状态不变。

---

## C3 用量统计 — ⚠️ [简化]（本次修复 D1 清理缺口）

**上游** `usage.go` + `usage_http.go`：
- `usageLog`：内存 `records`（滚动 `maxUsageRecords=50000`）+ `pending` 批量追加 + `persistStore`；`flush` 以 0600 append 写 `usage.jsonl` 并 `Sync()`，失败把 pending 放回队首；
- `record`：追加 + trim + pending + markDirty；
- `snapshot(days)`：窗口过滤后聚合 `summary`（requests/tokens/input/output/cache/avg_ms/today_*/last24h_*）+ `models`/`endpoints`/`keys`（按 tokens 降序）/`trend`（按日期升序）；
- `logs(limit, offset)`：倒序分页，返回 `{logs, total}`；
- HTTP：`GET /api/usage?days=`（1–365，默认 7）、`GET /api/usage/logs?limit=&offset=`（limit ≤2000，默认 50）。

**Worker** `src/store/usage.ts`：
- `recordUsage`：D1 绑定时 INSERT `usage_events`（ts/api_key_prefix/model/json），失败回退 KV 日桶 `usage/<yyyyMMdd>`（90 天 TTL、单桶 `MAX_PER_BUCKET=5000` 滚动、并发 append 偶发丢一条可接受）；
- `usageSnapshot`：聚合结构逐字段对齐上游（UTC 日界 vs 上游本地时区日界，差异轻微）；
- `usageLogs`：D1 分支 SQL 下推 `ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?` + `COUNT(*)`（P2-2）；KV 分支 `loadWindowKV(90)` 后 JS 切片；
- **本次新增 `cleanupOld(days=90)`**：D1 分支 DELETE 90 天前记录，挂 `*/30` cron（index.ts scheduled）；KV 分支无操作（TTL 自过期）。

**差异**：
1. **D1 分支此前无 TTL/滚动清理**（0001 迁移的 DELETE 仅 apply 时执行一次）→ 本次已修，与上游 5 万条滚动上限语义对齐（时间窗替代条数窗）。
2. KV 分支 `total` = 90 天窗口（≤30 桶 × 5000 条），上游 `total` = 内存全部 5 万条；面板读桶上限 30（Free 计划 subrequest 预算）——[简化] 已注明。
3. 聚合口径（summary/models/endpoints/keys/trend）与上游一致；`avg_ms` 整除语义一致。

---

## C4 调试日志 — ⚠️ [简化]（清单 TTL 误标已修正：48h）

**上游** `debug.go`：
- `debugStore`：内存 `records` 500 条滚动 + 每次 `add` 同步 append 到 `debug-logs.jsonl`（0600，文件无限滚动）；
- 捕获上限 `maxDebugCaptureBytes = 256KiB`（`limitedBuffer` 截断标记）+ 请求体上限 `maxDebugRequestBytes = 10MiB`；
- `redactBody/redactValue`：敏感键表（api_key/token/authorization/password 等 20+ 键，大小写不敏感、嵌套递归）；
- `debugLevel` 由 status 派生（≥500 error / ≥400 warn / 其余 info），`add` 按 `LogLevel` 过滤（silent 或高于 debug 不记录）；
- `debugMiddleware` 仅 `/v1/` 前缀且 `LogLevel <= debug` 时捕获，请求/响应体均 redact 后入库；
- `list()` 倒序、`get(id)` 精确查找；HTTP：`/api/admin/debug/logs`、`/api/admin/debug/detail?id=`。

**Worker** `src/admin/extras.ts` + `src/index.ts`：
- `captureDebugRecord`：D1 绑定时 INSERT `debug_records`（0001），回退 KV 环形——独立键 `dbg:<id>`（`DEBUG_TTL_SECONDS = 48h`）+ `dbg:index` 索引（`DEBUG_MAX_RECORDS = 500` 超限物理删除）；
- 捕获条件 `rank[logLevel] > 0 → 跳过`（仅 `debug` 等级），与上游 `debugLevelRank(logLevel) > debugLevelRank("debug")` 一致；
- 敏感键表 `REDACTED_KEYS` 与上游逐项一致；`levelFor(status)` 派生同上游；字段 `tokenSource: "unavailable_from_chathub"` / `cacheSource: "not_reported_by_upstream"` 与上游占位一致；
- 捕获点在 `index.ts` fetch 尾部（`/v1/` 路径，waitUntil 异步）；SSE 流经 `createStreamTap`（256KiB tee 聚合）补录 responseBody，完成/中止后结算；
- D1 分支保留 7 天：`*/30` cron `DELETE FROM debug_records WHERE at < now-7d`（0001 迁移的 DELETE 仅 apply 时执行，运行期靠 cron）。

**差异**：
1. **KV TTL 实为 48h**（`DEBUG_TTL_SECONDS = 48*60*60`），清单原标 24h → 已修正；
2. D1 分支 7 天保留 vs KV 分支 48h TTL vs 上游文件无限滚动：介质不同、保留策略不同，属 [简化]；
3. 上游文件无限 append 不裁剪（仅内存 500 条裁剪）；Worker KV 环形物理删除超限记录（更节省）；
4. 上游 `debugMiddleware` 在中间件层捕获（含状态码写入拦截），Worker 在路由分发后捕获（`matched.status` 已确定）——语义等价。

---

## C5 D1 可选绑定 — 🟦 新增（migrations 0001-0006，13 张业务表）

上游无 D1 概念（纯文件存储）。Worker 为新增能力，`wrangler.jsonc` 中 `DB` 绑定可选，未绑定时全部回退 KV；`wrangler.dev.jsonc` 亦补齐 `DB` 绑定（本地/dev 与生产同一代码路径）。

**migrations 清单**（0001-0006，本地应用验证通过）：

| 迁移 | 表 | 来源 | 关键点 |
|------|-----|------|--------|
| 0001 | `usage_events`、`debug_records` | 初版 | ts/at 索引；apply 时一次性 DELETE 90d/7d（运行期 TTL 靠 cron，见 C3/C4） |
| 0002 | `chat_messages` | batch C | `(conversation_id, seq)` 复合主键，created_at 索引；7 天 cron TTL |
| 0003 | `api_keys`、`accounts`、`cache_stats`、`cache_stats_meta` | storage audit | P0-2：hash 唯一索引、撤销即时生效（KV 有 ~60s 最终一致窗口）；P1-1：accounts 行级写 + 乐观锁（refresh token 单次使用保护）；P2-1：cache_stats 原子累加（`col = col + excluded.col`） |
| 0004 | `resolver_sessions` | storage review | resolver 索引迁 D1（session_id PK + last_used/conversation 索引），避免单 KV 文档 RMW 丢条目 |
| **0005** | `conversations`、`session_bindings`、`user_sessions`、`conv_cache` | **free-tier Phase 2** | 后台四类 KV 写迁 D1；无 KV 式 TTL（项目模式），新鲜度读侧过滤 + 节流修剪；`updated_at`/`last_used_at` 索引 |
| **0006** | `resolver_session_blobs` | **free-tier Phase 3** | 每会话 blob 整存（`data` 序列化 ResolverSession，contextHistory ≤512 条）；`last_used_at` 索引；**>1.5M 字符（`MAX_D1_BLOB_CHARS`）超大 blob 留 KV**（D1 行上限 2MB，CJK 极端情形由插入失败兜底回退） |

**各 store 的 D1 优先 + KV 兜底/回退/懒回填**：
- `keys.ts`：`UPSERT ... ON CONFLICT(id) DO UPDATE`；镜像仅 revoke 状态变更时写；`lastUsedAt` 节流（60s/键，waitUntil 离关键路径）；**回填闩锁**（P0-2：表非空或回填完成即置位，鉴权热路径零探测行读）；
- `accounts.ts`：`d1Upsert` 带 `updated_at` 乐观锁 + 一次重试；`refresh_token` 空值 CASE 保留旧值；镜像仅结构变更且**去 token**（见 C2）；`updateRefreshToken`/`setScheduleEnabled`/`markStatus` 均为列级 UPDATE 不碰 token 列；
- `cacheStats.ts`：UPSERT 原子累加 + `cache_stats_meta` 存 active_sessions；
- `usage.ts`：INSERT 优先，失败回退 KV 日桶（见 C3）；
- `resolver.ts`：索引（0004）+ blob（0006）均 D1 优先；**candidates 匹配（≤24）与控制台列表（≤50）为单条 `WHERE session_id IN (...)` 批量查询**（点查循环会撞 D1 免费 50 查询/invocation 上限）；`d1TrimIndex` 每 100 次 bind 一次（`TRIM_EVERY_N_BINDS`）；**touch 写节流 10min + `lastWriteAt` TTL 锚点**（Phase 0：消除"KV 配额超限 → 用户 500"的唯一触发路径）；KV 为 no-D1 兜底与 D1-miss 回退；
- `conversations.ts`：recordConversation → D1 UPSERT（`CASE WHEN excluded.title <> ''` 精确复刻"空 title 不覆盖"语义）+ 每 50 次写修剪（cap 500）；列表 `ORDER BY updated_at DESC LIMIT 500`；表空一次性惰性回填（闩锁）；session bindings 点读 D1 miss 回退 KV `sessbind/*` 键；
- `convCache.ts`：put/get D1 优先；**读侧 2h 新鲜度检查**（KV `expirationTtl` 的等价物——不加则过期条目被永久复用，正确性关键）；每 100 次写节流修剪；D1 miss 回退 KV 读；
- `admin/extras.ts`（user sessions）：putUserSession → D1 UPSERT（PK `api_key_hash + user_id`）+ 每 100 次写节流修剪（7 天）；getUserSession → D1 点读带 TTL 判断，miss 回退 KV；cron `activeUserConversations` → **单条 `SELECT DISTINCT`**（替代逐键枚举 ≤200 次）；
- `chatMessages.ts`：`appendChatTurn`（user+assistant 两行、`MAX(seq)+1`、竞态重试一次、单条 900KiB 截断）、`listMessages`（≤1000 行升序）、`deleteByConversation`（对话删除联动）、`cleanupOld`（7 天 cron）。

**测试**：新增 `test/background-stores-d1.test.ts`（仿 chat-messages 的 SQL 片段匹配 mock D1）：conversations 空 title 不覆盖/一次性回填、bindings 列表/删除/KV 回退、user sessions TTL、conv cache TTL、各存储"零 KV 写"断言。

---

## C6 DO 协调 — ✅（COORD 绑定时跨 isolate 强一致；未绑定回退 isolate 行为）

**上游**：全部协调原语为进程内存（单实例无跨进程问题）：账号轮询游标（auth/cache.go `Store.Next`）、并发信号量（account_concurrency.go，channel 阻塞）、登录锁定（admin_security.go）、刷新互斥（无显式实现，靠单实例串行）、健康/冷却（account_health.go 内存 map）。

**Worker** `src/do/coordination.ts` `CoordinationDO`（`gateway-coord` 单例，SQLite-backed storage + alarm 自动清理）：

| 原语 | 端点 | 语义 |
|------|------|------|
| 登录锁定 | `/lockout` `/lockout/check` | 5 次/15min（对齐上游），DO 持久化跨 isolate |
| 轮询游标 | `/next-account` | 原子 round-robin（未绑定回退 KV `accounts-cursor`） |
| 健康+并发预筛 | `/next-healthy` | 原子选号：健康（非 authFail/非冷却/熔断关）+ 并发槽（B1/B6），返回 `lastReason` 区分冷却/并发满 |
| 并发信号量 | `/acquire` `/release` `/semaphore/available` `/semaphore/snapshot` | 有界等待（默认 15s，可 0=立即拒），holder 租约 15min TTL；满 → `retryAfterMs: 1000` |
| 命名互斥 | `/mutex` `/mutex/release` | 单飞互斥（`refresh:<id>`，30s TTL + token 校验），未抢到方轮询 KV ≤15s（A6） |
| 健康状态 | `/health/available\|mark-failure\|mark-call\|image-limited\|update-throttling\|mark-success\|clear\|snapshot` | cooldown/authFail/limited/imageLimited/calls/quotaAttempts/throttling；DO 拥有 `quotaAttempts`（429 指数退避）与全局熔断（30s 窗口 ≥10 请求失败率 ≥50% → open 30s） |
| 账号缓存 | `/accounts-cache`（GET/update/invalidate） | 30s TTL 列表缓存，热路径免全量 D1 扫描 |

**未绑定回退（所有 `coord*` helper 返回 null）**：
- 健康：KV `account-health` 文档 + isolate 本地熔断（account.ts `globalCircuit`）；
- 游标：KV `accounts-cursor`；
- 锁定：handlers.ts `LOCAL_LOCKOUT_*`（isolate 本地 Map，上限 4096）；
- 刷新互斥：accounts.ts `inflight` Map（per-isolate 单飞，跨 isolate 竞态可能但单运营商部署概率低）。

**对齐项**：`MAX_ACCOUNT_PROBE=16`、锁定参数、信号量默认 8（settings.accountConcurrencyLimit）、刷新互斥 TTL 30s、健康分类冷却全表（errors.ts `classifyError`/`cooldownMsForCategory`）均与上游一致。

**free-tier 优化追加（2026-08-30 Phase 0-1）**：
- `coordHealthMarkCall` / `coordHealthUpdateThrottling` 返回类型 `Promise<void>` → `Promise<boolean | null>`（原实现丢弃 DO 的 `{ok}` 应答）；`account.ts` 两处按 markFailure/markSuccess 同款契约补 `if (ok) return`——DO 绑定时每请求 −2 KV 读 −2 KV 写（多轮工具调用按轮放大），并消除 `account-health` 单 key 撞 KV「1 写/秒」限流的风险；
- `rememberHealthy`（B2 偏好）改为**账号变化才写**，写失败重置 tracker 下次重试——每请求 −0.95 KV 写。

**Phase 3 剩余观察项（触发条件均未满足，刻意不做，见 EXECUTION-STATUS §3.1）**：
- P2-1 `McpSessionDO` SSE → WebSocket + Hibernation：1 条 24h 常驻连接 ≈11,060 GB-s ≈ 免费时长配额的 85%，触发条件为实际使用 MCP 且面板 DO Duration > 3,000 GB-s；
- P2-2 `CoordinationDO` 状态拆 SQLite 表：现整块 `storage.put(STATE_KEY)`（key+value ≤2MB 硬上限 + 全量 RMW），触发条件为单 blob >1MB 或账号数 >100；
- P2-3 `/acquire` 去自旋：现最多 15s 自旋期间 DO 活跃计费，触发条件为面板 Duration 出现与请求量成比例的非常量基数。

---

## 存储性能机制（2026-08-30/31 free-tier 优化，跨 C1/C5/C6）

| 机制 | 位置 | 效果 |
|------|------|------|
| settings 30s 隔离内缓存 | `store/settings.ts:188-198`（WeakMap 以 KV namespace **对象**为 key，测试天然隔离；`saveSettings` 写后失效） | 每请求 KV 读 5 → 1；跨 isolate 陈旧 ≤30s |
| 回填闩锁 | `keys.ts`（P0-2）、`conversations.ts`（P1-3 legacy 迁移闩锁） | 鉴权/列表热路径零探测行读/零 legacy 文档读 |
| resolver touch 节流 | `resolver.ts` `SESSION_TOUCH_THROTTLE_MS = 10min` + `lastWriteAt` TTL 锚点（不用 lastUsedAt，避免高频会话 TTL 失效） | 关键路径 KV 写 1 → ~0.1；**消除 KV 配额超限 → 用户 500 的唯一触发路径** |
| `d1TrimIndex` 节流 | `resolver.ts` `TRIM_EVERY_N_BINDS = 100` | D1 rows_read −≤1000/请求（原每次 bind `COUNT(*)` 全表） |
| `recordFinalize` 分段隔离 | `api/openai.ts` `step()` 助手：bindSession/recordConversation/transcript/convCache/sessionBinding/userSession/usageStats 七步各自 try/catch | 后台单步失败只 warn，不再连带丢弃绑定/转录/统计 |
| cleanup 删除预算 | `cleanup.ts` `deleteBudget` 30 → 20（级联账：每云删除 1-3 本地 KV 删 × 48 轮/天） | KV deletes（1,000/天）不再被峰值 1,440 触顶 |
| 读侧新鲜度检查 | `convCache.ts` / `resolver.ts` blob（2h，KV TTL 等价物） | D1 无 TTL 下正确性关键：过期条目不被复用/复活 |
| 批量 IN 查询 | `resolver.ts` candidates（≤24）/ 控制台列表（≤50） | 避开 D1 免费 50 查询/invocation 上限 |

**指标终态**：每请求 KV 写 8.1 → **≈0.2**；KV 读 10-60 → **≈2**；免费层承载 ≈123 → **≈2,400+ 请求/天**；绑定约束转移至 D1 rows read → DO requests。明细见 `docs/STORAGE-FREE-TIER-EXECUTION-STATUS-2026-08-31.md`。

---

## 建议回写 ALIGNMENT-CHECKLIST-non-model.md（C 部分）

**已完成（2026-08-27/28 批次）**：

| 行 | 修改 |
|----|------|
| C1 | 检测要点更新：storage audit 后 D1 行优先（0003/0004），KV 文档降级为镜像（仅结构性变更写）+回退+懒回填；未绑 D1 时 KV 即时写替代落盘循环 |
| C3 | 检测要点补：**已修 D1 分支 usage 清理**（usage.ts cleanupOld 挂 */30 cron，DELETE 90 天前）；L 部分 2 待办移除该项 |
| C4 | 检测要点修正：KV 环形 **48h TTL**（原 24h 误标）；补 D1 分支 7 天保留（cron DELETE） |
| C5 | Worker 列修正：`migrations 0001-0004 + chatMessages.ts`（原 0001/0002）；检测要点补 0003/0004 表与各 store D1 优先模式 |
| L6 | 追加：C1-C6 复核结论 + magic→Magic 改动记录 |

**待回写（2026-09-03 批次，free-tier 优化）**：

| 行 | 修改 |
|----|------|
| C1 | 检测要点更新：D1 优先范围扩至 0005/0006（conversations/bindings/user_sessions/conv_cache/resolver blobs），KV 写退出热路径（≈0.2/请求）；镜像去 token |
| C2 | 检测要点补：KV 文档镜像已剥离 token（纯结构清单），D1 表仍明文 |
| C5 | Worker 列修正：`migrations 0001-0006`；检测要点补 0005/0006 表、批量 IN 查询、读侧新鲜度 |
| C6 | 检测要点补：markCall/updateThrottling 早退（DO 应答契约）；Phase 3 观察项（McpSessionDO Hibernation / DO 状态拆表 / /acquire 去自旋）触发未满足 |
| D5 | 单次删除预算 30 → 20（cleanup.ts P1-6） |
| L | 追加第 8 条：free-tier 优化落地记录（指向 EXECUTION-STATUS 文档） |

---

## 附：核对中确认无误的清单声明

**2026-08-27/28 批次**：
- C4「≤256KiB/条、500 条」：`DEBUG_CAPTURE_LIMIT=256*1024`、`DEBUG_MAX_RECORDS=500` → 属实（TTL 项除外，已修正 48h）。
- C3「Free 计划面板最多读约 30 桶」：`loadWindowKV` 中 `keys.slice(-30)` → 属实。
- C6「COORD 绑定时跨 isolate 强一致；未绑定回退 isolate 行为」：`coordAction` 无绑定/失败返回 null，各调用方均有 KV/本地兜底 → 属实。
- C2「见 A12」：`accounts.ts` 明文存取、上游 `auth/cache.go` AES-GCM → 属实。
- C5「未绑定自动回退 KV」：`if (env.DB) {...} else KV` 模式遍布 keys/accounts/cacheStats/usage/resolver → 属实。
- 上游 `debug.go` 的 `debugMiddleware` 与 `sensitiveKeys` 表、`usage.go` 的 `maxUsageRecords=50000`、`persist.go` 的 `M365_PERSIST_INTERVAL` 均为清单描述所对应的真实实现。

**2026-09-03 批次（free-tier 优化抽查核实）**：
- `migrations/0005_background_writes_d1.sql`：`conversations`/`session_bindings`/`user_sessions`/`conv_cache` 四表 + 索引 → 与 EXECUTION-STATUS §2.4 一致；
- `migrations/0006_resolver_blobs_d1.sql`：`resolver_session_blobs`（session_id PK, data, last_used_at）→ 一致；
- `settings.ts:188-198`：`SETTINGS_CACHE_TTL_MS = 30_000` + WeakMap（KV namespace 对象为 key）→ 一致；
- `accounts.ts:149`：`mirrorToKV` 写入前剥离 token → 一致；
- `resolver.ts`：`SESSION_TOUCH_THROTTLE_MS = 10min`、`lastWriteAt`、`MAX_D1_BLOB_CHARS = 1_500_000`、`TRIM_EVERY_N_BINDS = 100` → 一致；
- `cleanup.ts:88`：`deleteBudget = 20` → 一致；
- `conversations.ts`：D1 UPSERT（空 title 不覆盖 CASE）/ `ORDER BY updated_at DESC LIMIT 500` 修剪 → 一致；
- `extras.ts`：`user_sessions` UPSERT / `SELECT DISTINCT` cron 枚举 → 一致；
- `openai.ts:902`：`step()` 分段隔离七步 → 一致；
- 回归：`tsc --noEmit` 通过；vitest **23 文件 / 217 用例全绿**（EXECUTION-STATUS 声称 217/217 → 属实）。
