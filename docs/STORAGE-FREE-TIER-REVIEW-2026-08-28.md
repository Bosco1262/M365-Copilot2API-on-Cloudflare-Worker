# 存储设计复核：KV / D1 / DO 与回退设计在 Cloudflare 免费层的可行性

> **⚠️ 状态：已被取代（2026-08-30）**。本文的配额基线含 4 处错误（最重要：DO 空闲可休眠不计费，"常驻吃 83% 时长"结论不成立）、1 项口径偏差与 5 项遗漏。
> 逐条复核见 `STORAGE-FREE-TIER-REVIEW-VERIFICATION-2026-08-30.md`；修正后的配额基线、资源分布与实施计划见 `STORAGE-FREE-TIER-PLAN-2026-08-30.md`（计划部分已全部执行完毕，执行状态清单见 `STORAGE-FREE-TIER-EXECUTION-STATUS-2026-08-31.md`）。
> 本文保留作为历史记录，其中"约 150 次/天"的起点基线仍然有效。

日期：2026-08-28
范围：`wrangler.jsonc`、`migrations/*`、`src/store/*`、`src/do/*`、`src/pipeline/{account,resolver,cleanup}.ts`、`src/api/openai.ts`、`src/index.ts`
前置文档：`docs/storage-audit-report.md`（一致性/并发视角，未涉及配额）

---

## 〇、结论摘要

**分层方向是对的，但按免费层配额核算，当前实现大约支撑 150 次 `/v1/chat/completions`／天，之后 KV 写入开始报错并逐步引发 500。**

三处"方向正确但量级错误"：

| # | 结论 | 依据 |
|---|---|---|
| 1 | **KV 写入配额（1,000/天）是最硬的瓶颈** | 单次聊天请求产生 6~7 次 KV 写；1,000 ÷ 6.5 ≈ **150 次/天** |
| 2 | **DO 时长配额（13,000 GB-s/天）被单例协调 DO 吃掉 83%** | 单例 `gateway-coord` 常驻 24h = 86,400 对象秒 × 0.125 GB = **10,800 GB-s** |
| 3 | **D1 免费库上限是 500 MB，不是 5 GB** | `debug_records` 单条可达 512 KB（256 KB 请求 + 256 KB 响应），**约 1,000 条即写满整库** |

另有四处设计层面的问题（与配额无关，属于正确性与可运维性）：

4. `openai.ts:967` 为取一个计数，每次请求读取最多 **50 个完整会话 blob**。
5. `validKey()` 的热路径上每次都执行 **api_keys 全表扫描 + 空表回填检查**。
6. 回退是**静默降级**：DO 调用失败与"未绑定"无法区分，并发门禁会**无声消失**。
7. `wrangler.dev.jsonc` **没有 D1 绑定** → 本地开发跑的是 KV 兜底路径，生产跑的是 D1 路径，**生产主路径在本地从未被执行过**。

---

## 一、免费层配额基线（已核实，2026-08）

### Workers

| 项 | 免费层 |
|---|---|
| 请求 | 100,000 / 天（UTC 00:00 重置，超出后返回 1027） |
| **CPU** | **10 ms / 次调用（硬上限，不可配置）** |
| 打包体积 | 3 MB（gzip 后） |
| Cron Triggers | 5 个 / 账户 |
| 并发连接 | 6 / 次调用 |

### Workers KV

| 项 | 免费层 |
|---|---|
| 键读取 | 100,000 / 天 |
| **键写入** | **1,000 / 天** |
| 键删除 | 1,000 / 天 |
| List 请求 | 1,000 / 天 |
| 存储 | 1 GB（账户下所有命名空间合计） |

> "If you exceed any one of these limits, **further operations of that type will fail with an error**."
> 即：写配额耗尽后 `kv.put()` 抛异常，读配额耗尽后 `kv.get()` 抛异常。

### D1

| 项 | 免费层 |
|---|---|
| 行读取 | 5,000,000 / 天 |
| 行写入 | 100,000 / 天 |
| **单库大小上限** | **500 MB**（付费 10 GB） |
| 账户存储 | 5 GB |
| 查询数 / 次调用 | **50** |
| SQL 语句长度 | 100,000 字节 |
| 绑定参数数 / 查询 | 100 |
| 单行 / 字符串 / BLOB | 2,000,000 字节（2 MB） |
| 特性 | **单库单线程，查询串行执行**；单库背后是一个 Durable Object |

### Durable Objects（免费层仅支持 SQLite-backed）

| 项 | 免费层 |
|---|---|
| 请求 | 100,000 / 天 |
| **时长** | **13,000 GB-s / 天** |
| 行读取 | 5,000,000 / 天 |
| 行写入 | 100,000 / 天 |
| SQL 存储 | 5 GB |

时长计费口径：**只要对象"活跃且不可休眠"就按墙钟计费，按分配的 128 MB 计**（与实际用量无关）。
换算：13,000 GB-s ÷ 0.125 GB = **104,000 对象秒/天 ≈ 28.9 对象小时/天**。

> 补充：免费层 DO 当日配额耗尽后，"further operations of that type will fail with an error"。
> 而 `coordAction()` 的 `catch { return null }` 会把这类失败**吞掉**。

---

## 二、当前设计盘点

### 2.1 KV（1 个命名空间）

| Key 模式 | 内容 | 读写频率 | 判定 |
|---|---|---|---|
| `settings` | 全量运行时配置（含 11 条模型映射） | **读 5~6 次/请求**，写极少 | 放对了层，**但未做请求内记忆化** |
| `api-keys` | 全量 key 列表 | 仅结构性变更时镜像 | 兜底镜像，价值低 |
| `accounts` | 全量账号列表（含 refresh token） | 仅新增/删除时镜像 | **危险**（见 5.4） |
| `admin-password-hash` / `admin-sessions` | 管理员凭据与会话 | 读多写少 | 合理 |
| `account-health` | 无 DO 时的 advisory 健康态 | 无 DO 时每请求 RMW | 兜底，可接受 |
| `account-last-healthy` | 最近成功账号 id | **写 1 次/请求** | ❌ 热路径写 |
| `resolver/<sessionId>` | 完整会话（最多 512 条消息） | **读写各 1~2 次/请求，单次 resolve 最多读 24 个** | ❌ 热路径大值读写 |
| `resolver-index` | 索引（无 D1 时） | 无 D1 时 RMW | 兜底 |
| `convcache:<acct>\|<model>` | 会话复用加速缓存 | **写 1 次/请求** | ❌ 热路径写（纯优化用途） |
| `conversations` | ≤500 条会话索引 | **读 1 + 写 1 / 请求（整文档 RMW）** | ❌ 热路径 RMW |
| `sessbind/<id>` | 会话绑定 | **写 1 次/请求**（若有 session_key） | ❌ 热路径写 |
| `usess/<hash>\|<user>` | 用户会话 | **写 1 次/请求** | ❌ 热路径写 |
| `usage/<yyyyMMdd>` | 用量日桶（无 D1 时） | 无 D1 时 RMW | 兜底 |
| `dbg:<id>` + `dbg:index` | 调试记录（无 D1 时） | 无 D1 时 | 兜底 |
| `pkce/*`、`img/*`、`plugins_cache:*` | 一次性/短 TTL | 低频 | 合理 |

### 2.2 D1（1 个库，6 张表）

| 表 | 写入来源 | 单次请求写入行数 |
|---|---|---|
| `usage_events` | `recordUsage` | 1 |
| `debug_records` | `captureDebugRecord`（logLevel=debug 时） | 1（**单条最大 ~512 KB**） |
| `chat_messages` | `appendChatTurn` | 2（**单行最大 900 KB**） |
| `api_keys` | `touchLastUsed`（节流 1 次/分钟/key） | 0~1 |
| `accounts` | 行级 UPSERT / 列级 UPDATE | 0~2 |
| `cache_stats` + `cache_stats_meta` | `recordCacheRequest` | 2 |
| `resolver_sessions` | bind UPSERT + touch UPDATE + trim | 1~3 |

### 2.3 Durable Objects（2 个类）

| 类 | 粒度 | 状态 | 判费风险 |
|---|---|---|---|
| `CoordinationDO` | **全局单例** `idFromName("gateway-coord")` | 单 key `state` 存整个 `CoordState` JSON，每次操作整体重写 + `setAlarm` | **常驻 24h ≈ 10,800 GB-s（占 83%）** |
| `McpSessionDO` | 每 MCP 会话一个 | 纯内存 Map，无持久化 | **SSE 长连接期间对象无法休眠，按 128 MB 全程计费** |

---

## 三、热路径单次请求成本实测

以 `/v1/chat/completions`（非流式、成功、D1 与 COORD 均已绑定）为例，逐项列出：

### 3.1 KV 读（典型 ~11 次，最坏 ~85 次）

| # | 位置 | 说明 |
|---|---|---|
| 1-5 | `getSettings` ×5 | `openai.ts:394`(prepareCore)、`openai.ts:998`(runCompletionsCore)、`account.ts:440`(resolveAccount)、`account.ts:136`(concurrencyAvailable)、`openai.ts:684`(acquireAccountSlot)。**同一请求内重复读同一个 key 5 次，无任何记忆化** |
| 6 | `account.ts:92` | `lastHealthyAccountID` |
| 7 | `conversations.ts:42` | `getSessionBinding`（若有 session_key；miss 时再读一次 legacy 文档） |
| 8 | `convCache.ts:43` | `getConvCache` |
| 9 | `resolver.ts:392` | `resolveSession` 候选会话全量读取，**最多 24 个 blob**（`MAX_CANDIDATES`） |
| 10 | `resolver.ts:484` | `bindSession` → `getSession` |
| 11 | `conversations.ts:93` | `recordConversation` 读整个 ≤500 条索引文档 |
| 12-61 | `openai.ts:967` → `resolver.ts:580` | **`listResolverSessions()` 最多再读 50 个 blob**，仅为取 `.length` |
| +1 | `conversations.ts:45/58` | legacy `sessions` 文档探测（每次 upsert / delete 各一次） |

### 3.2 KV 写（6~7 次/请求）⚠️ **这是最硬的瓶颈**

| # | 位置 | 内容 |
|---|---|---|
| 1 | `account.ts:82` `rememberHealthy` | 最近成功账号 id |
| 2 | `resolver.ts:347` `putSession`（touch 路径） | 完整会话 blob |
| 3 | `resolver.ts:494/507` `putSession`（bind 路径） | 完整会话 blob |
| 4 | `conversations.ts:103` `recordConversation` | 整个 conversations 索引文档 |
| 5 | `openai.ts:927` `putConvCache` | 会话复用缓存 |
| 6 | `conversations.ts:50` `upsertSessionBinding` | 会话绑定 |
| 7 | `openai.ts:950` `putUserSession` | 用户会话 |

**1,000 次/天 ÷ 6.5 ≈ 154 次聊天请求/天。**

### 3.3 D1 查询（~15~20 次/请求，串行）

`api_keys` 全表扫描（回填检查） + hash 点查 → `resolver_sessions` loadIndex ×3（resolve / bind / listResolverSessions）→ `chat_messages` MAX(seq) → batch INSERT ×2 → `cache_stats` UPSERT ×2 → `resolver_sessions` UPSERT + COUNT(*) → `usage_events` INSERT → `debug_records` INSERT。

> D1 单库单线程、查询串行。20 次串行往返（每次数 ms）叠加在每次聊天请求上。
> 免费层查询数上限 50/次调用，目前 ~20，尚有空间但余量不大。

### 3.4 D1 行读取（最坏 ~3,000 行/请求）

`resolver_sessions` 的 `loadIndex` 每次 `LIMIT 1000`，而一次请求调用 3 次 → **最多 3,000 行/请求**。
5,000,000 ÷ 3,000 ≈ **1,600 请求/天**（会话数少时远好于此，仅作最坏值）。

### 3.5 DO 请求（~7~8 次/请求）

`GET /accounts-cache` → `/health/available` → `/semaphore/available` → `/next-healthy` → `/acquire` → `/health/mark-success|mark-failure` → `/health/mark-call` → `/release`。

100,000 ÷ 8 ≈ **12,500 请求/天**。注意：Workers 本身上限就是 100,000/天，若跑满则是 **800,000 DO 请求 = 8 倍超额**。

### 3.6 CPU（远超 10 ms）

- 4 次 SHA-256（api key hash、ipFingerprint、contextFingerprint、sysHash）
- **同一份 settings JSON 被 `JSON.parse` 5 次**
- 最多 75 个会话 blob 的 `JSON.parse`（resolve 24 + bind 1 + listResolverSessions 50），每个 blob 最多 512 条完整消息
- `estimateTokens` 遍历全部消息（×2 次：historyTokens 与 ct）
- `index.ts:328` 流式捕获 `text += dec.decode(chunk, {stream:true})` —— 对 256 KB 上限的字符串做 O(n²) 累加

---

## 四、免费层下的真实容量天花板

| 约束 | 配额 | 单次请求成本 | **天花板** |
|---|---|---|---|
| **KV 写入** | 1,000/天 | 6.5 | **≈ 150 次聊天/天** ← 绑定约束 |
| KV 读取 | 100,000/天 | 11（典型） | ≈ 9,000 次/天 |
| Workers 请求 | 100,000/天 | 1 | 100,000/天 |
| CPU | 10 ms/次 | **远超** | 单次即超限 |
| D1 行读取 | 5,000,000/天 | 最坏 3,000 | ≈ 1,600 次/天（最坏） |
| D1 行写入 | 100,000/天 | ~7 | ≈ 14,000 次/天 |
| D1 库容量 | 500 MB | — | debug 开启时 ≈ 1,000 条调试记录 |
| **DO 时长** | 13,000 GB-s/天 | 单例常驻 | **基线已占 83%** |
| DO 请求 | 100,000/天 | 8 | ≈ 12,500 次/天 |

**结论：KV 写入是绑定约束（~150 次/天），DO 时长是结构性风险（基线 83%）。**

---

## 五、逐项判定

### 5.1 ❌ P0-1：`openai.ts:967` 为计数读取 50 个会话 blob

```ts
const activeSessions = (await listResolverSessions(ctx.env)).length;
```

`listResolverSessions`（`resolver.ts:569`）先读索引（D1 ≤1000 行 或 KV），再对前 **50** 个会话逐个 `getSession()` 读取**完整会话对象**（每条最多 512 条消息）。

代价：50 次 KV 读 + 50 次大对象 JSON 解析，只为得到 `cache_stats.active_sessions` 一个数字。

**改法**：
```ts
// D1 路径
const n = await env.DB.prepare(
  "SELECT COUNT(*) AS n FROM resolver_sessions WHERE last_used_at >= ?"
).bind(cutoffIso).first<{n:number}>();
```
或更省：把 `activeSessions` 计数缓存在 CoordinationDO 里（60 s TTL），连同 `/health/snapshot` 一起返回。

### 5.2 ❌ P0-2：热路径 KV 写入（6~7 次/请求）

见 3.2。逐项改法：

| 写入 | 改法 | 省 |
|---|---|---|
| `rememberHealthy` | 移入 CoordinationDO 的 `state.lastHealthy`（`/release` 时顺带更新） | 1 写 |
| `putConvCache` | 迁 `waitUntil`；且仅在 `conversationId` 真的变化时写 | 1 写（关键路径） |
| `recordConversation` | 迁 D1（`conversations` 表，行级 UPSERT）+ `waitUntil`；或并入 CoordinationDO | 1 读 + 1 写 |
| `upsertSessionBinding` | 迁 `waitUntil`；`migrateLegacyBindings` 改为一次性闩锁 | 1 写 + 1 读 |
| `putUserSession` | 迁 `waitUntil` | 1 写 |
| `putSession`（touch） | 内容未变则跳过；或迁 D1 | 1 写 |

**目标：关键路径 0 次 KV 写，后台（waitUntil）≤1 次。**

### 5.3 ❌ P0-3：`d1BackfillFromKV` 在热路径上全表扫描

- `keys.ts:105` → `d1List()` 执行 `SELECT ... FROM api_keys`（全表）
- 被 `keys.ts:258`（**`validKey()` 内，每次鉴权**）、`keys.ts:171`（`listKeys`）、`accounts.ts:261`（`listAccounts`）调用

"空表时懒回填"的语义是对的，但**检查成本随表增长，且每请求付一次**。

**改法**：用一次性闩锁而非全表查询。
```ts
let backfillChecked = false;            // 模块级（isolate 生命周期内有效）
async function ensureBackfilled(env: Env) {
  if (backfillChecked || !env.DB) return;
  const row = await env.DB.prepare("SELECT 1 AS x FROM api_keys LIMIT 1").first();
  if (row) { backfillChecked = true; return; }
  await doBackfill(env);                // 真正的回填
  backfillChecked = true;
}
```
`LIMIT 1` 把成本从 O(表大小) 降到 O(1) 行读取。

### 5.4 ❌ P0-4：`accounts` 的 KV 镜像是"过期陷阱"

`accounts.ts:324-344`：`upsertAccount` **仅在 `inserted`（新账号）时**镜像 KV；`setScheduleEnabled`、`updateRefreshToken`、`markStatus` 均不镜像。

后果：KV 副本里的 `refreshToken` **永远是账号创建时的那一个**——而 AAD refresh token 是单次性的，早被兑换掉了。

于是这个"回滚安全网"的实际语义是：
- 回滚（移除 DB 绑定）后账号**确实还在**，但每个账号的 refresh token **都已失效** → 全部需要重新登录；
- 而在回滚发生的瞬间，如果代码用 KV 副本里那个旧 token 去兑换，AAD 会判定重放并**吊销整个 refresh token 家族**，账号彻底报废。

也就是说：**该镜像在最安全敏感的字段上必然过期，收益≈0，成本是 1 次/次的 KV 写（1,000/天配额）**。

**建议**：
- `accounts` 镜像改为**默认关闭**，用 `M365_KV_MIRROR=1` 显式开启；
- 或保留但**剥离 `refreshToken` 字段**（镜像时置空），让回滚路径明确落到"需要重新登录"，而不是"看似可回滚"。

`api-keys` 的镜像（仅 revoke 状态变化时写）成本低、语义清晰，**可以保留**。

### 5.5 ❌ P1-1：DO 时长配额会被单例协调对象耗尽

`CoordinationDO` 是全局单例。只要有稳定流量，它就持续驻留，无法休眠（且 `save()` 几乎每次都 `setAlarm`，进一步阻止休眠）。

- 常驻 24 h = 86,400 对象秒 × 0.125 GB = **10,800 GB-s**
- 免费层总额 **13,000 GB-s/天** → **基线即占 83%**
- 剩余 2,200 GB-s ≈ 4.9 对象小时，还要分给 `McpSessionDO`

`McpSessionDO` 更贵：`/attach` 返回的是普通 `ReadableStream`（`mcp-hub.ts:22`），**未使用 WebSocket Hibernation API**，因此 SSE 连接存续期间对象无法休眠，全程按 128 MB 计费。
**一条挂 24 h 的 MCP SSE 连接 = 10,800 GB-s**，与协调 DO 相加直接超额（10,800 + 10,800 = 21,600 > 13,000）。

**改法**：
1. `McpSessionDO` 改用 **WebSocket Hibernation API**（`state.acceptWebSocket()`），空闲时不计费；这是免费层能否用 MCP 的前提。
2. `CoordinationDO` 按职责**分片**：账号信号量/健康按 `accountId` 哈希到 N 个 DO（N=8~16），登录锁定独立一个，游标并入账号分片。避免任何单例常驻。
3. 若坚持单例：确保没有常驻理由——移除 `save()` 里的无条件 `setAlarm`（改为仅在确有到期项时设置），并接受"空闲即可能被驱逐"。

### 5.6 ❌ P1-2：`/acquire` 在 DO 内自旋等待

`coordination.ts:427-442`：
```ts
for (;;) {
  reap(st);
  if (空闲槽位) { ...; return; }
  if (now() >= deadline) return json({ acquired: false, retryAfterMs: 1000 });
  await sleep(Math.min(250, deadline - now()));   // 最长 15 s
}
```
`DEFAULT_ACQUIRE_WAIT_MS = 15_000`。一次获取失败可让对象**保持活跃 15 秒**（= 1.875 GB-s），并持续阻塞输入门后的其他操作。

**改法**：改为"立即返回 + Worker 侧退避重试"，或把等待者写入队列后交给 alarm 唤醒（DO 在 alarm 之间可休眠）。上游语义（自然背压）用 429 + `Retry-After` 表达即可，`openai.ts:690` 已经在这么做了。

### 5.7 ❌ P1-3：DO 状态整块重写 + DO 请求数过多

`CoordState` 把 `failures`（全部 IP 历史）、`mutexes`、`semaphores`、`health`、`circuit` 塞在一个 key（`STATE_KEY`）里，每次操作 `storage.put` 整块 + `setAlarm`（**每次 setAlarm 计费 1 行写入**）。

约 7~8 次 DO 调用/请求 → 7~8 行写入/请求；100,000 行写入/天 ÷ 8 ≈ 12,500 请求/天，且若跑满 Workers 的 100,000 请求/天则需要 800,000 DO 请求（**8 倍超额**）。

**改法**：
- 存储改为**按 key 分行**：`sem:<accountId>`、`health:<accountId>`、`mutex:<key>`、`cursor`、`lockout:<ip>`。每次操作只写 1 个小行，且 `failures` 不再随 IP 数放大写放大。
- 调用**合并为 1 次往返**：把 `available + next + acquire` 合成一个 `/pick`（已有 `/next-healthy`，把 acquire 折叠进去），把 `mark-success + mark-call + release` 合成一个 `/finish`。目标 **≤1 次 DO 调用/请求**。

### 5.8 ❌ P1-4：CPU 必然超过 10 ms 硬上限

见 3.6。最高性价比的三项：

1. **`getSettings` 请求内记忆化**（省 4 次 KV 读 + 4 次大 JSON 解析）：
   ```ts
   const cache = new WeakMap<Request, Promise<RuntimeSettings>>();
   export function getSettingsFor(req: Request, env: Env) {
     let p = cache.get(req);
     if (!p) { p = getSettings(env); cache.set(req, p); }
     return p;
   }
   ```
   或更彻底：沿调用链把 `settings` 作为参数下传（`prepareCore` 已经拿到了）。
2. **`listResolverSessions` 改 COUNT**（见 5.1）—— 直接消灭 50 次 blob 解析。
3. **流式捕获改数组 join**（`index.ts:328`）：
   ```ts
   const parts: string[] = []; let total = 0;
   const accept = (c: Uint8Array) => { parts.push(dec.decode(c, {stream:true})); total += c.byteLength; if (total >= cap) truncated = true; };
   // 结束时 text = parts.join("").slice(0, cap)
   ```

另外建议把 `resolveSession` 的候选数从 24 降到 6，并把会话里保存的历史从 512 条降到 ~32 条（前缀匹配用不到那么长）。

### 5.9 ⚠️ P2-1：回退是"静默降级"，不是"优雅降级"

`coordination.ts:509-524`：
```ts
} catch {
  return null; // any DO hiccup degrades to legacy behavior
}
```

**所有** DO 调用（含超时、配额超限、内部错误）都返回 `null`，与"未绑定"完全无法区分。而调用方对 `null` 的处理是**改变语义**：

| 调用 | COORD 正常 | `null`（未绑定／失败） |
|---|---|---|
| `coordAcquireAccount` | 并发门禁生效 | `openai.ts:686` → **完全不设限** |
| `coordNextHealthy` | 全局一致轮询 + 健康过滤 | 退化为每 isolate 独立探测 |
| `coordHealthMarkFailure` | 强一致 cooldown | 退回 KV 单文档 RMW（**并发丢更新**） |
| `coordHealthAvailable` | 强一致 | 读 KV（最终一致，~60 s 窗口） |

在免费层，"配额超限导致 DO 调用失败"是**高概率事件**（DO 时长基线已占 83%）。届时系统会**在无任何告警的情况下**失去并发保护，而日志里只有一个被吞掉的异常。

**改法**：
```ts
type CoordResult<T> =
  | { state: "ok"; value: T }
  | { state: "unbound" }        // 未绑定：预期内的降级
  | { state: "error"; err: unknown };  // 失败：需告警
```
- `unbound` → 沿用现在的兜底语义；
- `error` → 计数 + `console.error`，并在 `/api/health` 暴露 `coordination: "degraded"`；
- 管理端显眼位置提示"并发门禁当前未生效"。

### 5.10 ⚠️ P2-2：开发与生产走的是不同代码路径

`wrangler.dev.jsonc` **没有 `d1_databases`**，只配了 KV + DO。
生产 `wrangler.jsonc` 配了 D1 + DO。

→ **本地开发的每一次运行都在走 `if (env.DB) … else KV` 的 else 分支**，而生产永远走 if 分支。
→ 所有 `migrations/0003`、`0004` 引入的 D1 路径（`api_keys` 点查、`accounts` 行级写、`resolver_sessions` SQL 索引、乐观锁重试）**在本地从未被执行过**，194 个单元测试覆盖的是兜底路径。

**改法**：给 `wrangler.dev.jsonc` 加上本地 D1 绑定（`npx wrangler d1 create` 后填 `database_id`，wrangler 本地模式会用本地 SQLite 模拟），让 dev 与 prod 走同一分支。

### 5.11 ⚠️ P2-3：KV 配额错误会变成 500

`putJSON`（`kv.ts:12`）**没有 try/catch**。`saveDoc`、`saveIndex`、`recordConversation`、`conversations.ts` 的 `putJSON` 调用点也大多裸奔。

免费层写配额 1,000/天**一定会**被打满，届时 `kv.put()` 抛异常 → 冒泡到 `index.ts:408` 的顶层 catch → 客户端收到 500。

**改法**：`putJSON` 内捕获并返回 boolean；所有热路径（缓存/统计/镜像）写入忽略失败；仅结构性写入（创建 key、创建账号）需要失败可见。

### 5.12 ⚠️ P2-4：`debug_records` 会撑爆 500 MB 的 D1 免费库

- `DEBUG_CAPTURE_LIMIT = 256 * 1024`（`extras.ts:165`），单条记录 = 请求体（≤256 KB）+ 响应体（≤256 KB）≈ **512 KB**
- 免费层 D1 **单库 500 MB** → **约 1,000 条记录即写满整库**，之后**所有 D1 写入失败**（含 usage、chat_messages、accounts、api_keys）
- 而 `debug_records` 的保留期是 7 天（`index.ts:475`），远大于写满所需时间

触发条件仅仅是 `logLevel = "debug"`——一个看起来很正常的生产设置。

**改法**（三选一或组合）：
- `DEBUG_CAPTURE_LIMIT` 降到 **8 KB**（调试辅助不需要完整 payload；保留头部与截断标记即可）；
- 保留期 7 天 → **24 小时**；
- 捕获开关从 `logLevel === "debug"` 改为**独立开关** `M365_DEBUG_CAPTURE`，默认关闭。

同时 `chat_messages` 的 `MAX_MESSAGE_BYTES = 900 * 1024`（`chatMessages.ts:10`）也偏大：2 行/轮，7 天保留，一个大上下文对话（200K token ≈ 800 KB）两三轮就是几 MB。建议降到 **64 KB**，超出部分只存摘要——控制台回放用不到完整 900 KB。

> 附注：`chatMessages.ts:5` 注释写"1MiB D1 bound-parameter limit"，实际文档口径是**单行/字符串/BLOB 2 MB、SQL 语句 100 KB、绑定参数 100 个**。900 KB 未超限，但注释口径需要更正。

### 5.13 ⚠️ P2-5：Cron 的 10 ms CPU 上限会让自动清理失效

`index.ts:417` 的 scheduled handler 依次执行：
`refreshAllExpired`（可能多次外部兑换）→ tone 重同步（多次外部请求）→ `autoCleanupOnce`（**最多 100 轮 list + 30 次 delete**，每次都是外部 HTTP + 存储写）→ 3 次 D1 DELETE 清扫。

免费层 **Scheduled Worker 同样是 10 ms CPU**。CPU 不含 I/O 等待，但列表解析、Map 构建、JSON 处理都会计入；`autoCleanupOnce` 的 100 轮循环几乎必然超限并被终止。

**改法**：把 `autoCleanupOnce` 的预算从"100 轮 / 30 次删除"降到"**1 轮 / 5 次删除**"，靠 30 分钟一次的 cron 逐步收敛；tone 同步与 token 刷新拆到不同 cron（免费层有 5 个 cron 配额，目前只用了 1 个）。

### 5.14 ✅ 判定为合理的部分

| 设计 | 理由 |
|---|---|
| `api_keys` 迁 D1 + hash 点查 + 唯一索引 | 撤销需要强一致，KV 的 ~60 s 窗口不可接受。方向正确（只需修热路径回填检查） |
| `accounts` 行级写 + `WHERE updated_at = ?` 乐观锁 + 一次重试 | 单次性 refresh token 的正确解法 |
| `cache_stats` 用 `col = col + excluded.col` 原子自增 | 消除 RMW 丢更新，正确 |
| `resolver/<sessionId>` 拆独立 key + TTL 2 h | 修掉了"整文档 RMW 丢会话"，方向正确（只需降低读取扇出） |
| `usageLogs` 下推 `LIMIT/OFFSET` 到 SQL | 正确 |
| `sessbind/<id>` 独立 key 点读点写 | 正确（只需把遗留迁移改成一次性闩锁） |
| `if (env.DB) … else KV` 的双写兜底形态 | **形态**值得保留，问题在于"静默"（5.9）与"镜像过期"（5.4） |
| `McpSessionDO` 的职责本身 | 跨 isolate 实时帧投递，KV/D1 都做不到；问题只在**未用 Hibernation**（5.5） |

---

## 六、完整改进建议（按优先级）

### P0 —— 不做就会在免费层上直接失败

| # | 动作 | 涉及文件 | 预期收益 |
|---|---|---|---|
| 0.1 | `listResolverSessions()` → `SELECT COUNT(*)`，或走 DO 缓存的计数 | `openai.ts:967`、`resolver.ts` | 每次请求省 ~50 次 KV 读 + 50 次 blob 解析；**CPU 与 KV 读配额双解** |
| 0.2 | 热路径 KV 写全部迁 `waitUntil` 或迁 D1（见 5.2 表） | `account.ts:82`、`openai.ts:927/939/950`、`conversations.ts:50/103`、`resolver.ts:347/494` | KV 写 6.5 → ≤1（后台），天花板 150 → **≥1,000 次/天** |
| 0.3 | `d1BackfillFromKV` 改一次性闩锁 + `LIMIT 1` 探测 | `keys.ts:105/258/171`、`accounts.ts:261` | 消灭每请求全表扫描 |
| 0.4 | `getSettings` 请求内记忆化（WeakMap 或参数下传） | `store/settings.ts`、`api/openai.ts`、`pipeline/account.ts` | 省 4 次 KV 读 + 4 次 JSON 解析 |
| 0.5 | `putJSON` 内捕获异常；热路径写入忽略失败 | `kv.ts:12` | 避免 KV 配额耗尽 → 500 |
| 0.6 | `DEBUG_CAPTURE_LIMIT` 256 KB → 8 KB；保留期 7 天 → 1 天 | `admin/extras.ts:165`、`index.ts:475` | 保住 500 MB 的 D1 库 |

### P1 —— 结构性风险，尽快处理

| # | 动作 | 涉及文件 |
|---|---|---|
| 1.1 | `McpSessionDO` 改用 WebSocket Hibernation API | `do/mcp-hub.ts` |
| 1.2 | `CoordinationDO` 分片（按 accountId 哈希，N=8~16），消除单例常驻 | `do/coordination.ts`、`wrangler.jsonc` |
| 1.3 | `/acquire` 移除自旋等待，改立即返回 + Worker 退避 | `do/coordination.ts:427` |
| 1.4 | DO 存储改按 key 分行，去掉无条件 `setAlarm` | `do/coordination.ts:148` |
| 1.5 | DO 调用合并：`/pick`（健康+游标+取槽）、`/finish`（成功+计数+释放） | `do/coordination.ts`、`pipeline/account.ts`、`api/openai.ts` |
| 1.6 | `accounts` KV 镜像默认关闭，或剥离 `refreshToken` 字段 | `store/accounts.ts:324` |

### P2 —— 可运维性与正确性

| # | 动作 | 涉及文件 |
|---|---|---|
| 2.1 | DO 结果改判别式 `{ok\|unbound\|error}`，error 计数并暴露到 `/api/health` | `do/coordination.ts:509` |
| 2.2 | `wrangler.dev.jsonc` 补 D1 绑定，让 dev 与 prod 同路径 | `wrangler.dev.jsonc` |
| 2.3 | `autoCleanupOnce` 预算降到 1 轮 / 5 次删除；拆分 cron | `pipeline/cleanup.ts`、`index.ts` |
| 2.4 | `chat_messages` 单条上限 900 KB → 64 KB | `store/chatMessages.ts:10` |
| 2.5 | `resolveSession` 候选数 24 → 6；会话保存历史 512 → 32 条 | `pipeline/resolver.ts:45/326` |
| 2.6 | `migrateLegacyBindings` 改一次性闩锁 | `store/conversations.ts:26` |
| 2.7 | 迁移文件里的 `DELETE FROM ...` 保留语句移除或加注释（D1 迁移只跑一次，这些是 no-op，易误导） | `migrations/0001~0003` |

### P3 —— 可选优化

- `usage_events` 增加按天汇总表，看板聚合不再扫 90 天明细
- `conversations` 索引从 KV 文档迁 D1（配合 0.2）
- 为 `resolver_sessions` 增加 `context_finger` / `history_len` 列，把前缀匹配下推到 SQL，只回读 1~2 个候选（配合 P0.1 后可彻底消灭扇出）

---

## 七、推荐的终态分层

```
┌──────────────────────────────────────────────────────────────┐
│ 请求关键路径（同步，越少越好）                                    │
│   · API key 校验：D1 点查（1 次查询，有 memory 闩锁）            │
│   · settings：请求内记忆化（1 次 KV 读）                        │
│   · 账号选择：DO 分片 /pick（1 次 DO 调用，含健康+游标+取槽）      │
│   · 会话解析：D1 索引过滤 → 回读 0~2 个候选                      │
│   · 上游 ChatHub：外部 fetch                                    │
│   目标：KV 读 ≤2 / KV 写 0 / D1 查询 ≤5 / DO 调用 ≤2            │
└──────────────────────────────────────────────────────────────┘
                              ↓ ctx.waitUntil
┌──────────────────────────────────────────────────────────────┐
│ 后台路径（可失败、可丢弃）                                        │
│   · usage / cache_stats / chat_messages → D1（追加型，原子自增）  │
│   · resolver 索引 UPSERT、convCache、sessbind、userSession        │
│     → 优先 D1；KV 仅作无 DB 兜底                                │
│   · debug 记录 → 独立开关，默认关闭，上限 8 KB                    │
│   · DO /finish（成功标记 + 调用计数 + 释放槽位）                  │
└──────────────────────────────────────────────────────────────┘
```

**分工原则**（免费层口径）：
- **KV**：只放"读多写极少"的配置与"丢了也能重建"的缓存，且**写入必须在 waitUntil 里**；
- **D1**：所有追加型事件与需要原子自增/强一致读的小行；注意 500 MB 库容，大 payload 一律不放 D1；
- **DO**：只做**无法用 SQL 表达的跨 isolate 原子协调**；分片避免单例常驻；长连接一律用 Hibernation；单次请求 ≤1~2 次调用。

---

## 八、验证清单

在桌面端（非 OpenHarmony）执行：

```bash
npx tsc --noEmit
npx vitest run
npx wrangler deploy --dry-run
```

压测与配额观测（建议）：

1. 用 100 次连续 `/v1/chat/completions` 打一轮，在 Cloudflare 面板核对 **KV 写入次数**是否 ≈ 650（当前）→ 目标 ≤100。
2. 观察 **Durable Objects → Duration (GB-s)** 指标：`CoordinationDO` 单例是否常驻。
3. 打开 `logLevel=debug` 跑 1,000 次请求，核对 D1 库体积增长（当前应 ≈ 500 MB，目标 ≤ 8 MB）。
4. 临时解绑 `COORD` 跑一轮，确认 `/api/health` 能报告 `coordination: "degraded"`（当前不会有任何提示）。
