# B 部分「账号生命周期」逐项对齐核对报告

> 核对日期：2026-08-27
> 对照清单：docs/ALIGNMENT-CHECKLIST-non-model.md B 部分（B1–B8）
> 上游仓库：C:\Github Desktop\M365-Copilot2API-main（Go）
> Worker 仓库：C:\Github Desktop\M365-Copilot2API-on-Cloudflare-Worker（TS）
> 方法：逐项读取两端源码（上游 `internal/web/account_health.go`、`account_concurrency.go`、`server.go`、`internal/auth/cache.go`、`internal/chathub/client.go`、`images.go`；Worker `src/pipeline/account.ts`、`src/store/accounts.ts`、`src/do/coordination.ts`、`src/api/openai.ts`、`src/api/images.ts`、`src/admin/handlers.ts`、`src/errors.ts`、`src/index.ts`），核对清单声明的状态与检测要点是否与真实代码一致。
> 状态图例：✅ 对齐｜⚠️ 部分/简化｜❌ 未做｜[平台] Workers 限制｜[用户选择] 有意保留｜[死代码] 上游未使用

> **实施记录（同日追加）**：按本报告建议完成 B1/B2/B3/B6/B7 修复（2026-08-27，typecheck + 199 测试全绿）：
> - B1/B6：COORD 新增 `/next-healthy`（原子轮询 + 健康 + 并发预筛，返回 `lastReason` 区分冷却/并发满）+ `/semaphore/available`；`resolveAccount`/`nextHealthyAccount` 全冷却 Retry-After 动态 `EarliestRecovery`（≥5s），并发满 429 Retry-After 1。
> - B2：`concurrencyAvailable()` 补上（DO `/semaphore/available`；未绑定恒 true 保持 K4）；lastHealthy 偏好命中增加并发检查。
> - B3：`errors.ts` 新增 `classifyError`/`cooldownMsForCategory`/`circuitRecord`（上游 ClassifyError/CooldownForCategory/globalCircuit 移植）；DO 拥有 `quotaAttempts`（429 指数退避）与全局熔断（30s 窗口 ≥10 请求失败率 ≥50% → open 30s）；`markFailure` 全分类冷却（401=2min/403=24h/503=15s/传输类 15-30s/UPSTREAM_STRUCTURED=10s/UNKNOWN=min(rateLimitCooldown,30s)）；KV 兜底路径保留完整逻辑 + isolate 本地熔断；settings 新增 `rateLimitCooldownSeconds`（env `M365_RATE_LIMIT_COOLDOWN_SECONDS`，5-3600，I13）。
> - B7：`failoverChat` 成功/失败路径均 `markFailureAfterConfirm(原账号, firstErr)` + `markImageLimited`（对齐上游 server.go:1267/2059/2068）。
> - **B8（同日追加）**：MarkCall 移植（`chatCall`/流式主路径/images/admin chat 埋点；DO `/health/mark-call` + KV 兜底）；`imageLimited`/`authFailReason`/`throttling` 入 DO HealthEntry + KV HealthDoc；`/health/mark-success` 与 `reap` 对齐上游（imageLimited 保留至窗口、calls 仅限流恢复时清、throttling 常驻）；`/semaphore/snapshot`（并发数）；`handleAccountsList` 视图补 `callCount/rateLimited(limited 标志)/imageLimited/authFailed/authFailReason/throttling/concurrency`；token-health GET `expires_in` 改 Go duration 格式（`formatGoDuration`）。**B 部分 8 项至此全部对齐**。
> - 保留差异：B5 冷却窗口（至午夜 vs 24h）。

---

## 汇总（实施后）

| # | 功能点 | 清单原状态 | 实施后状态 | 关键差异 |
|---|--------|-----------|-----------|---------|
| B1 | 账号轮询 round-robin | ✅ | ✅（已修） | 并发预筛并入 DO `/next-healthy`、全冷却 Retry-After 动态 |
| B2 | lastHealthyAccount 偏好 | ✅ | ✅（已修） | 偏好命中补并发检查 |
| B3 | 健康/冷却 | ⚠️ 降级 | ✅（已修） | 全分类冷却 + 全局熔断 + quotaAttempts + 旋钮 |
| B4 | 限流确认探测 | ✅ | ✅ | 上游死代码确认，TS 按语义接线为增强 |
| B5 | 图片额度/内容策略标记 | ⚠️ | ⚠️（保留差异） | 冷却窗口：Worker 至 UTC 午夜，上游 24h 滚动 |
| B6 | 账号并发限制 | ⚠️ [用户选择] | ⚠️ [用户选择]（已修） | 并发满不进候选；未绑定仍不门控（K4）；上游阻塞排队 vs 15s 有界等待 |
| B7 | 故障转移 failover | ⚠️ 降级 | ✅（已修） | 原账号失败标记已补 |
| B8 | 账号 API | ⚠️ | ✅（已修） | MarkCall + 视图字段 + token-health 格式，B8 全对齐 |

| # | 功能点 | 清单原状态 | 核对后状态 | 关键差异 |
|---|--------|-----------|-----------|---------|
| B1 | 账号轮询 round-robin | ✅ | ✅（补 2 处细节） | 选号并发预筛缺失、全冷却 Retry-After 固定 5s |
| B2 | lastHealthyAccount 偏好 | ✅ | ✅（补 2 处细节） | KV 12h TTL（上游无 TTL）、偏好不含并发检查 |
| B3 | 健康/冷却 | ✅ | **⚠️ 降级** | 403=120s（上游 24h）、无指数退避、传输类/结构化错误不冷却、全局熔断缺失 |
| B4 | 限流确认探测 | ✅ | ✅ | 上游死代码确认，TS 按语义接线为增强 |
| B5 | 图片额度/内容策略标记 | ✅ | ⚠️（注明差异） | 冷却窗口：Worker 至 UTC 午夜，上游 24h 滚动 |
| B6 | 账号并发限制 | ⚠️ [用户选择] | ⚠️ [用户选择]（补差异） | 上游阻塞排队，Worker 15s 超时→429 |
| B7 | 故障转移 failover | ✅ | **⚠️ 降级** | **failover 成功后原账号不冷却（上游显式 MarkFailure）** |
| B8 | 账号 API | ✅ | ⚠️（端点全齐） | 视图字段缺失（imageLimited/authFailed/throttling 等）、callCount 恒 0、token-health 格式差异 |

**结论：B 部分 8 项中 4 项需从清单原状态降级/补充（B3、B5、B7、B8），B1/B2/B4 维持 ✅ 但补细节。没有新增 ❌ 项。**

---

## B1 账号轮询 round-robin — ✅（补 2 处细节）

**上游**：
- `internal/auth/cache.go:433-443` `Store.Next()`：`nextIdx % n`，`(nextIdx+1) % n`，进程内互斥锁。
- `internal/web/server.go:1054-1079` `resolveAccount("")`：先 lastHealthy，失败后循环 `tokens.Next()` 最多 `maxAccountProbe=16` 次（server.go:60），每轮检查 `s.accountAvailable(id)` = `ScheduleEnabled && accountPool.Available && accountConcurrency.Available`（account_concurrency.go:97-102）。
- 全部不可用时：429，`RetryAfter = time.Until(EarliestRecovery())`（动态，最小 5s）；并发全满：429 Retry-After 1s。

**Worker**：
- `src/store/accounts.ts:253-276` `nextAccount()`：优先 COORD `coordNextAccountID`（`src/do/coordination.ts:141-151`，DO 内原子游标）；未绑定回退独立 KV 键 `accounts-cursor`（`nextIdx`）。比上游更强：上游游标仅进程内，Worker 未绑定 COORD 时仍跨 isolate 一致。
- `src/pipeline/account.ts:162-203` `resolveAccount()`：`MAX_ACCOUNT_PROBE=16` 一致；循环内检查 `available(env, id)`（pool 健康）+ `scheduleEnabled`。

**差异**：
1. **选号并发预筛缺失**：上游 resolveAccount 循环同时检查 `accountConcurrency.Available`（并发满的账号会被跳过）；Worker 循环不检查并发（并发门控在 resolve 之后由 `acquireAccountSlot` 单独执行，openai.ts:674-716）。行为差异：上游全部并发满时选号阶段即 429「at their concurrency limit」Retry-After 1s；Worker 会选中并发满账号、由信号量返回同样的 429（Retry-After = max(1, retryAfterMs/1000) ≈ 1s）。判定点不同、语义相近。
2. **全冷却 Retry-After 固定**：上游 `retry = int(time.Until(earliestRecovery).Seconds())`（最小 5s，可到分钟级）；Worker 固定 `retryAfter = 5`（account.ts:195）。

---

## B2 lastHealthyAccount 偏好 — ✅（补 2 处细节）

**上游**：`server.go:158` 内存字段 `lastHealthyAccount`；`resolveAccount("")`（1041-1052）先查 `preferred != "" && accountAvailable && accountPool.Available && accountConcurrency.Available`，`EnsureValid` 成功即返回；`resolveAccount` 尾部（1082-1086）在 `EnsureValid` 成功时无条件更新 `lastHealthyAccount = accountID`（显式/轮询路径均更新）。

**Worker**：`src/pipeline/account.ts:38-54` `rememberHealthy` / `lastHealthyAccountID`：KV `account-last-healthy`（**12h TTL**）；resolveAccount 中轮询命中后（183）与显式账号（201）均 `rememberHealthy`，与上游"所有成功路径更新"一致。

**差异**：
1. **KV 12h TTL**：上游进程内存无 TTL；Worker KV 12h 过期后偏好失效，回退纯轮询。[平台] 合理裁剪（KV 无内存字段，需 TTL 防陈旧），行为弱化可接受。
2. **偏好检查不含并发**（同 B1）：上游 `preferred` 命中还需 `accountConcurrency.Available`；Worker 只查 `available()`（pool 健康）。

清单 B2 的「C4 已修：优先上次健康账号」确认属实。

---

## B3 健康/冷却 — ⚠️ 降级（清单原 ✅ 不准确）

**上游** `account_health.go:586-700` `MarkFailure` 全分类冷却（CooldownForCategory 241-299）：

| 分类 | 上游冷却 |
|------|---------|
| AUTH_EXPIRED_401 | 2min + authFail |
| FORBIDDEN_403（非 ErrorDisallowedAADUser） | **24h** + authFail |
| QUOTA_429 | limited + **指数退避** 30s·2^(attempt-1)（attempt 1–7，上限 30min；Retry-After 优先、上限 30min） |
| OVERLOAD_503 | 15s |
| USER_BANNED / USER_THROTTLED / INSUFFICIENT_TOKENS | 365 天 / 1h / 24h |
| RETRYABLE_422 | 5s |
| DESIGNER_DISABLED | 0（不冷却） |
| SOCKS5/DNS/TCP/TLS/WS_HANDSHAKE/WS_READ_TIMEOUT | 30/30/15/30/15/30s |
| UPSTREAM_STRUCTURED（empty/offensive/image limit） | 10s |
| CLIENT_CANCELED | 0 |
| GLOBAL_UNAVAILABLE / 全局熔断 | 15s；30s 窗口内 ≥10 请求且失败率 ≥50% → 全池 open 30s（301-397） |

`MarkSuccess`（702-733）保留 imageLimited/imageGenCooldown；持久化仅内存（进程内）。

**Worker** `src/pipeline/account.ts:76-93` `markFailure` 只处理两类：

```ts
if (isAuthFailureErr(err)) {            // status 401 或 403
  cooldown = min(RATE_LIMIT_COOLDOWN_MS*4, 120_000)  // 120s
  authFail = true
}
if (isRateLimitedErr(err)) {            // RateLimitNotice / 429 / 503 / body 含 "limited"
  limited = true
  cooldown = min(retryAfter*1000, 30min) 或固定 30s
}
// 其他错误：无 else 分支 → 不冷却
```

**逐点差异**：
1. **403 冷却 24h → 120s**：上游 403 应冷却 24h 并置 authFail；Worker 把 401/403 一视同仁 120s。
2. **QUOTA 指数退避缺失**：上游连续 429 冷却从 30s 指数涨到 30min（quotaAttempts 记忆）；Worker 固定 30s（除非上游 Retry-After）。
3. **503 冷却 15s → 30s**：`isRateLimitedErr` 把 503 并入 429 通道（上游 OVERLOAD_503 独立 15s）。
4. **传输类错误不冷却**：TCP/DNS/TLS/WS 超时/握手等上游 15–30s 冷却；Worker `markFailure` 静默返回。后果：账号长期不可达时（如微软侧故障）Worker 会每请求重试该账号，直到 resolveAccount 轮询到其他账号，无冷却缓解。
5. **UPSTREAM_STRUCTURED 不冷却**：empty completion / offensive（content policy）上游 10s 冷却；Worker 中 `isContentPolicyBlock` 分支虽显式 `markFailure(..., new Error("upstream content policy block"))`（openai.ts:1071-1072），但该 Error 无 status/name 特征，`isAuthFailureErr`/`isRateLimitedErr` 均 false → **实际不冷却**。
6. **全局熔断器缺失**：上游 30s 窗口失败率熔断全池；Worker 无对应机制。
7. **分类字段缺失**：`quotaAttempts`、`imageLimited`（独立 KV 有）、`imageGenCooldownUntil`、`imageGenSystemCooldown`、`lastThrottling`、`authFailReason`、`calls` 等健康文档字段大部分未落地（HealthDoc 仅 cooldown/authFail/limited/calls 4 字段，account.ts:14-19）。
8. **RateLimitCooldownSeconds 不可配置**：上游 settings.go:103 `M365_RATE_LIMIT_COOLDOWN_SECONDS`（默认 30、5–3600 校验）；Worker `RATE_LIMIT_COOLDOWN_MS` 硬编码 30s（与清单 I13 对应）。

**对齐项**：401 冷却 120s ✓（`RATE_LIMIT_COOLDOWN_MS*4` = 上游 2min）；429 Retry-After 优先 + 30min 上限 ✓；KV 持久化（account.ts）优于上游内存态 ✓；`markSuccess` 保留 imageLimited ✓。

**建议**：B3 降级为 ⚠️。若需收紧，优先补 ①403→24h ②429 指数退避（KV 增 quotaAttempts 字段）③传输类错误 15–30s 冷却 ④content policy 显式 10s 冷却。

---

## B4 限流确认探测 — ✅（上游死代码，TS 按语义接线为增强）

**上游**：`server.go:100-131` `confirmRateLimitNotice` 定义完整（30s 探测、tone=magic、`rateLimitProbePrompt = "Reply with exactly: OK"`、探测再限流→429 UpstreamHTTPError、其他错误→返回探测错误），但 grep 全库**无任何调用点**——确认死代码（与清单 B4 描述一致）。

**Worker**：`src/api/openai.ts:801-828` `markFailureAfterConfirm`：
- 非 RateLimitNotice → 直接 `markFailure`；
- RateLimitNotice → 独立 ChatHub 探测（30s 超时、tone "magic"、`RATE_LIMIT_PROBE_PROMPT = "Reply with exactly: OK"`）：
  - 探测成功 → `markSuccess`（假阳性不冷却）；
  - 探测也限流 → `markFailure(原错误)`（确认冷却）；
  - 探测其他错误 → `markFailure(探测错误)`。
- 接入三处失败路径：runCompletionsCore catch（1204）、streamChatCompletions catch（1665）、failoverChat 第二账号失败（855）。

与上游函数语义逐条一致，且是真实接线（上游为死代码）。✅ 维持。

---

## B5 图片额度/内容策略标记 — ⚠️（触发路径对齐，冷却窗口有差异）

**上游**：
- `account_health.go:484-493` `MarkImageLimited`：`imageLimited = true` + `cooldown = now + 24h`（**24h 滚动窗口**）。
- 触发点：`server.go:1268-1270 / 1277-1279 / 1286-1288 / 2060-2062 / 2069-2071 / 2073-2075` 共 6 处，均为 `errors.Is(err, chathub.ErrImageLimit)`（client.go:595/988/1031 产生）。
- `MarkImageGenTokensThrottled`（至 UTC 次日 0 点）/ `MarkImageGenSystemThrottled`（30min）/ `ImageGenAvailable`：grep 全库**无调用点，死代码**（清单 A7 之前未注明）。
- 图片生成端点 `images.go:122-124`：`isImageQuotaRefusal` → 429 + Retry-After 86400，**不标记账号**（Worker 同）。

**Worker**：
- `src/pipeline/account.ts:98-106` `markImageLimited`：`limited = true` + `cooldown = 次日 UTC 午夜`。
- 触发点：`openai.ts:1084-1086`（`imageLimitNotice(res.text)` 文本提示）与 `openai.ts:856`（failover 第二账号 `isImageLimited(e2)`）；`images.ts:209-212` quota → 429 + Retry-After 86400（与上游 images.go 一致，不标记账号）。

**差异**：**冷却窗口**——上游 `MarkImageLimited` 为 24h 滚动（下午 5 点触发 → 冷却到次日下午 5 点）；Worker 为至 UTC 午夜（下午 5 点触发 → 冷却 7h）。清单 A7 称"imageLimited 标记至午夜"实为 Worker 行为，上游是 24h。Worker 语义更贴合"每日配额"，属有意偏差，但需在清单注明。
**对齐项**：触发路径（chat 文本提示 + ErrImageLimit）✓；images 端点 429+Retry-After 86400 ✓；上游 imageGen 系列为死代码无需移植 ✓。

---

## B6 账号并发限制（默认 8）— ⚠️ [用户选择]（补充等待语义差异）

**上游** `account_concurrency.go`：
- 默认 8，`M365_ACCOUNT_DEFAULT_CONCURRENCY` 可配（22-30）；
- `Acquire`（41-73）：**阻塞等待** `changed` channel，直到拿到槽位或 ctx 取消——并发满时请求一直排队（无超时上限）。
- 在 `chatWithAccount / chatWithAccountEvents / chatWithAccountReasoning` 三处统一加锁（111-151）；resolveAccount 选号时跳过并发满账号（B1）。

**Worker**：
- `src/store/settings.ts:169` `accountConcurrencyLimit: 8`（校验 1–64，200 行），来自控制台 settings；
- `src/api/openai.ts:674-716` `acquireAccountSlot`：COORD 绑定 → `coordAcquireAccount`（DO 信号量，`maxWaitMs=15s` 默认，`src/do/coordination.ts:152-176`），15s 内满则 429 + Retry-After 1s；**未绑定 COORD → 静默不门控**（K4 [用户选择]）。
- 释放：`coordReleaseAccount`（openai.ts:1209 finally）。

**差异**：
1. **等待语义**：上游阻塞排队（请求挂起直到有槽位）；Worker 15s 有界等待后 429。高并发下上游表现为慢而成功、Worker 表现为快速 429。
2. **选号预筛**（同 B1）：上游并发满账号不会进入候选，排队自然分散；Worker 会选中并发满账号再 429。
3. 默认值 8 与范围校验一致 ✓；未绑定降级为清单已确认的 [用户选择] ✓。

---

## B7 故障转移 failover — ⚠️ 降级（发现实质差异：原账号不冷却）

**上游**：
- 非流式 `server.go:1248-1283`：条件 `AccountID=="" && ConversationID=="" && (IsRateLimited || IsAuthFailure)`；**成功分支显式 `s.accountPool.MarkFailure(acc.ID, originalErr, ...)`（1267）+ ErrImageLimit→MarkImageLimited（1268-1270）+ `MarkSuccess(next.ID)`（1271）**；失败分支 `MarkFailure(next.ID, err2)`（1276），返回 err2。
- 流式 `server.go:2007-2077`：守卫 `text.Len()==0 && len(streamedTools)==0 && !convReused && AccountID=="" && (ConversationID=="" || ==resolved) && (IsRateLimited || IsAuthFailure)`；成功/失败分支同样**都显式 MarkFailure(acc.ID, originalErr)**（2059-2062 / 2068-2071）；resolver 绑定会话清除（2012-2014）。
- 其他流式变体（2200-2211 / 2363-2386 / 2480-2504）同模式。

**Worker**：
- `canFailover`（openai.ts:783-789）：`accountID 空 && conversationID 非用户绑定 && (isRateLimited || isAuthFailure)` ✓；
- 流式守卫 `!emittedAny`（1523）≈ 上游 `text.Len()==0 && streamedTools==0`；`convReused` 对应项由 canFailover 的 conversationID 判断覆盖 ✓；
- resolver 绑定会话清除：`failoverPrepared`（846-849）✓；
- 第二账号错误：`markFailureAfterConfirm(next, e2)` + `isImageLimited → markImageLimited`，throw e2（855-857）✓；
- **但 `failoverChat`（830-859）成功路径只 `markSuccess(next.id)`，没有对失败账号（failedAcc）做 `markFailure`**；外层 catch（1203-1206）中 `acc` 已被替换为 next，`markFailureAfterConfirm(ctx, acc, err)` 标记的是**新账号**（err 为 null 时不执行，成功路径根本不进 catch）。

**后果**：Worker 因限流/鉴权失败的账号在 failover 成功后**永不冷却**。失败账号仍留在池中（且通常是 lastHealthy，因 resolveAccount 选择时已 `rememberHealthy`），下次请求优先命中它 → 再次失败 → 再次 failover。上游则通过显式 MarkFailure 让原账号冷却，避免重复踩坑。**每次失败多一次 ChatHub 往返 + 延迟**。

**建议**：`failoverChat` 在成功路径补 `markFailureAfterConfirm(ctx, failedAcc, firstErr)`（与上游 1267/2059 对齐；注意 ErrImageLimit 时补 markImageLimited）。流式路径同源修复（failoverChat 是共用函数）。

---

## B8 账号 API — ⚠️（端点全齐，响应字段显著简化）

**端点覆盖对比**（上游 server.go:347-354 vs Worker index.ts:46-52 + handlers.ts）：

| 端点 | 上游 | Worker | 状态 |
|------|------|--------|------|
| GET /api/accounts | accounts（server.go:649-708） | handleAccountsList（handlers.ts:392-422） | ⚠️ 字段缺失 |
| POST /api/accounts/refresh | refreshAccount（710-731） | handleAccountRefresh（424-452） | ✅ 语义一致 |
| POST /api/accounts/schedule | scheduleAccount（733-751） | handleAccountSchedule（454-471） | ✅ |
| GET/POST /api/accounts/token-health | tokenHealth（753-789） | handleTokenHealth（473-496） | ⚠️ GET expires_in 格式差异 |
| POST /api/accounts/clear-cooldown | clearCooldown（791-798） | handleClearCooldown（498-504） | ✅ |
| POST /api/accounts/delete | deleteAccount（800-817） | handleDeleteAccount（506-520） | ✅（失败语义弱化，见下） |
| POST /api/accounts/provision | provisionAccount（819-850，需 admin session） | handleProvisionAccount（522-554） | ✅（鉴权在全局 authorize，index.ts:169） |
| POST /api/accounts/bind-proxy | bindProxy（852+） | —（代理池已移除） | [平台] J1 |

**鉴权核对**：上游 `adminMiddleware`（server.go:393-421）包裹所有非 /v1/ 非 exempt 路径，`/api/accounts/*` 全部要求 admin session（provision 另有 handler 内重复检查）；Worker `authorize()`（index.ts:146-184）同样要求 admin session。**两端一致，无安全差异**（初查时疑 provision 缺鉴权，实为全局中间件覆盖）。

**字段差异（GET /api/accounts）**：
1. `callCount` 恒 0（清单已注明）：根因是 Worker 无 `MarkCall` 调用点（上游 `chatWithAccount` 里 `accountPool.MarkCall`，account_concurrency.go:118/132/146）。与并发限制器无直接关系（清单表述"随并发限制器省略"不准确，实际是调用计数未移植）。
2. **缺失字段**：`imageLimited`、`authFailed`、`authFailReason`、`throttling`、`concurrency`、`boundProxy`（后者随代理池删除）。根因：`healthSnapshot`（account.ts:121-136）只输出 `available/cooldownUntil/authFailed` 3 个键，且 handler 未回填 imageLimited/authFailed 到账号视图。
3. **rateLimited 推断不同**：上游读 `accountPool.RateLimited(id)`（limited 标志）；Worker `rateLimited: !!(h && h["authFailed"] !== true && status === "cooldown")`——用 cooldown 状态反推，authFail 时会被排除，语义近似但不精确。
4. **token-health GET expires_in**：上游 `ExpiresAt.Sub(now).Truncate(time.Second).String()`（如 `1h2m3s`，Go duration 格式）；Worker `${Math.floor((expiresAtMs - now) / 1000)}s`（纯秒数）。字段存在但格式不同。
5. **delete 失败语义**：上游 `Store.Delete` 失败返回 500 internal_error；Worker `deleteAccount` 无失败返回路径，恒 200 deleted（KV/D1 delete 不报错）。轻微。

---

## 建议回写 ALIGNMENT-CHECKLIST-non-model.md（B 部分）

| 行 | 修改 |
|----|------|
| B1 | 保持 ✅，检测要点补：选号无并发预筛（并发门控在 resolve 后单独执行）、全冷却 Retry-After 固定 5s |
| B2 | 保持 ✅，检测要点补：KV 12h TTL（上游内存无 TTL）、偏好不含并发检查 |
| B3 | **✅ → ⚠️**，检测要点改为：401=120s✓、429 Retry-After 优先+30min 上限✓，但 403=120s（上游 24h）、429 无指数退避（固定 30s）、传输类/UPSTREAM_STRUCTURED 错误不冷却、全局熔断缺失、RateLimitCooldownSeconds 不可配置（I13） |
| B4 | 保持 ✅（上游死代码确认 + TS 按语义接线） |
| B5 | ✅ → ⚠️，检测要点补：触发路径✓，但冷却窗口差异——Worker 至 UTC 午夜 vs 上游 24h 滚动；上游 imageGen 三函数死代码无需移植 |
| B6 | 保持 ⚠️ [用户选择]，检测要点补：上游阻塞排队 vs Worker 15s 有界等待后 429 |
| B7 | **✅ → ⚠️**，检测要点改为：结构对齐（守卫/会话清除/第二账号错误✓），但 **failover 成功后原账号未冷却**（上游显式 MarkFailure acc.ID），建议修复 |
| B8 | ✅ → ⚠️，检测要点改为：端点全齐✓、admin 鉴权两端一致✓，但视图缺 imageLimited/authFailed/authFailReason/throttling/concurrency、callCount 恒 0（MarkCall 未移植）、rateLimited 用 cooldown 反推、token-health GET expires_in 格式差异 |
| L1/L2 检测建议 | 新增高优先级：B7 failover 原账号冷却；中优先级：B3 403/指数退避/传输错误冷却 |

---

## 附：核对中确认无误的清单声明

- B4「上游该函数为死代码」：grep `confirmRateLimitNotice` 仅定义无调用 → 属实。
- B6「COORD 未绑定静默不门控」：`acquireAccountSlot` 中 `slot==null → { ok: true, acc }`（openai.ts:684）→ 属实，对应 K4。
- B8「callCount 恒 0」：属实，根因为 MarkCall 未移植。
- J1「代理池已删除」：`/api/accounts/bind-proxy` 与账号 `boundProxy` 字段均不存在 → 属实。
- 上游账号相关全部端点经 `adminMiddleware` 保护，Worker `authorize()` 同构 → 两端鉴权口径一致。
