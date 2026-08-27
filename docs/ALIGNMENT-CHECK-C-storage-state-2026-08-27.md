# C 部分「存储与状态」逐项对齐核对报告

> 核对日期：2026-08-27
> 对照清单：docs/ALIGNMENT-CHECKLIST-non-model.md C 部分（C1–C6）
> 上游仓库：C:\Github Desktop\M365-Copilot2API-main（Go）
> Worker 仓库：C:\Github Desktop\M365-Copilot2API-on-Cloudflare-Worker（TS）
> 方法：逐项读取两端源码（上游 `internal/web/persist.go`、`atomicfile.go`、`usage.go`、`usage_http.go`、`debug.go`、`settings.go`、`keys.go`、`cache_stats.go`、`sessions.go`、`conversation_manager.go`、`conversation_cache.go`、`internal/auth/cache.go`；Worker `src/kv.ts`、`src/store/*`、`src/pipeline/account.ts`、`src/pipeline/resolver.ts`、`src/do/coordination.ts`、`src/admin/extras.ts`、`src/admin/handlers.ts`、`src/index.ts`、`migrations/*.sql`、`wrangler.jsonc`），核对清单声明的状态与检测要点是否与真实代码一致。
> 状态图例：✅ 对齐｜⚠️ 部分/简化｜❌ 未做｜[平台] Workers 限制｜[用户选择] 有意保留｜[死代码] 上游未使用

> **实施记录（同日追加）**：按本报告完成两项落地（2026-08-27，待 typecheck/vitest 回归）：
> - **默认映射表 tone 大小写**：`DEFAULT_MODEL_MAPPINGS` 中 gpt-image-2 的 `upstreamTone` 由 `magic` 改为 `Magic`，`KNOWN_UPSTREAM_TONES` 同步（对齐上游 `codex_catalog.go:87` 白名单与 `chathub/client.go:164` 的 `defaultTone = "Magic"`）；images/探测/fallback 路径的小写 `magic`（对齐上游 `images.go:104`、`server.go:115/2467`）有意保留。
> - **C3 D1 usage 清理修复**：`src/store/usage.ts` 新增 `cleanupOld(env, days=90)`（DELETE `usage_events` 中 `ts < now-90d`），挂载到 `src/index.ts` 的 `*/30` cron（debug-records 清理之后）；未绑 D1 时为空操作（KV 日桶靠 90 天 TTL 自过期）。清单 C3 待修项闭环，L 部分同步更新。

---

## 汇总（实施后）

| # | 功能点 | 清单原状态 | 实施后状态 | 关键差异 |
|---|--------|-----------|-----------|---------|
| C1 | 数据持久化 | ⚠️ [平台] | ⚠️ [平台]（检测要点已更新） | storage audit 后 D1 行优先，KV 文档降级为镜像+回退 |
| C2 | 敏感数据 | [用户选择] | [用户选择] | 上游 AES-GCM+0600，Worker 明文，已确认选择 |
| C3 | 用量统计 | ⚠️ [简化] | ⚠️ [简化]（**已修**） | D1 分支补 cron TTL 清理（本次），对齐上游 5 万条滚动语义 |
| C4 | 调试日志 | ⚠️ [简化] | ⚠️ [简化]（清单修正） | KV TTL 实为 48h（原 24h 误标）；D1 分支 7 天保留 |
| C5 | D1 可选绑定 | 🟦 新增 | 🟦 新增（清单修正） | migrations 已扩至 0001-0004（原只写 0001/0002） |
| C6 | DO 协调 | ✅ | ✅ | COORD 绑定时跨 isolate 强一致；未绑定回退 isolate 行为 |

**结论：C 部分 6 项无 ❌ 项。C6 完全对齐；C1/C3/C4 为 [平台]/[简化] 合理裁剪（其中 C3 的 D1 清理缺口本次修复、C4 清单 TTL 误标本次修正）；C2 为用户确认选择；C5 为新增能力且清单已修正迁移文件清单。**

---

## C1 数据持久化 — ⚠️ [平台]（检测要点已更新：D1 行优先架构）

**上游**：
- `persist.go` `persistStore`：内存变更仅标记 dirty，后台循环（`persistLoop`）每 5s `FlushAllPersist()` 合并写盘；间隔可用 `M365_PERSIST_INTERVAL` 调整（≥100ms）；`flushPending` 失败回置 dirty 下次重试；`StopPersistLoop` 供优雅停机。
- `atomicfile.go` `writeFileAtomic`：`MkdirAll(0700)` → 清理 stale tmp → `CreateTemp` → `Chmod(perm)` → 写 → `Sync()` → close → `Rename` → `fsyncDir`；调用方普遍传 `0600`。
- 各 store 均为 JSON 文件 + persistStore：`api-keys.json`（keys.go）、`accounts.json`（auth/cache.go）、`settings.json`（settings.go）、`sessions.json` / `user-sessions.json`（sessions.go）、`conversations.json`（conversation_manager.go）、`cache-stats.json`（cache_stats.go）、`usage.jsonl`（usage.go）。

**Worker**：
- `src/kv.ts`：`getJSON` / `putJSON`（TTL 下限 60s）/ `listPrefix`；KV 即时写，无"落盘循环"概念。
- **storage audit（2026-08-27）后为 D1 行优先**：D1 绑定时 `api_keys`/`accounts`/`cache_stats` 迁 D1 行（migrations/0003）、resolver 索引迁 D1（0004）、usage/debug 迁 D1（0001）、chat_messages 迁 D1（0002）；KV 文档降级为：
  - **镜像**：仅结构性变更写回（新增/删除/撤销），高频写（refresh token、status、schedule、lastUsedAt）不回写 KV 文档（accounts.ts / keys.ts 注释明确）；
  - **回退**：未绑 D1 时走原 KV 文档路径；
  - **懒回填**：首次读时 KV 文档 → D1 一次性迁移（`d1BackfillFromKV`）。

**差异**：
1. 落盘循环 → 即时写：[平台] 合理（KV 无文件系统）；D1 行写更接近上游"原子写盘"语义（行级 UPDATE 带乐观锁，见 C5）。
2. KV 镜像不完整：D1 绑定下高频字段只存在于 D1，KV 文档仅是结构性快照——回滚安全网语义成立，但不含最新 token/status。
3. 上游全部进程内存态 + 周期落盘；Worker 每次读均经 KV/D1（多一跳 RTT），由 DO 账号缓存（C6 `/accounts-cache`）缓解。

---

## C2 敏感数据 — [用户选择]（与 A12 一致，非待办）

**上游**：`internal/auth/cache.go`：
- `encryptRefreshToken`：AES-GCM，密钥由 `M365_MASTER_KEY` + pepper HMAC-SHA256 派生；未设置时使用内置公共 fallback key 并打 WARNING（`cache.go:93`）；
- 落盘 `accounts.json` 权限 0600（`writeFileAtomic`）；解密失败时保留原文、刷新报错（`cache.go:247`）。

**Worker**：`src/store/accounts.ts`：access/refresh token **明文**存 KV 文档（`accounts` 键）或 D1 `accounts` 表（0003）；无加密层，依赖 KV/D1 平台边界安全。

**结论**：清单 A12/K2 已确认 [用户选择]，本次复核无变化。

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

## C5 D1 可选绑定 — 🟦 新增（清单修正：migrations 0001-0004）

上游无 D1 概念（纯文件存储）。Worker 为新增能力，`wrangler.jsonc` 中 `DB` 绑定可选，未绑定时全部回退 KV。

**migrations 清单**（清单原写 0001/0002，本次修正为 0001-0004）：

| 迁移 | 表 | 来源 | 关键点 |
|------|-----|------|--------|
| 0001 | `usage_events`、`debug_records` | 初版 | ts/at 索引；apply 时一次性 DELETE 90d/7d（运行期 TTL 靠 cron，见 C3/C4） |
| 0002 | `chat_messages` | batch C | `(conversation_id, seq)` 复合主键，created_at 索引；7 天 cron TTL |
| 0003 | `api_keys`、`accounts`、`cache_stats`、`cache_stats_meta` | storage audit | P0-2：hash 唯一索引、撤销即时生效（KV 有 ~60s 最终一致窗口）；P1-1：accounts 行级写 + 乐观锁（refresh token 单次使用保护）；P2-1：cache_stats 原子累加（`col = col + excluded.col`） |
| 0004 | `resolver_sessions` | storage review | resolver 索引迁 D1（session_id PK + last_used/conversation 索引），避免单 KV 文档 RMW 丢条目；会话 payload 仍在 KV `resolver/<sessionId>`（2h TTL） |

**各 store 的 D1 优先 + KV 镜像/回退/懒回填**：
- `keys.ts`：`UPSERT ... ON CONFLICT(id) DO UPDATE`；镜像仅 revoke 状态变更时写；`lastUsedAt` 节流（60s/键，waitUntil 离关键路径）；
- `accounts.ts`：`d1Upsert` 带 `updated_at` 乐观锁 + 一次重试；`refresh_token` 空值 CASE 保留旧值；镜像仅结构变更（新增/删除）；`updateRefreshToken`/`setScheduleEnabled`/`markStatus` 均为列级 UPDATE 不碰 token 列；
- `cacheStats.ts`：UPSERT 原子累加 + `cache_stats_meta` 存 active_sessions；
- `usage.ts`：INSERT 优先，失败回退 KV 日桶（见 C3）；
- `resolver.ts`：D1 索引 upsert/trim，失败回退 KV `resolver-index`；KV 会话键 `resolver/<sessionId>` TTL 2h；
- `chatMessages.ts`：`appendChatTurn`（user+assistant 两行、`MAX(seq)+1`、竞态重试一次、单条 900KiB 截断）、`listMessages`（≤1000 行升序）、`deleteByConversation`（对话删除联动）、`cleanupOld`（7 天 cron）。

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

---

## 建议回写 ALIGNMENT-CHECKLIST-non-model.md（C 部分，已完成）

| 行 | 修改 |
|----|------|
| C1 | 检测要点更新：storage audit 后 D1 行优先（0003/0004），KV 文档降级为镜像（仅结构性变更写）+回退+懒回填；未绑 D1 时 KV 即时写替代落盘循环 |
| C3 | 检测要点补：**已修 D1 分支 usage 清理**（usage.ts cleanupOld 挂 */30 cron，DELETE 90 天前）；L 部分 2 待办移除该项 |
| C4 | 检测要点修正：KV 环形 **48h TTL**（原 24h 误标）；补 D1 分支 7 天保留（cron DELETE） |
| C5 | Worker 列修正：`migrations 0001-0004 + chatMessages.ts`（原 0001/0002）；检测要点补 0003/0004 表与各 store D1 优先模式 |
| L6 | 追加：C1-C6 复核结论 + magic→Magic 改动记录 |

---

## 附：核对中确认无误的清单声明

- C4「≤256KiB/条、500 条」：`DEBUG_CAPTURE_LIMIT=256*1024`、`DEBUG_MAX_RECORDS=500` → 属实（TTL 项除外，已修正 48h）。
- C3「Free 计划面板最多读约 30 桶」：`loadWindowKV` 中 `keys.slice(-30)` → 属实。
- C6「COORD 绑定时跨 isolate 强一致；未绑定回退 isolate 行为」：`coordAction` 无绑定/失败返回 null，各调用方均有 KV/本地兜底 → 属实。
- C2「见 A12」：`accounts.ts` 明文存取、上游 `auth/cache.go` AES-GCM → 属实。
- C5「未绑定自动回退 KV」：`if (env.DB) {...} else KV` 模式遍布 keys/accounts/cacheStats/usage/resolver → 属实。
- 上游 `debug.go` 的 `debugMiddleware` 与 `sensitiveKeys` 表、`usage.go` 的 `maxUsageRecords=50000`、`persist.go` 的 `M365_PERSIST_INTERVAL` 均为清单描述所对应的真实实现。
