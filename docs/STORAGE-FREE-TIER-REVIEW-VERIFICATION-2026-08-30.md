# 复核报告：docs/STORAGE-FREE-TIER-REVIEW-2026-08-28.md

复核日期：2026-08-30
复核方式：
1. **代码层**：逐条打开 `wrangler*.jsonc`、`src/{store,do,pipeline,api,admin}/*`、`src/index.ts`、`migrations/*` 核对行号与语义；`npx vitest run` 实测（23 文件 / 204 用例全部通过）。
2. **配额层**：对照 2026-08 当前 Cloudflare 官方文档（Workers / KV / D1 / Durable Objects 的 Limits 与 Pricing 页）+ 2026-02-11 changelog。

---

## 〇、总体判定

| 维度 | 结论 |
|---|---|
| **代码事实**（26 条） | **22 条属实，4 条部分/不属实** |
| **配额基线**（24 项数值） | **22 项正确，1 项口径偏差，遗漏 5 项限制** |
| **三条核心结论** | #1 KV 写入是绑定约束 → **成立**；#2 DO 时长基线占 83% → **不成立**；#3 D1 免费库 500 MB → **成立** |
| **最高优先级的新发现** | 文档漏掉了两个真实缺陷：`markCall` / `updateThrottling` 无条件重写 KV 健康文档；`resolveSession` 的 touch 写在关键路径上且无保护 |

一句话：**分层方向的判断是对的，KV 写入这个绑定约束的判断也是对的；但"DO 时长基线 83%"这条是错的（官方文档明确：可休眠的空闲对象不计费），且改进建议里"迁 waitUntil"这一项大部分已经落地了。**

---

## 一、配额基线核验（对照 2026-08 官方文档）

### 1.1 完全正确 ✅

| 文档条目 | 官方口径 | 判定 |
|---|---|---|
| Workers 请求 100,000/天（UTC 00:00 重置，超限 1027） | 一致 | ✅ |
| Workers CPU 10 ms/次调用（硬上限） | 一致（Cron Trigger 同样 10 ms） | ✅ |
| Workers 打包体积 3 MB（gzip 后） | 一致 | ✅ |
| Cron Triggers 5 个/账户 | 一致 | ✅ |
| 并发连接 6/次调用 | 一致（KV get/put/list/delete 也计入） | ✅ |
| KV 读 100,000/天 | 一致 | ✅ |
| **KV 写 1,000/天** | 一致 | ✅ |
| KV 删除 1,000/天 | 一致 | ✅ |
| KV List 1,000/天 | 一致 | ✅ |
| KV 存储 1 GB/账户 | 一致 | ✅ |
| D1 行读 5,000,000/天 | 一致 | ✅ |
| D1 行写 100,000/天 | 一致 | ✅ |
| D1 账户存储 5 GB | 一致 | ✅ |
| **D1 单库上限 500 MB（Free）/ 10 GB（Paid）** | 一致 | ✅ |
| D1 查询数 50/次调用（Free） | 一致 | ✅ |
| D1 SQL 语句长度 100,000 字节 | 一致 | ✅ |
| D1 绑定参数 100/查询 | 一致 | ✅ |
| D1 单行/字符串/BLOB 2,000,000 字节 | 一致 | ✅ |
| D1 单库单线程、查询串行、单库背后是一个 DO | 一致 | ✅ |
| DO 请求 100,000/天 | 一致 | ✅ |
| DO 时长 13,000 GB-s/天 | 一致 | ✅ |
| DO 行读 5,000,000/天 / 行写 100,000/天 / SQL 存储 5 GB | 一致 | ✅ |
| **`setAlarm()` 计 1 行写入** | 官方定价页明确："每次 `setAlarm()` 计为 1 row written" | ✅ 文档这条对了 |
| 免费层 DO 仅支持 SQLite-backed | 一致 | ✅ |

### 1.2 需要修正 ⚠️

| # | 文档写法 | 实际情况 | 影响 |
|---|---|---|---|
| B1 | "按分配的 **128 MB** 计 → 换算 13,000 ÷ **0.125 GB** = 104,000 对象秒" | 官方换算按 `128 MB / 1 GB = 0.128`：13,000 ÷ 0.128 = **101,562 对象秒 ≈ 28.2 对象小时** | 数字偏差 2.4%，不影响结论方向 |
| B2 | 未提及 DO 单对象存储上限（只写了 5 GB SQL 存储） | DO limits FAQ：SQLite-backed DO **单对象 1 GB（Free）**，超限写操作抛 `SQLITE_FULL` | 补全基线，当前实现远未触及 |

### 1.3 遗漏的限制（应补进 §一 基线表）

| 遗漏项 | 官方口径 | 与本项目的相关性 |
|---|---|---|
| **KV：同一 key 写入 1 次/秒** | KV Limits："Writes to same key **1 per second**" | 中。`account-health`、`conversations`、`cache-stats`、`settings` 都是单 key RMW；并发请求下会出现同 key 高频写（不报错，但会丢更新/加剧最终一致窗口） |
| **Workers：外部子请求 50/次调用** | 2026-02-11 changelog："free plan ... **50 external subrequests** and 1000 subrequests to Cloudflare services per invocation" | 低（当前每次聊天约 2~5 次外部 fetch，工具多轮/重试叠加时也远低于 50），但应入表 |
| **Workers：Cloudflare 服务子请求 1,000/次调用** | 同上 | 说明 `listResolverSessions` 的 50 次 blob 读取**不会**撞硬上限——它是配额/CPU 问题，不是子请求问题。文档未区分，容易误判为"硬失败" |
| **Workers Free 突发速率 1,000 请求/分钟**（超限 1015） | Workers Limits | 低（150/天远低于此），但压测时需要注意 |
| **D1：每账户最多 10 个数据库（Free）** | D1 Limits | 低，仅作基线补全 |

> ✅ 好消息：我最初怀疑"KV/D1/DO 调用受 50 子请求硬上限约束"是**不成立**的——Cloudflare 对"发往自家服务的子请求"给的是 1,000/次调用，50 只约束外部 `fetch()`。文档 §3.1 的"最坏 ~85 次 KV 读"因此不会触发硬失败，只是打满读配额和 CPU。

---

## 二、代码层逐条核验

### 2.1 属实（22 条）

| 文档章节 | 主张 | 代码证据 | 判定 |
|---|---|---|---|
| 摘要 #4 / §5.1 | `openai.ts:967` 为取计数读 50 个完整会话 blob | `openai.ts:967` `const activeSessions = (await listResolverSessions(ctx.env)).length;` | ✅ |
| §5.1 | `LIST_MAX_FULL_READS = 50` | `resolver.ts:47` | ✅ |
| §3.1 #9 | resolve 候选上限 24 | `resolver.ts:45` `MAX_CANDIDATES = 24` | ✅ |
| §2.1 | 会话历史最多 512 条 | `resolver.ts:326` `msgs.slice(msgs.length - 512)` | ✅ |
| §5.8 / §3.1 | `getSettings` 请求内无任何记忆化 | `settings.ts:182-187`（每次都 `getJSON` + spread） | ✅ |
| §3.1 | 单次请求 `getSettings` 约 5 次 | `openai.ts:394/684/768/998` + `account.ts:136`（或 `440`） | ✅ 总数 5 正确（枚举见 2.2-G） |
| §5.3 | `validKey()` 每次鉴权触发 `api_keys` 全表扫描 | `keys.ts:258` → `d1BackfillFromKV` → `d1List` = `SELECT ... FROM api_keys`（**无 LIMIT**，`:94-96`） | ✅ |
| §5.3 | 同样在 `listKeys` / `listAccounts` 调用 | `keys.ts:171`、`accounts.ts:261` | ✅ |
| §5.4 | `accounts` KV 镜像仅 `inserted`（新账号）时写 | `accounts.ts:331` `if (inserted) { await mirrorToKV(...) }` | ✅ |
| §5.4 | `setScheduleEnabled` / `updateRefreshToken` / `markStatus` 均不镜像 | `accounts.ts:395-396`（注释明说"No KV mirror"）、`:436-437`、`:523-524` | ✅ |
| §5.5 | `CoordinationDO` 是全局单例 | `coordination.ts:513` / `:606` `ns.idFromName("gateway-coord")` | ✅ |
| §5.7 | 整个 `CoordState` 塞在单 key `state` 里整块重写 | `coordination.ts:32` `STATE_KEY`、`:59-66`、`:148-149` | ✅ |
| §5.6 | `/acquire` 在 DO 内自旋等待，默认 15 s | `coordination.ts:36` `DEFAULT_ACQUIRE_WAIT_MS = 15_000`、`:427-442` 的 `for(;;)` + `sleep(min(250, …))` | ✅ |
| §5.9 | 所有 DO 调用失败都 `catch → null` | `coordination.ts:509-524` `catch { return null; }` | ✅ |
| §5.9 | `null` 时并发门禁直接消失 | `openai.ts:686` `if (!slot) return { ok: true, acc }; // no gating` | ✅ |
| §5.10 | `wrangler.dev.jsonc` 没有 `d1_databases` | 该文件只配了 `kv_namespaces` + `durable_objects`，确无 `d1_databases`（对比 `wrangler.jsonc:33-40` 有 `DB`） | ✅ |
| §5.11 | `putJSON` 无 try/catch | `kv.ts:12-21` 直接 `await kv.put(...)`，无保护 | ✅ |
| §5.12 | `DEBUG_CAPTURE_LIMIT = 256 * 1024` | `extras.ts:165` | ✅ |
| §5.12 | 调试记录保留 7 天 | `index.ts:475` `DELETE FROM debug_records WHERE at < datetime('now','-7 days')` | ✅ |
| §5.12 | `MAX_MESSAGE_BYTES = 900 * 1024`，注释口径写成 1 MiB | `chatMessages.ts:10` / 注释在 `:5` | ✅ 注释确实与官方 2 MB 口径不符 |
| §5.13 | `autoCleanupOnce` 100 轮 / 30 次删除 | `cleanup.ts:88` `for (let round = 0; round < 100; round++)`、`:82` `deleteBudget = 30` | ✅ |
| §5.8 | `index.ts:328` 流式捕获用 `text += ...` 累加 | `index.ts:327-333` | ✅（但有上限截断，见 2.2-J） |
| §2.7 / P2.7 | 迁移文件尾部残留 `DELETE FROM ...` | `migrations/0001_init.sql`、`0002_chat_messages.sql` 末尾各有一条 | ✅ |
| §5.14 | `cache_stats` 用 `col = col + excluded.col` 原子自增 | `cacheStats.ts:62-69` | ✅ |
| §5.14 | `api_keys` 有 `hash` 唯一索引 | `migrations/0003` `CREATE UNIQUE INDEX idx_api_keys_hash` | ✅ |
| §5.14 | `accounts` 行级写 + `WHERE updated_at = ?` 乐观锁 + 一次重试 | `accounts.ts:100-104` `UPDATE_SQL`、`:186-237` | ✅ |

### 2.2 部分错误 / 需要修正（4 条 + 7 处细节）

#### ❌ A（重大）："DO 时长基线占 83%" 不成立

文档 §5.5 与摘要 #2 的核心前提是："单例 `gateway-coord` 常驻 24h = 86,400 对象秒 × 0.125 GB = 10,800 GB-s，占 13,000 的 83%"。

官方定价页原话（2026-08 现行）：

> "Durable Objects are billed for compute duration (wall-clock time) while the Durable Object is **actively running or is idle in memory but unable to hibernate**."
> "Durable Objects that are **idle and eligible for hibernation are not billed for duration, even before the runtime has hibernated them**."
> "**Inactive objects receiving no requests do not incur any duration charges.**"

`CoordinationDO` 没有 `accept()` 的 WebSocket、没有出站 `connect()`、没有未完成的响应流 —— **它完全符合休眠条件**。因此：

- 它会像普通 DO 一样在空闲后被休眠/驱逐，`load()` 的内存缓存随之失效（下次请求重新 `storage.get`）；
- 空闲期间 **不产生任何 GB-s**；
- `setAlarm()` 不会阻止休眠，它只是定时把对象唤起来跑一次 `alarm()`，跑完继续空闲。

真实开销量级：活跃秒数 ≈ 单次处理耗时 × 请求数 + alarm 唤醒耗时 × 次数 → 每天 **个位数 GB-s**，占 13,000 的 **0.01%~0.1%**，不是 83%。

**唯一成立的时长风险是 `McpSessionDO`**：`do/mcp-hub.ts:22` 的 `/attach` 返回普通 `ReadableStream`，按 DO limits 的定义，"response stream 在飞"期间对象保持 active 且不可休眠 → SSE 连接挂多久就按 128 MB 计费多久。文档对这一半的判断是**对的**，而且比文档写的更严重：`McpSessionDO` 连 WebSocket 都没用，不是"未启用 Hibernation"，而是"根本不是 WebSocket"，改造成本比文档估计的更高（要改 SSE→WS 协议）。

**修正后的结论**：DO 时长不是结构性风险，只有"开着 MCP SSE 长连接"这一个场景会烧配额；`CoordinationDO` 分片（P1.2）的**动机应当从"省时长配额"改为"消除单点热点与 100k 请求/天上限"**。

#### ❌ B（重大）：P0-2 的"迁 waitUntil"建议，大部分已经落地了

文档 §5.2 的改进表把 `recordConversation` / `upsertSessionBinding` / `putUserSession` / `putConvCache` 都标成"迁 waitUntil"。实际上它们**全部已经在 waitUntil 里**：

```
openai.ts:1039 / 1197 / 1468 / 1628 / 1678
   └─ ctx.waitUntil(recordFinalize(...))
        ├─ bindSession          (openai.ts:889)
        ├─ recordConversation   (openai.ts:898)
        ├─ appendChatTurn       (openai.ts:918)
        ├─ putConvCache         (openai.ts:927)
        ├─ upsertSessionBinding (openai.ts:939)
        ├─ putUserSession       (openai.ts:950)
        └─ listResolverSessions (openai.ts:967)
```

`recordFinalize` 的**每一处**调用点（含 stream 路径与非 stream 路径、含 tool-call 提前返回路径）都包在 `ctx.waitUntil` 里。

**关键路径上真正剩下的 KV 写只有 1 次**：`account.ts:82 rememberHealthy`（在 `resolveAccount` 中被 `await`，且已自带 try/catch）。

所以 §5.2 的"目标：关键路径 0 次 KV 写"其实只差一步（把 `rememberHealthy` 挪进 DO 或 waitUntil），而"后台 ≤1 次"才是真正的重头戏——当前后台是 **5~6 次**。这条不改变"KV 写配额是绑定约束"的结论，但**彻底改变了修复清单和工作量估计**。

#### ❌ C（重大）：KV 写清单漏了两项，且与 §2.1 的表格自相矛盾

`markCall` 和 `updateThrottling` 没有像 `markFailure` / `markSuccess` 那样在 DO 成功后早退：

```ts
// account.ts:226-231  markCall —— 没有 `if (ok) return`
export async function markCall(env: Env, accountID: string): Promise<void> {
  await coordHealthMarkCall(env, accountID);        // DO 已记账
  const h = await load(env);                       // ← 读 account-health
  h.calls[accountID] = (h.calls[accountID] ?? 0) + 1;
  await putJSON(env["m365-copilot2api_KV"], KEY, h); // ← 无条件写 KV
}

// account.ts:235-241  updateThrottling —— 同样没有早退
```

对比 `markSuccess`（`account.ts:244-248`）和 `markImageLimited`（`:214-215`）都有 `if (ok) return;`，说明这是一个**遗漏**而非设计。

后果：
1. 与文档 §2.1 表格中"`account-health`：无 DO 时每请求 RMW"的描述**直接矛盾**——实测是"**无论 DO 是否绑定，每请求都 RMW**"；
2. 每次聊天请求多出 **2 次 KV 读 + 2 次 KV 写**（`markCall` 必有；`updateThrottling` 在 `res.throttling != null` 时触发，M365 通常非空）；
3. 健康态被**双写**到 DO 与 KV，KV 那份是陈旧的（缺少 DO 里的 cooldown/指数退避状态），一旦 DO 失效降级到 KV 路径，cooldown 计数会从错误的基线继续。

调用点：`openai.ts:771`（chatCall 内，waitUntil）、`openai.ts:1533`（stream 路径）、`admin/chat.ts:74/132`、`api/images.ts:192`。

#### ❌ D：§5.7 "save() 里无条件 setAlarm" 不成立

`coordination.ts:148-158`：

```ts
private async save(st: CoordState): Promise<void> {
  await this.ctx.storage.put(STATE_KEY, st);
  const next = earliestExpiry(st);
  if (next !== null) {              // ← 已经是条件式的
    await this.ctx.storage.setAlarm(...);
  }
}
```

`setAlarm` 只在确有到期项（mutex TTL / semaphore holder TTL / cooldown / circuit openUntil）时才设。文档 P1.4 里的"去掉无条件 setAlarm"这条建议是**空操作**。
（`setAlarm` 计 1 行写入这点文档是对的，见 1.1。）

#### ⚠️ E：DO 行写入估算偏低约 2 倍

文档 §5.7 按 "7~8 次 DO 调用 ≈ 7~8 行写入/请求" 估算出 12,500/天。实际：

- 每次会调 `save()` 的操作 ≈ 2 行写（`storage.put` 1 行 + `setAlarm` 1 行）；
- 单次聊天请求里会 `save()` 的 DO 调用：`/next-healthy`（preferred 路径未命中时）、`/acquire`、`/health/mark-call`、`/health/mark-success`、`/release`、`/health/update-throttling`（常见）→ **5~6 次**；
- 合计 **≈10~16 行写/请求** → 天花板 **6,000~10,000 请求/天**，而非 12,500。

不影响主结论（仍远高于 KV 的 ~150/天），但排序时应更靠前于"DO 请求数"这一项。

#### ⚠️ F：§5.11 "KV 配额耗尽 → 客户端 500" 只对一条路径成立

文档说 `putJSON` 裸奔会冒泡到 `index.ts:408` 的顶层 catch。实测：

- `waitUntil` 里的 Promise 拒绝**不会**冒泡到顶层 catch（它们是独立的 promise 链），所以 `recordFinalize` / `markCall` 内部的 KV 写失败 → 后台任务失败 + `console` 报错，**用户不会看到 500**；
- 真正**在关键路径上、且无 try/catch** 的 KV 写只有一处：`resolver.ts:347` 的 touch 路径 `putSession`（由 `prepareCore` → `resolveSession` 调用，`openai.ts:539`）。KV 写配额耗尽时，这一处会抛到顶层 → **确实会变成 500**。

**修正**：P2-3 的严重性从"普遍 500"下调为"关键路径 1 处会 500 + 后台写入静默丢失"，但补一句文档没写的：后台静默丢失更危险，因为 `listResolverSessions` 的计数、`recordConversation` 的索引会在配额耗尽后**无声地停止更新**，而 `/api/health` 上看不到任何异常。

#### ⚠️ G：§3.1 的 `getSettings` 调用点枚举有误（总数 5 仍然正确）

文档列的是 `openai.ts:394 / 998 / 684`、`account.ts:440 / 136`。实际：

- `account.ts:136`（`concurrencyAvailable`）与 `account.ts:440`（`resolveAccount` 的 fallback 分支）**互斥**——`440` 只在"上一个健康账号不可用"时才执行，而 `136` 只在"preferred 账号存在"时才执行；
- 被漏掉的第五次是 **`openai.ts:768`（`chatCall`）**，它在每条路径上都会执行。

正确枚举：`394` → (`136` 或 `440`) → `684` → `998` → `768` = **5 次**。

#### ⚠️ H："194 个单元测试" 已过时

实测 `npx vitest run`：**23 个文件 / 204 个用例，全部通过**（耗时 4.97 s）。
关于"覆盖的是兜底路径"：**方向正确，但数字要更精确**——204 个用例中只有 `test/chat-messages.test.ts`（7 例）注入了 `DB`（且是自己 mock 的 `db`，不是真实 D1 语义）；其余 197 例全部跑的是 KV/无 DB 兜底路径。

#### ⚠️ I：§2.1 表 `settings` "读 5~6 次/请求" 与 §3.1 "典型 ~11 次 KV 读" 自洽性

我按典型路径（无 `session_key`、无 `body.user`、命中会话复用）复算，得到 **≈11 次**，与文档一致：
`getSettings`×5 + `lastHealthyAccountID` + `getConvCache` + `bindSession→getSession` + `recordConversation` 读索引 + `markCall` 读健康文档 + `updateThrottling` 读健康文档。
（文档把 `markCall`/`updateThrottling` 这两次读漏算了，同时把 `getSessionBinding` 算进去了——实际 `getSessionBinding` 只在传 `session_key` 时才发生。总数恰好抵消，结论可用。）

#### ⚠️ J：§5.8 的 O(n²) 说法需要加限定

`index.ts:327-333` 确实是 `text += dec.decode(...)`，但每次追加后立刻判定 `if (text.length >= cap) { text = text.slice(0, cap); truncated = true; }`，`text` 被钉在 256 KB。因此它是 **O(总字节 × 常数)** 而非无界 O(n²)；真实代价是"每个 chunk 都做一次 256 KB 的 slice + 字符串重建"，对大响应仍有明显 CPU 开销，建议仍按文档改数组 join，但理由应是"避免每 chunk 重建 256 KB 字符串"，不是"O(n²)"。

#### ⚠️ K：§5.13 "几乎必然超限" 措辞过强

CPU 10 ms 对 Cron 成立，但：
- CPU 不含 I/O 等待（外部 HTTP、D1 查询都不计）；
- `autoCleanupOnce` 在 `!anyDeleted` 时 `break`（`cleanup.ts:140`），通常 1~2 轮就退出，不会真的跑满 100 轮；
- `cleanup.ts:82` 已注释说明"Free plan allows ~50 per invocation"。

风险成立（CPU 10 ms 确实极紧），但应表述为"**在多轮删除 + 多账号刷新叠加时有较高超限概率**"，而非"几乎必然"。

---

## 三、修正后的免费层天花板

| 约束 | 配额 | 单次请求成本（实测修正后） | 天花板 | 是否绑定 |
|---|---|---|---|---|
| **KV 写入** | 1,000/天 | **6~7**（关键路径 1 + 后台 5~6） | **≈ 150~170 次聊天/天** | ⭐ **是** |
| KV 读取 | 100,000/天 | 11（典型）/ 85（最坏） | ≈ 9,000 / 1,176 次/天 | 否 |
| Workers 请求 | 100,000/天 | 1 | 100,000/天 | 否 |
| CPU | 10 ms/次 | 远超 | **单次即超限** | ⚠️ 结构性（无法用配额衡量） |
| D1 行读 | 5,000,000/天 | 最坏 3,000 | ≈ 1,600/天 | 否 |
| D1 行写 | 100,000/天 | ~7~9 | ≈ 11,000/天 | 否 |
| D1 库容量 | 500 MB | debug 开启时 ~512 KB/条 | **≈ 1,000 条调试记录** | ⚠️ debug 开启时是 |
| D1 查询数 | 50/次调用 | ~15~20 | 不绑定（余量 2.5×） | 否 |
| DO 请求 | 100,000/天 | 7~8 | ≈ 12,500/天 | 否 |
| DO 行写 | 100,000/天 | **10~16**（含 setAlarm） | ≈ 6,000~10,000/天 | 否 |
| **DO 时长** | 13,000 GB-s/天 | **CoordinationDO ≈ 0**（可休眠）；McpSessionDO = SSE 连接全程 | **不是基线风险** | ❌ **原判定错误** |
| 外部子请求 | 50/次调用 | 2~5（多工具轮次可到 ~10） | 不绑定 | 否 |

---

## 四、对原改进清单的修订建议

### 4.1 应当删除或改写的条目

| 原条目 | 处置 | 理由 |
|---|---|---|
| P1.2 `CoordinationDO` 分片（动机："消除单例常驻、省 83% 时长"） | **改动机、降优先级** | 时长论据不成立。真正动机只剩"单例热点 + DO 请求 100k/天上限"，而后者天花板 12,500/天，远高于 KV 的 150/天 → 从 P1 降到 P3 |
| P1.4 "去掉 `save()` 里无条件 `setAlarm`" | **删除** | 已经是条件式的（`coordination.ts:150`） |
| P0.2 中"迁 waitUntil" 的四项 | **改写** | 已在 waitUntil 中。改为"后台 KV 写从 5~6 次降到 ≤1 次"（迁 D1 / 合并 / 去掉非必要写） |
| P1.1 `McpSessionDO` 改 Hibernation | **保留，但提高改造成本预期** | 当前实现不是 WebSocket（是 `ReadableStream` 的 SSE），需要先做 SSE→WS 的协议改造，不是加一行 `acceptWebSocket()` |
| P2.3 "100 轮 → 1 轮 / 5 次" | 保留但降级 | 已有 `deleteBudget=30` 与提前 break，风险低于文档描述 |

### 4.2 必须新增的条目

| 优先级 | 动作 | 位置 | 说明 |
|---|---|---|---|
| **P0** | `markCall` / `updateThrottling` 补上 `if (ok) return;` 早退 | `account.ts:226`、`:235` | 直接省下 **2 次 KV 写 + 2 次 KV 读/请求**，天花板 150 → ~250；同时消除 DO 与 KV 的健康态双写不一致 |
| **P0** | `resolver.ts:347` touch 路径的 `putSession` 加 try/catch（或内容未变则跳过） | `pipeline/resolver.ts:106-110 / 347` | 这是**唯一**在关键路径上、会把 KV 配额错误变成用户 500 的写入 |
| **P1** | `putJSON` 返回 boolean 并内吞异常；热路径调用点按返回值决定是否告警 | `kv.ts:12` | 文档已提，但需补充：重点是**让后台写入失败可见**（计数/日志），而不是防 500 |
| **P1** | 统一健康态的写入归属：`markCall`/`updateThrottling` 未早退导致的"DO 已记账、KV 也记一份"要在降级路径上做一次对账，或明确只保留 DO | `pipeline/account.ts` | 否则 DO 失效时会从错误基线继续 cooldown |

### 4.3 保持不变的高价值条目

P0.1（`listResolverSessions` → `COUNT(*)`）、P0.3（`d1BackfillFromKV` 一次性闩锁 + `LIMIT 1`）、P0.4（`getSettings` 记忆化）、P0.6（debug 8 KB / 1 天）、P1.3（`/acquire` 去自旋）、P1.5（DO 调用合并）、P1.6（`accounts` 镜像关停或剥离 refreshToken）、P2.1（判别式 `ok|unbound|error`）、P2.2（dev 补 D1 绑定）、P2.4~P2.7 —— 经核对均与代码现状一致，建议原样保留。

---

## 五、复核未覆盖的部分

- 未做真实部署压测（无 Cloudflare 账号面板数据），所有"单次请求成本"均为**静态代码路径推算**，非实测；
- `src/api/responses.ts`、`src/api/anthropic.ts`、`src/admin/*` 的非聊天路径只做了抽样核对；
- 未验证 `McpSessionDO` 在真实 SSE 连接下的计费行为（官方文档只给出规则，实际以面板 Duration 指标为准）。

建议按文档 §八 的验证清单在桌面端跑一轮压测，并**新增两项观测**：
1. 打开 `logLevel=debug` 后，用面板确认 `account-health` 这一单个 key 的写入次数（预期 ≈ 2× 请求数，验证 C 项）；
2. 观察 `CoordinationDO` 的 **Duration (GB-s)** 指标——预期接近 0，若显著非零则说明存在未发现的阻止休眠因素（验证 A 项）。
