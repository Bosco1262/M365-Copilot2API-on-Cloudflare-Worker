# Cloudflare 存储使用审查报告

> 仓库：M365-Copilot2API-on-Cloudflare-Worker  
> 审查范围：`wrangler.jsonc` / `wrangler.dev.jsonc` 绑定、`src/store/*`、`src/pipeline/*`、`src/do/*`、`src/admin/*`、`migrations/*.sql`  
> 日期：2026-08-27

---

## 一、存储清单

### 1.1 KV 命名空间（仅 1 个）

| 项目           | 值                                                                      |
| ------------ | ---------------------------------------------------------------------- |
| 绑定名          | `m365-copilot2api_KV`                                                  |
| Namespace ID | `6523e62855e040b8b7ce602c15a50012`（dev 配置用模拟 id `local-dev-namespace`） |
| 用途           | 全部业务状态 + 缓存 + 旧版兜底存储（单命名空间多前缀混用）                                       |

实际 key 清单（17 类）：

| #  | Key 模式                                                           | 存储内容                                                                   | 数据结构                                       | 数据量                      | 读写模式                                                  | 代码位置                               |
| -- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------ | ----------------------------------------------------- | ---------------------------------- |
| 1  | `accounts`                                                       | M365 账号池：access/refresh token、oid/tid、状态、调度开关                          | 单文档 JSON（AccountsDoc：accounts[] + nextIdx） | 个位数～几十个账号                | **读多写中**：每请求读；每次 token 刷新/账号增删/RMW 写                  | `store/accounts.ts`                |
| 2  | `api-keys`                                                       | 网关 API key（SHA-256 hash、名称、撤销标志、lastUsedAt）                            | 单文档 JSON（keys[]）                           | 极少（个位数）                  | **读高频 + 写高频**：`validKey()` 每次鉴权读整文档并**回写 lastUsedAt** | `store/keys.ts`                    |
| 3  | `resolver-sessions`                                              | 内容指纹会话解析器：最多 1000 个会话，每会话含 `contextHistory`（最多 512 条完整消息）              | 单文档 JSON 数组                                | **潜在数 MB**（1000×512 条消息） | **读写均高频**：每个 `/v1/*` 聊天请求 resolve+bind 各一次整文档 RMW     | `pipeline/resolver.ts`             |
| 4  | `sessions`                                                       | 会话绑定（sessionId → conversationId 映射）                                    | 单文档 JSON（Record）                           | 百级                       | 每请求成功路径 RMW                                           | `store/conversations.ts`           |
| 5  | `conversations`                                                  | 本地会话索引（id、标题、updatedAt），上限 500 条                                       | 单文档 JSON 数组                                | ≤500                     | 每请求成功路径 RMW                                           | `store/conversations.ts`           |
| 6  | `account-health`                                                 | 账号健康：cooldown/authFail/limited 映射                                      | 单文档 JSON                                   | 小                        | 读多（每次账号选择读）写少（仅失败/恢复时写），RMW                           | `pipeline/account.ts`              |
| 7  | `settings`                                                       | 运行时设置：模型映射、并发上限、feature flags 等                                        | 单文档 JSON                                   | 小（几 KB）                  | **读高频写极少**（仅控制台保存时写）——KV 理想用法                         | `store/settings.ts`                |
| 8  | `admin-password-hash`                                            | 管理员密码 SHA-256                                                          | 单字符串                                       | 极小                       | 读少写极少                                                 | `store/admin.ts`                   |
| 9  | `admin-sessions`                                                 | 管理员会话 token → 过期时间，上限 4096，TTL 24h                                     | 单文档 JSON（Record）                           | 小                        | 管理请求读、登录写                                             | `store/admin.ts`                   |
| 10 | `cache-stats`                                                    | 缓存命中统计（全局 + 每 key）                                                     | 单文档 JSON                                   | 小                        | **每请求 RMW**（read-modify-write）                        | `store/cacheStats.ts`              |
| 11 | `user_sessions`                                                  | API-key+user → 会话绑定，TTL 7 天自剪                                          | 单文档 JSON（Record）                           | 中                        | 每请求 RMW                                               | `admin/extras.ts`                  |
| 12 | `convcache:<keyHash>\|<account>\|<model>`                        | 会话增量发送缓存（指向云会话），TTL 2h                                                 | 每 key 一个小 JSON                             | key 数 = key×账号×模型        | 读高频写中（独立 key，天然分片）——KV 合理用法                           | `store/convCache.ts`               |
| 13 | `resp-history/<tenant>/<responseId>`                             | Responses API 回放历史，TTL 1h                                              | 每 key 一个 JSON                              | 中                        | 读少写中（独立 key + TTL）——合理                                | `api/responses.ts`                 |
| 14 | `img/<fileId>`                                                   | 生成图片 base64，TTL                                                        | 每 key 一个 base64 串                          | 单值可达数 MB                 | 写一次读一次，TTL 自动过期                                       | `api/images.ts`                    |
| 15 | `pkce/<state>`                                                   | OAuth PKCE 待决状态，TTL 600s                                               | 每 key 一个小 JSON                             | 极小                       | 一次性读写——合理                                             | `auth/oauth.ts`                    |
| 16 | `plugins_cache:<accountId>`                                      | substrate 插件列表 5 分钟缓存                                                  | 每 key 一个 JSON                              | 小                        | 读多写少——合理                                              | `admin/extras.ts`                  |
| 17 | `usage/<yyyyMMdd>` + `dbg:index` + `dbg:<id>` + `conv_whitelist` | **旧版兜底**：无 D1 绑定时的用量日桶（TTL 90d，桶上限 5000 条）、调试环形缓冲（500 条，TTL 48h）、会话白名单 | 日桶数组 / 索引数组 / 单记录                          | 中                        | 仅在 `env.DB` 缺失时走此路径；whitelist 偶尔写                     | `store/usage.ts`、`admin/extras.ts` |

### 1.2 D1 数据库（仅 1 个）

| 项目          | 值                                        |
| ----------- | ---------------------------------------- |
| 绑定名 / 库名    | `DB` / `m365-copilot2api`                |
| Database ID | `1257ab3c-b740-4324-b286-a3bd8f3b2962`   |
| 迁移          | `0001_init.sql`、`0002_chat_messages.sql` |



| 表               | 用途                 | 结构                                                      | 数据量                      | 读写模式                                        | 索引                                                 |
| --------------- | ------------------ | ------------------------------------------------------- | ------------------------ | ------------------------------------------- | -------------------------------------------------- |
| `usage_events`  | 用量事件（每次 API 调用一条）  | id PK 自增、ts、api_key_prefix、model、json（完整记录 blob）        | 90 天保留，随流量线性增长           | **高频写入**（每请求 INSERT，多经 `waitUntil`）+ 控制台批量读 | `idx_usage_ts(ts)`、`idx_usage_key(api_key_prefix)` |
| `debug_records` | 请求调试记录（脱敏后的请求/响应体） | id PK、at、path、method、status、level、duration_ms、json blob | 7 天保留                    | 高频写 + 列表/详情读                                | `idx_debug_at(at)`                                 |
| `chat_messages` | 会话明细回放（用户+助手逐轮落库）  | PK(conversation_id, seq)、role、content、created_at        | 7 天保留，content 上限 900KB/行 | 中频写（每轮 2 行 batch）+ 按会话读                     | PK + `idx_chat_messages_created(created_at)`       |

### 1.3 Durable Objects（2 个类，均 SQLite-backed）

| 绑定        | 类                | 实例粒度                             | 用途                                                                    | 存储                                                       |
| --------- | ---------------- | -------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `MCP_HUB` | `McpSessionDO`   | 每会话一个                            | MCP SSE 跨 isolate 消息信箱（`/attach` 建立 SSE 流、`/push` 投递帧）                | **纯内存** Map，无持久化，随断连消亡                                   |
| `COORD`   | `CoordinationDO` | 单例 `idFromName("gateway-coord")` | 全局协调：管理员登录失败锁定（5 次/15 分钟）、账号轮询游标、每账号并发信号量（含 15 分钟陈旧租约回收）、token 刷新命名互斥 | 单 key `state` 存整个 CoordState JSON，每次操作整体重写；配 alarm 做过期回收 |

---

## 二、合理性分析

### 2.1 总体判断

**架构分层方向正确**：D1 承接高频追加型事件（usage/debug/messages），DO 承接跨 isolate 原子协调，KV 承接读多写少配置。代码还内置了 `if (env.DB) … else KV` 的优雅降级路径。但**热路径上存在多处"整文档 RMW + 每请求写 KV"的反模式**，在流量上升后同时构成性能、成本与正确性三重风险。

### 2.2 热路径每请求存储操作实测

一个 `/v1/chat/completions` 成功请求约产生：

| 存储        | 操作                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| KV 读 ×~9  | api-keys、resolver-sessions、convcache、conversations、sessions、user_sessions、cache-stats、accounts、account-health |
| KV 写 ×~7  | api-keys(lastUsedAt)、resolver-sessions、conversations、sessions、user_sessions、cache-stats、convcache             |
| D1 写 ×3~5 | usage INSERT、debug INSERT + **每次附带一条 DELETE 清扫**、chat_messages×2                                              |
| DO ×1~3   | next-account、acquire/release                                                                                  |

### 2.3 逐项问题

#### 问题 A（高）：`resolver-sessions` 单文档存全量上下文 — KV 最严重的误用

- **数据特性冲突**：该文档最多 1000 会话 × 每会话 512 条完整消息，可达数 MB；KV 单值上限 25MB，逼近时有全量覆写放大（每次写整个文档）。
- **一致性/并发缺陷**：`resolveSession`/`bindSession` 均为 read-modify-write，两个并发请求后写者覆盖先写者 → **会话静默丢失**（表现为用户上下文突然"失忆"）。KV 无任何原子写原语可救。
- **成本**：每请求一次大值读 + 一次大值写；KV 写按百万次计费（$5/百万，付费档），日请求量大时成本与延迟同步恶化。

#### 问题 B（高）：`api-keys` 每请求回写 lastUsedAt + 撤销的最终一致窗口

- `validKey()` 鉴权通过后**同步写 KV 更新 lastUsedAt**——纯粹为统计信息付出一次热路径写。
- KV 为最终一致（全球传播最长 ~60s）：**撤销的 key 在传播窗口内依然有效**。鉴权数据本质上需要读己之写/强一致语义。
- 整文档 RMW 并发下 lastUsedAt 互相覆盖（可接受，但证明该字段放错了层）。

#### 问题 C（高）：`accounts` 单文档 RMW 与单次性 refresh token

- AAD refresh token 是**单次性**的；token 刷新结果写回 `accounts` 整文档。虽然 CoordinationDO 的互斥锁避免了"两个 isolate 同时兑换"，但最终 `upsertAccount` 的整文档 put 仍可能与其他写者（`markStatus`、`setScheduleEnabled`、轮询回退写 `nextIdx`）**交错导致丢更新**——丢的是新 refresh token 时该账号即永久失效，只能重新登录。
- token 是安全敏感数据，塞在与低价值统计（`nextIdx`、status）同一文档里，放大了写冲突面。

#### 问题 D（中）：D1 `debug_records` 每次插入都执行 DELETE 清扫

`captureDebugRecord` 在每次记录后运行 `DELETE FROM debug_records WHERE at < datetime('now','-7 days')`。`idx_debug_at` 使该语句本身不贵，但属于**每请求一次的冗余写事务**，与已有的 30 分钟 cron 重复——应只在 cron 中清扫（chat_messages 已经是这么做的）。

#### 问题 E（中）：`usageLogs` 分页在 JS 中完成

`loadWindow` 拉取最长 90 天、LIMIT 50000 行并在 Worker 内做切片分页与聚合。行数增长后每次翻页都是全量扫描 + JSON.parse。应将 `LIMIT/OFFSET/ORDER BY ts DESC` 下推到 SQL（`idx_usage_ts` 已存在，可用），聚合类看板可再加每日汇总。

#### 问题 F（中）：`cache-stats` / `user_sessions` 每请求 RMW

纯统计型数据放在请求关键路径上做读-改-写，并发下计数丢失（统计用途可容忍），但白白增加每请求 4 次 KV 操作。应移入 `waitUntil` 或改 D1 `UPDATE … SET x = x + 1` 原子自增。

#### 问题 G（低）：DO 职责评估 — 结论：合理，无需下沉

- `McpSessionDO`：纯内存 SSE 信箱，无状态落盘，断连即回收——KV/D1 均无法实现跨 isolate 的实时帧投递，**无可替代**。
- `CoordinationDO`：轮询游标、信号量、登录锁定、刷新互斥全部需要**跨 isolate 原子性**，KV 做不到（无 CAS），D1 做得到但延迟更高且要为每次 acquire/release 付查询开销。单例 DO 是正确且最便宜的选择。可优化点：目前每次操作把整个 state JSON 单 key 重写（含 failures 历史表），SQLite-backed DO 更优写法是**按 key 分行存储**（`storage.put("sem:"+account, …)`），减少写放大——数据量小，属于锦上添花。
- 回退设计（DO 未绑定时自动降级为 isolate 内行为）进一步降低了对 DO 的硬依赖。

#### 问题 H（低）：冗余存储盘点

| 数据    | 存储处                                                                        | 是否真冗余                                                                                           |
| ----- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 会话上下文 | `resolver-sessions`(contextHistory)、`convcache:*`、D1 `chat_messages`、上游云会话 | **分层设计**：resolver 用于前缀匹配（必须）、convcache 是纯加速缓存（miss 可回退）、chat_messages 是控制台回放。语义不同，非冗余；但三者都在热路径写 |
| 会话绑定  | `sessions`(SessionBinding)、`resolver-sessions`、`user_sessions`             | **轻度冗余**：三套绑定可整合为一套（resolver 已覆盖 sessions 的功能），`sessions` 是移植早期的过渡产物                            |
| 用量数据  | D1 `usage_events` + KV `usage/*` 日桶                                        | 非并发冗余：后者仅是无 D1 绑定时的兜底 + 一次性回填源                                                                  |
| 调试记录  | D1 + KV 环形缓冲                                                               | 同上，兜底路径                                                                                         |

#### 问题 I（低）：KV 中恰当的部分

`settings`（读高频写极少）、`convcache:*`/`resp-history/*`/`plugins_cache:*`（独立 key + TTL）、`pkce/*`（一次性短 TTL）、`img/*`（写一次读一次 + TTL）、`account-health`（advisory 状态、丢失可容忍）均符合 KV 的设计意图，**无需迁移**。`img/*` 若单图接近 KV 25MB 上限才考虑 R2；当前有 `MAX_GENERATED_IMAGE_BYTES` 上限保护，暂不必动。

### 2.4 D1 索引检查结论

| 高频查询                                                   | 走的索引                      | 结论                              |
| ------------------------------------------------------ | ------------------------- | ------------------------------- |
| `usage_events WHERE ts >= ? ORDER BY ts`               | idx_usage_ts              | ✅ 覆盖                            |
| `usage_events`（按 api_key_prefix 过滤）                    | idx_usage_key             | ✅（当前代码未按 key 下推过滤，聚合在 JS，见问题 E） |
| `debug_records ORDER BY at DESC LIMIT 500`             | idx_debug_at              | ✅                               |
| `debug_records WHERE id = ?`                           | 主键                        | ✅                               |
| `chat_messages WHERE conversation_id = ? ORDER BY seq` | PK 前缀                     | ✅                               |
| `chat_messages WHERE created_at < ?`（cron 清扫）          | idx_chat_messages_created | ✅                               |
| `usage_events.model`                                   | 无索引                       | ✅ 无查询按 model 单独过滤，不需要           |

**D1 索引现状无缺口**；缺口在查询写法（问题 E）而非索引。

---

## 三、改进计划

总体策略沿用仓库已有的成熟模式：**`if (env.DB) 走新路径 else 走旧 KV 路径` 双写过渡 + 一次性回填端点 + 回滚即摘除绑定**。

### 3.1 迁移项与优先级

| 优先级      | 迁移项                                      | 目标存储                                                                                                                                                                                   | 理由                                                           | 预期收益                                      |                 |
| -------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- | --------------- |
| **P0-1** | `resolver-sessions` 拆分                   | KV 独立 key `resolver/<sessionId>`（TTL 2h）+ 轻量索引 key `resolver-index`（只存 sessionId→lastUsedAt 摘要，用于前缀匹配扫描与列表）                                                                            | 消除数 MB 级整文档热路径 RMW；并发丢会话从"结构性必然"降为"不可能"（每会话独立写）              | 每请求 KV 传输量从 MB 级降到 KB 级；写放大消失；会话失忆 bug 根除 |                 |
| **P0-2** | `api-keys` → D1 表                        | `api_keys(hash TEXT PRIMARY KEY, id, name, prefix, created_at, last_used_at, revoked INTEGER)`                                                                                         | 鉴权需要强一致（撤销立即生效）；lastUsedAt 改为 `waitUntil` 中节流更新（距上次 >60s 才写） | 撤销即时生效；热路径每请求省 1 次 KV 写；哈希点查 O(log n)     |                 |
| **P1-1** | `accounts` → D1 表                        | `accounts(id TEXT PRIMARY KEY, email, tokens JSON, status, schedule_disabled, updated_at)`，token 刷新用 `UPDATE accounts SET tokens = ? WHERE id = ? AND updated_at = ?`（乐观锁）或直接整行 UPDATE | 单次性 refresh token 丢失 = 账号报废，必须原子写；行级更新天然消除跨字段写冲突             | 账号因竞态失效的风险归零；`nextIdx` 顺带从该文档移除（已在 DO）    |                 |
| **P1-2** | `debug_records` 清扫移出请求路径                 | 保持在 D1，DELETE 移到 30 分钟 cron                                                                                                                                                            | 与 chat_messages 清扫模式对齐                                       | 每请求省 1 个 D1 写事务                           |                 |
| **P2-1** | `cache-stats`、`user_sessions`            | cache-stats → `waitUntil` 内写（或 D1 `UPDATE … x=x+1`）；user_sessions → 独立 KV key \`usess/<keyHash>                                                                                        | <user>\` + TTL 7d                                            | 统计脱离关键路径；独立 key 消除 RMW                    | 每请求热路径省 2 读 2 写 |
| **P2-2** | `usageLogs` SQL 化                        | 下推 LIMIT/OFFSET + ORDER BY ts DESC；看板聚合可选每日汇总表 `usage_daily`                                                                                                                           | 消除 50k 行 JS 全量扫描                                             | 控制台翻页延迟从秒级到毫秒级                            |                 |
| **P3**   | 合并 `sessions`(SessionBinding) 进 resolver | 删除一套绑定存储                                                                                                                                                                               | 功能已被 resolver-sessions 覆盖                                    | 减少每请求 1 读 1 写与一套心智负担                      |                 |

**不建议迁移**（保持现状）：`settings`、`convcache:*`、`resp-history/*`、`pkce/*`、`plugins_cache:*`、`img/*`、`account-health`（KV 特性匹配）；两个 DO（职责不可替代）；`conversations` 索引文档（≤500 条、量小，迁移收益低，P3 顺带处理即可）。

### 3.2 实施顺序与兼容/回滚策略

统一采用仓库已验证的降级框架，每步独立可发布、可回滚：

1. **P0-1（resolver 拆 key）**
   - 兼容：读取时先查新 key，miss 再读旧文档并回填新 key；写入只写新 key。上线后旧文档自然过期（TTL 2h，无需清理任务）。
   - 回滚：revert 部署即回到旧文档路径（2h 窗口内新写入的会话丢失，可接受——本来就是缓存语义）。
2. **P0-2（api-keys → D1）**
   - 兼容：鉴权读 D1，miss 时回退读 KV `api-keys`；`validKey` 的 lastUsedAt 写入改为 `ctx.waitUntil` + 60s 节流。控制台增删改双写 KV 与 D1 一个发布周期。
   - 回填：仿照现有 `handleUsageKvBackfill`，加一个 `POST /api/keys/backfill` 管理端点一次性导入。
   - 回滚：去掉 D1 分支即回 KV 路径；期间双写保证两边数据都在。
3. **P1-1（accounts → D1）**
   - 兼容：读 D1 优先、KV 兜底；所有写路径（upsert/delete/refresh/schedule）先写 D1 成功再镜像写 KV。刷新流程在读到 D1 行后用乐观锁条件 UPDATE。
   - 回滚：KV 镜像一直在，revert 即回退，最多丢最后一次 token 刷新（重新登录可恢复）。
4. **P1-2 / P2 / P3**：均为行为不变的等价重构，单发布 + revert 即回滚，无数据迁移。

**回滚总闸门**：所有新路径沿用现有 `env.DB` 判空——删除 D1 绑定（或 revert 代码）即整体退回 KV 行为，这是仓库已内建的安全网。

### 3.3 迁移后预期收益

| 维度             | 现状                                        | 迁移后                                                               |
| -------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| 每请求 KV 写       | ~7 次（含 1 次潜在 MB 级大值写）                     | ~1–2 次（convcache + 节流后的 lastUsedAt）                               |
| 每请求 KV 读       | ~9 次                                      | ~4–5 次（resolver 命中时仅读单会话 key）                                     |
| 每请求 D1 写       | 3–5 个事务                                   | 2–3 个事务（清扫移出 + 统计入 waitUntil）                                     |
| 正确性            | 会话并发丢失、refresh token 竞态报废账号、key 撤销 60s 窗口 | 三者全部消除（独立 key / 行级原子更新 / 强一致读）                                    |
| 成本（估算，1M 请求/月） | KV 写 ~700 万次 ≈ $35/月（付费档单价）+ 大值写带宽        | KV 写降至 ~150 万次 ≈ $7.5/月，**约省 75–80%**；免费档下则主要是避开每日 1000 次写限额的提前耗尽 |
| 延迟             | resolver 大文档读写随会话数增长（数十至数百 ms 抖动）         | 单 key 点查，稳定个位数 ms                                                 |
| 控制台            | 用量翻页全量拉取                                  | SQL 分页，毫秒级                                                        |

### 3.4 结论

- **DO 层：合理**（两个 DO 均承担 KV/D1 无法以更低成本完成的原子协调与实时投递职责，且有降级路径）。
- **D1 层：结构合理、索引无缺口**，仅两处查询/事务写法需要修正（问题 D、E）。
- **KV 层：混入了三类不该由它承载的数据**——需要强一致的鉴权数据（api-keys）、需要原子更新的高价值状态（accounts 的单次性 token）、高频 RMW 的大文档（resolver-sessions）。按 P0→P3 顺序迁移后，KV 将回归"读多写少 + TTL 缓存"的本职，性能、成本与正确性同时受益。

---

## 四、实施记录（2026-08-27）

上述改进计划已全部实施完毕，`tsc --noEmit`、166 个单元测试、i18n 检查与 `wrangler deploy --dry-run` 均通过。

| 项 | 状态 | 实现方式 | 涉及文件 |
|---|---|---|---|
| P0-1 resolver 拆 key | ✅ | 会话存 `resolver/<sessionId>`（TTL 2h），轻量 `resolver-index` 只存摘要；touch 路径 5 分钟节流，单次 resolve 最多读 24 个候选会话；旧文档首载时懒迁移并删除 | `src/pipeline/resolver.ts` |
| P0-2 api-keys → D1 | ✅ | `api_keys` 表 hash 点查，撤销即时生效；lastUsedAt 每 key 每分钟最多写一次且经 `ctx.waitUntil` 后台执行；KV 文档双写镜像 + 空表时懒回填（替代原计划的手动回填端点，运维更简单） | `src/store/keys.ts`、`src/api/auth.ts`、`migrations/0003_storage_audit.sql` |
| P1-1 accounts → D1 | ✅ | `accounts` 表行级写入；token 刷新用 `WHERE id=? AND updated_at=?` 条件 UPDATE + 一次重试（乐观锁）；`markStatus`/`setScheduleEnabled`/`updateRefreshToken` 均为列级 UPDATE，不会覆写 token 列；KV 文档镜像 + 懒回填；无 DO 时的轮询游标移至独立小 key `accounts-cursor`（首转继承旧 nextIdx） | `src/store/accounts.ts` |
| P1-2 debug 清扫移 cron | ✅ | 每次插入附带的 DELETE 移除，清扫统一放到 30 分钟 cron | `src/admin/extras.ts`、`src/index.ts` |
| P2-1 统计优化 | ✅ | cache-stats 改 `cache_stats` 表 UPSERT 原子自增（`col = col + excluded.col`），消除 RMW 丢失更新；确认调用本就在 `recordFinalize` 的 `waitUntil` 内；user_sessions 拆 `usess/<hash>\|<user>` 独立 key（TTL 7d），cron 枚举时迁移旧文档 | `src/store/cacheStats.ts`、`src/admin/extras.ts` |
| P2-2 usageLogs SQL 化 | ✅ | D1 路径下推 `ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?` + `COUNT(*)`，KV 兜底路径保持原语义 | `src/store/usage.ts` |
| P3 会话绑定合并 | ✅ | SessionBinding 拆 `sessbind/<id>` 独立 key（点读点写），`listSessionBindings` 走前缀枚举（上限 500），旧 `sessions` 文档懒迁移；`conversations` 索引文档（≤500 条）按计划保留 | `src/store/conversations.ts` |
| 测试适配 | ✅ | 更新 `nextAccount` 无 DO 回退路径的断言（游标移至 `accounts-cursor` 后不再改写 accounts 文档） | `test/coordination.test.ts` |

**部署步骤**：`npx wrangler d1 migrations apply m365-copilot2api --remote`（应用 0003）→ `npx wrangler deploy`。KV 旧数据（accounts / api-keys / resolver-sessions / user_sessions / sessions）在首次对应读取时自动迁移，无需手工操作。

**回滚**：任意时刻 revert 代码即可——所有写路径仍镜像维护 KV 旧文档；或直接移除 DB 绑定回退 KV 行为（但 0003 之后新写的数据只存在于 D1）。

## 五、第二轮实施记录（同日，重新评估后）

对 KV/D1/DO 分配做第二轮全量复核，落实 4 项调整（`tsc --noEmit`、194 个单元测试、`wrangler deploy --dry-run` 均通过）：

| 项 | 级别 | 状态 | 实现方式 | 涉及文件 |
|---|---|---|---|---|
| KV 镜像降频 | 中 | ✅ | accounts 仅**新增**账号时镜像（`d1Upsert` 返回 inserted 标志），delete 保留镜像；setScheduleEnabled / updateRefreshToken / markStatus 移除镜像（高频写不再整文档 RMW）。api-keys 仅 **revoked 状态变化**时镜像，create/delete 保留。D1 失败回退 KV 路径不变 | `src/store/accounts.ts`、`src/store/keys.ts` |
| 账号列表 DO 缓存 | 中 | ✅ | CoordinationDO 内存缓存账号列表（TTL 30s）；`GET /accounts-cache`（未初始化→cached:false）、`POST /accounts-cache/update`、`POST /accounts-cache/invalidate`。`listAccounts` 热路径优先走 DO 缓存，miss 时懒回填 KV 后全表查 D1 并推回；新增/删除账号时 invalidate。DO 只存不查，回源逻辑留在 accounts.ts | `src/do/coordination.ts`、`src/store/accounts.ts` |
| resolver-index 迁 D1 | 低 | ✅ | 新表 `resolver_sessions`（0004 迁移）；loadIndex 走 SQL（窗口过滤 + lastUsedAt DESC + LIMIT 1000），bind 单行 UPSERT + 超限 trim，touch 走 UPDATE，unbind 按 conversation_id 删除；KV 文档保留为无 DB 兜底 + 空表懒回填源 | `migrations/0004_resolver_sessions.sql`、`src/pipeline/resolver.ts` |
| account-health 上收 DO | 低 | ✅ | CoordState 增加 `health`；DO 端点 `/health/available`、`/health/mark-failure`（kind: auth/rate）、`/health/image-limited`、`/health/mark-success`、`/health/clear`、`/health/snapshot`，cooldown 过期并入 reap/alarm。pipeline/account.ts 六个函数 DO 优先、KV 仅作无 DO 兜底（advisory） | `src/do/coordination.ts`、`src/pipeline/account.ts` |
| McpSessionDO | — | 不变 | 每会话一实例的 SSE 信箱职责不可替代，仅纳入 DO 免费实例容量规划 | — |

**说明**：镜像降频后，KV 中 `accounts` / `api-keys` 文档的 status/schedule/refreshToken/lastUsedAt 等字段可能滞后；这是有意为之——KV 文档仅作为**结构性回滚安全网**（账号/key 的存在与撤销状态），高频字段以 D1 为真相。账号列表缓存 30s TTL 对管理端可见性影响可忽略（结构变更即时 invalidate）。
