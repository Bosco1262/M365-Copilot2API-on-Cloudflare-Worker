# A 部分「鉴权与安全」逐项核对报告（2026-08-27）

> 依据：`docs/ALIGNMENT-CHECKLIST-non-model.md` 第 A 节（A1–A12）
> 上游：`C:\Github Desktop\M365-Copilot2API-main`（Go）
> 本仓库：`C:\Github Desktop\M365-Copilot2API-on-Cloudflare-Worker`（Workers TS）
> 方法：对每项读取两端源码实现并比对行为，逐条给出确认/修正/补充。

> **2026-08-27 第二轮：修复已实施并验证**（typecheck ✅、vitest 23 文件/190 用例全过）
> - A3：`src/admin/handlers.ts` 新增 isolate 本地锁定兜底（`localLoginFailures`，5 次/15min per-IP，窗口滚动 + 4096 上限，对齐上游 `loginAttempts`）；handleLogin 在 COORD 未绑定/失败时自动降级到本地计数，成功登录清除本地计数
> - A8：`src/index.ts` `withSecurityHeaders` 与 `assets/_headers` 均补 `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
> - A9：页面路径（`/`、`/login`、`/conversation`、`/debug`）响应统一加 `withRequestId`
> - A11：`withSecurityHeaders` 为 API/JSON 响应补完整 CSP（与 `_headers` 一致，并顺带在两端补 `form-action 'self'` 对齐上游）
> - 清单 `ALIGNMENT-CHECKLIST-non-model.md` 已回写（A3/A7/A8/A9/A10/A11/L1）。

---

## 0. 结论摘要

| # | 功能点 | 清单原状态 | 核对后状态 | 说明 |
|---|--------|-----------|-----------|------|
| A1 | API Key 提取 | ✅ | ✅ 确认 | 行为逐行一致 |
| A2 | API Key 存储（仅哈希） | ✅ | ✅ 确认 | D1 模式撤销即时生效，优于上游 |
| A3 | Admin 登录 / 会话 | ⚠️ | ⚠️ 维持，补充 1 处 | 见下：未绑定 COORD 时**无任何**登录锁定 |
| A4 | 强制改密 / 登出失效 / SameSite | ✅ | ✅ 确认 | Cookie 三属性 + 改密清全会话一致 |
| A5 | OAuth PKCE / 粘贴流 | ✅ | ✅ 确认 | S256、`?url=` 粘贴流、loopback 关窗页齐全 |
| A6 | Token 刷新单飞防抖 | ✅ | ✅ 确认 | COORD 命名互斥 `refresh:<id>` 30s + 轮询 ≤15s |
| A7 | ROPC 密码登录 | ✅ | ✅ 确认，备注 1 处 | organizations vs common 端点差异（已决策） |
| A8 | 安全响应头 | ✅ | ✅ 基本确认，建议补 1 头 | **缺 Permissions-Policy** |
| A9 | X-Request-ID 关联 | ✅ | ✅ 确认，备注 1 处 | 页面路径不带 requestId（极小差异） |
| A10 | 附件 SSRF 防护 | ⚠️ [平台] | ⚠️ [平台] 维持，**更正位置** | 防护在 `src/chathub/client.ts`，非 openai.ts |
| A11 | 完整 CSP 头 | ❌ | ✅ **修正为已对齐** | `assets/_headers` 已含 CSP 且覆盖全部页面 |
| A12 | refresh token 落盘加密 | [用户选择] | [用户选择] 确认 | 明文 KV/D1，已确认选择 |

**核对中发现的清单偏差共 3 处**（建议回写清单）：
1. **A11 已实现**：`assets/_headers` 第 6 行已有完整 CSP（且比上游更严格），应改 ❌ → ✅。
2. **A10 位置指认错误**：SSRF 校验实际在 `src/chathub/client.ts`（附件上传路径，对应上游 `chathub/ssrf.go`）；`openai.ts downloadImageAsDataURI`（模型图片回传）与上游 `images.go downloadImageAsDataURIWithToken` 一样**无** SSRF 校验，两端一致，非缺陷。
3. **A8 缺 Permissions-Policy**：上游 `security_http.go:27` 有 `camera=(), microphone=(), geolocation=(), payment=(), usb=()`，Worker 未移植（`_headers` 与 `index.ts` 均无）。

---

## 1. 逐项核对明细

### A1 API Key 提取（X-API-Key / Bearer）— ✅ 确认

**上游** `internal/web/server.go:599-617`
- `rawAPIKey`：优先 `X-API-Key`（trim），为空时取 `Authorization`，前缀（大小写不敏感）`bearer ` 则取 `v[7:]` 并 trim
- `validAPIKey`：raw 非空且命中 `apiKeys.valid(raw)`（SHA-256 哈希比对）
- 「m365_ 前缀」只体现在 key **生成**（`keys.go:81` `"m365_" + hex`），校验本身不查前缀

**Worker** `src/api/auth.ts:7-19`
- `rawAPIKey` / `validAPIKey` 逻辑逐行对应；`extractAPIKeyPrefix` 额外提供了日志脱敏用的前缀（`前8位...`），上游无此函数但仅用于日志，无行为差异

**结论**：✅ 完全对齐。两种头均可、大小写不敏感 Bearer、校验仅依赖哈希表。

---

### A2 API Key 存储（仅哈希）— ✅ 确认

**上游** `internal/web/keys.go`
- 记录含 `Hash`（SHA-256 hex，`keyHash`），`create` 返回前清空 `Hash`/`Raw`（line 92-94），`list` 清空两者（line 101-104）
- 落盘 0600 + atomic write，仅存哈希，**不回读明文**

**Worker** `src/store/keys.ts`
- 优先 D1 `api_keys` 表（`migrations/0003_storage_audit.sql`），每次变更镜像回 KV 文档作回滚安全网
- `listKeys` 将 `hash` 置 `undefined`（line 173/176）——返回语义与上游一致
- `validKey` 按 `sha256Hex(raw)` 查库，**无明文比对**
- 增强：D1 模式下 `revoked` 即时生效（KV 有 ~60s 最终一致性窗口），上游单进程文件无此问题

**结论**：✅ 对齐且更强。仅哈希、回读语义一致、D1 撤销即时。

---

### A3 Admin 登录 / 会话 — ⚠️ 维持（含 2 处补充）

**上游** `internal/web/admin_security.go` + `server.go:393-540`
- 密码：**bcrypt**（`bcrypt.DefaultCost`），兼容旧明文/legacy 文件迁移
- 强度策略：≥12 字符、3/4 字符类、黑名单 16 条、序列/重复检测、简化 zxcvbn（score<3 拒）、**历史密码防重用**（`History` 最多 5 条，`checkPassword` 逐一比对）
- 登录锁定：**进程内** `s.loginAttempts`（maxLoginAttemptEntries 4096 + 清理），5 次失败 → 锁 15 分钟，429 + `Retry-After`
- 首次部署：bootstrap `admin123` + `mustChange=true`，中间件除 change-password/logout 外全 403（`password_change_required`）；`M365_REQUIRE_STRONG_ADMIN_PASSWORD=1` 可拒绝 bootstrap
- 会话：32B 随机 token，内存 map，24h TTL，改密后 `s.adminSessions` 清空

**Worker** `src/store/admin.ts` + `src/admin/handlers.ts:72-163`
- 密码：**SHA-256** hex（清单 K6 已确认 [用户选择]）
- 强度策略：仅 3 条（非默认密码 / ≥6 位 / ≤256）——**显著弱于上游**；**无历史防重用**（`changeAdminPassword` 直接覆盖，无 history 字段）
- 登录锁定：**仅 COORD 绑定时生效**（`coordLockoutCheck/Record`，5 次/15min per-IP，429 + Retry-After 900s）；未绑定时**完全无锁定**（上游无论何种部署都有进程内锁定）
- 首次部署：同样 bootstrap 默认密码 + mustChange，`ADMIN_PASSWORD` 环境变量覆盖（且残留默认哈希会被 env 纠正，admin.ts:36-44）
- 会话：KV 存储（跨 isolate 共享），24h TTL，MAX_SESSIONS 4096 + 淘汰最旧，改密清空 KV sessions

**补充差异（清单未写明）**：
1. **COORD 未绑定时登录锁定完全缺失**——上游进程内锁定恒存在，Worker 未绑定即退化到"无锁定"。对暴露公网的自部署属于实际风险，建议要么文档写明、要么在 isolate 内加本地失败计数兜底。
2. 密码强度策略比清单描述的弱化程度更大：上游 12 位 + 4 类 + 黑名单 + zxcvbn + 历史 5 条，Worker 仅 6 位。K6 已标注"曾移植后回退"，核对属实（当前 `validNewAdminPassword` 只剩 3 条检查）。

**结论**：⚠️ 维持。建议跟进上述 2 点（至少文档化，或补 isolate 内锁定兜底）。

---

### A4 强制改密 / 登出失效 / SameSite — ✅ 确认

**上游**
- `mustChange` 中间件（server.go:420-425）：改密前除 change-password/logout 外全 403
- 改密成功 → 清空 `s.adminSessions` + cookie MaxAge -1（admin_security.go:572-575）
- Cookie：`m365_admin_session`，HttpOnly + Secure（TLS 或 loopback+X-Forwarded-Proto https，`secureAdminCookie`）+ SameSite=Lax，MaxAge 86400
- Logout：删会话 + cookie MaxAge -1

**Worker**
- `authorize`（index.ts:153-163）：mustChange 403 逻辑同上游
- `changeAdminPassword`（admin.ts:114-119）：写入新哈希后清空全部 KV sessions ✅；`handleChangePassword` 另发 clearCookie（handlers.ts:161）✅
- Cookie（handlers.ts:57-63）：HttpOnly + SameSite=Lax + `Secure`（https 或 X-Forwarded-Proto https，`secureCookie`）+ Max-Age 86400 ✅
- Logout：`destroyAdminSession` + clearCookie ✅

**细微差异**：Secure 判定条件不同——上游仅当 TLS 或「loopback + XFP https」才置 Secure；Worker 对任意来源的 https/XFP-https 都置 Secure。Worker 更宽松但更安全（公网部署恒 https，Secure 常开），无风险。

**结论**：✅ 完全对齐。

---

### A5 OAuth PKCE / nativeclient 粘贴流 — ✅ 确认

**上游** `internal/auth/pkce.go` + `server.go:891-1039`
- Verifier 32B → base64url；Challenge = SHA-256 → base64url（S256）；AuthorizationURL 参数：client_id / response_type=code / redirect_uri / response_mode=query / scope / state / code_challenge / code_challenge_method=S256
- state 16B hex，内存 map，**10 分钟 TTL**
- callback 兼容 `?url=<完整回调URL>` 粘贴流（解析 code/error/state）
- loopback redirect（127.0.0.1/localhost）返回自动关窗 HTML 页（postMessage 通知 opener）

**Worker** `src/auth/oauth.ts` + `src/admin/handlers.ts:212-260`
- `newVerifier`/`pkceChallenge`/`authorizationURL` 字段逐一对应 ✅
- state 存 KV：`pkce/<state>`，**TTL 600s**（跨 isolate 可用，上游进程内存）
- `handleAuthCallback`：支持 `?url=` 粘贴流、`processing` 状态防重复消费（409）、loopback 关窗页（handlers.ts:257 注释确认同上游）
- TTL 差异 600s vs 10min：语义相近（都约 10 分钟），平台化实现合理

**结论**：✅ 完全对齐（TTL 表述差异可忽略）。

---

### A6 Token 刷新单飞防抖 — ✅ 确认

**上游** `internal/auth/cache.go:445-539`
- 进程内 `inflight map[id]*inflightRefresh`（chan 共享结果）+ `EnsureValid` 阈值 120s / 总寿命 1/10 取小
- 刷新端点：`TokenEndpoint()`，device clientId 走 `DeviceTokenEndpoint()`，含 `X-AnchorMailbox` 头（Oid@Tid）

**Worker** `src/store/accounts.ts:456-504` + `src/do/coordination.ts:194-212, 315-325`
- isolate 内 `inflight` Map 合并 + **COORD 命名互斥 `refresh:<id>`（30s TTL）**；未抢到方轮询 KV（400ms 间隔，≤15s 超时），避免双花单次 refresh token
- 刷新端点：`cfg.tokenEndpoint`（device clientId 例外走 `${authority}/oauth2/v2.0/token`）
- 差异：刷新阈值 Worker 固定 30s 缓冲（`tokenValid`），上游 120s/10%——仅提前量不同，无安全影响

**结论**：✅ 对齐。COORD 绑定时跨 isolate 强一致，优于上游进程内单飞；AAD refresh token 单次性风险处理到位（D1 行级条件更新 + 互斥 + 轮询三重保障）。

---

### A7 ROPC 密码登录 — ✅ 确认（2026-08-27 已对齐 organizations 端点）

**上游** `server.go:819-850` + `internal/auth/token.go:108-116`
- `provisionAccount`：需 admin session；`auth.ROPC` **固定** `Authority()+"/organizations/oauth2/v2.0/token"`（不随 `M365_TOKEN_ENDPOINT`）

**Worker** `src/auth/oauth.ts:102-126` + `src/admin/handlers.ts`（handleProvisionAccount）
- 同样需 admin session；**2026-08-27 已改**：`ropcToken` 不再跟随 `cfg.tokenEndpoint`，改为恒走 organizations 租户端点——`new URL(authority).origin + "/organizations/oauth2/v2.0/token"`（含解析失败兜底到 `login.microsoftonline.com`）

**实测发现（2026-08-27，curl 验证）**：上游默认拼接 `common/organizations/oauth2/v2.0/token` 被 AAD 返回 **404**（双段 tenant 路径无效）；标准路径 `organizations/oauth2/v2.0/token` 返回 400（有效）。因此：
- 上游默认配置下 ROPC 实际不可用（需把 authority 配成登录根域名才有效）——属上游拼接缺陷
- Worker 版用 origin 拼法，默认配置下即得到有效 organizations 端点（`https://login.microsoftonline.com/organizations/oauth2/v2.0/token`），且对自定义 authority（如国家云）同样成立

**结论**：✅ 语义对齐（ROPC 恒 organizations），并修复上游默认 404 缺陷。`M365_TOKEN_ENDPOINT` 不再影响 ROPC（与上游一致），已同步更新清单 A7/I2。

---

### A8 安全响应头 — ✅ 基本确认（建议补 1 头）

**上游** `internal/web/security_http.go:22-33`（全响应）
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
- CSP（见 A11）
- `Cache-Control: no-store`（`/`、`/login`、`/api/admin/login`、`/api/admin/session`、`/api/admin/change-password`）

**Worker**
- `index.ts:119-125 withSecurityHeaders`（全响应）：nosniff / XFO DENY / Referrer-Policy ✅
- `pages.ts:29-35`（/login、/conversation、/debug）：额外 `Cache-Control: no-store` ✅；`/` 由 ASSETS 服务（index.ts:196-200 同样 no-store）✅
- **缺 `Permissions-Policy`**（上游有，Worker 的 `_headers` 与中间件均无）

**建议**：在 `withSecurityHeaders`（或 `assets/_headers`）补一行
```
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```
成本一行、行为与上游对齐。

**结论**：✅ 基本对齐；补 Permissions-Policy 后可标完全对齐。

---

### A9 X-Request-ID 关联 — ✅ 确认（备注 1 处）

**上游** `internal/web/request_id.go`
- `uuid.NewString()` 服务端生成（不信客户端值，防日志伪造），全请求设置 `X-Request-ID` 头

**Worker** `src/index.ts:281-285 withRequestId`
- `ctx.requestId = uuid()`，应用于路由匹配后的所有响应，404 也带（line 278）；denied 响应也带（line 207）
- **页面路径（`/`、`/login` 等）不带** X-Request-ID（line 200/203 只过 `withSecurityHeaders`）——上游对页面同样带。差异极小（页面非 API，无关联排查需求）

**结论**：✅ 对齐（API 全带、服务端生成、防伪造）；页面路径缺 requestId 属可忽略差异。

---

### A10 附件 SSRF 防护 — ⚠️ [平台] 维持（**更正位置指认**）

**上游** `internal/chathub/ssrf.go`
- `validateRemoteDownloadURL`：仅 https；`net.LookupIP` 解析后逐 IP 检查（loopback / private / link-local / multicast / unspecified / CGNAT 100.64/10 / 169.254.169.254 兜底）
- 应用于**附件上传路径**（Client.uploadAttachments 下载远程图片）

**上游图片回传路径**（`images.go:529 downloadImageAsDataURIWithToken`）**无** SSRF 校验（下载失败返回原 URL）——上游自身即如此。

**Worker** `src/chathub/client.ts:75-136`（**实际防护位置**，清单 A10 写成了 `src/api/openai.ts downloadImageAsDataURI`）
- `validateRemoteDownloadURL`：仅 https；**IP 字面量**逐段检查（127 / 10 / 172.16-31 / 192.168 / 169.254 / 100.64-127 / 0 / 224+）；域名黑名单（`169.254.169.254.nip.io` / `.internal` / `.local`）
- `downloadImage`：manual redirect，**每跳重新校验**（≤5 跳）、≤10 MiB——对应上游 `downloadClient` 语义
- 平台限制：Workers 无运行时 DNS API，域名只能查 IP 字面量 + 黑名单，**无法像上游那样解析后复查**（清单 [平台] 标注准确）
- `src/api/openai.ts downloadImageAsDataURI`（模型图片回传）无校验，与上游 images.go **一致**，非缺陷

**结论**：⚠️ [平台] 维持。行为对齐（附件路径防护完整），**清单中"检测要点"的代码位置应更正为 `src/chathub/client.ts`**。

---

### A11 完整 CSP 头 — ✅ **修正为已对齐**

**上游** `security_http.go:28`（全响应）：
```
default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none';
form-action 'self'; connect-src 'self'; img-src 'self' data:;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net
```

**Worker** `assets/_headers:5-9`（Static Assets 全文件）：
```
default-src 'self'; script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:;
connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

**核对结论**：
- `_headers` 已存在完整 CSP（`wrangler.jsonc:15-19` assets 配置生效，`/`、`/login`、`/conversation`、`/debug` 全部经 ASSETS 服务 → 全部带 CSP）
- Worker CSP **比上游更严格**：script-src 去掉 unpkg/jsdelivr 外部 CDN（Worker 版控制台未引用外部脚本）；img-src/connect-src 放宽到 `https:`（支撑图片回传与 API 调用）
- 唯一残余差异：API/JSON 响应无 CSP（上游全响应带）。CSP 对 JSON 无安全价值，可忽略

**结论**：A11 应从 ❌ 更新为 ✅（页面级已覆盖且更严格）。清单生成时可能未注意到 `_headers` 已补 CSP。

---

### A12 refresh token 落盘加密 — [用户选择] 确认

**上游** `internal/auth/cache.go:82-162`
- `enc:v1:` 前缀 + **AES-256-GCM**（密钥由 `M365_MASTER_KEY`/`M365_TOKEN_ENCRYPTION_KEY` 经 pepper HMAC-SHA256 派生），0600 atomic 落盘
- **未设置主密钥时使用内置 fallback key**（有 WARNING 日志）——即上游默认部署下加密强度依赖内置密钥，属"防静态拖库"级别的弱保护

**Worker** `src/store/accounts.ts`
- `refresh_token` 明文存 D1 `accounts` 表 / KV `accounts` 文档（清单 K2 [用户选择] 已确认）
- 平台注：KV/D1 由 Cloudflare 边界保护（凭据不可被 Worker 外读取、静态加密）

**结论**：[用户选择] 确认，非待办。备注：上游无 master key 时同样是"公开密钥加密"，实际两者静态保护级别差距小于表面差异；若未来要加，可在 KV 写入前做 AES-GCM（Web Crypto 支持）。

---

## 2. 建议回写清单的修改

| 清单条目 | 现状 | 建议改为 |
|---------|------|---------|
| A11 | ❌（"需 _headers 文件补"） | ✅（`assets/_headers:6` 已有 CSP，页面全覆盖且比上游严格） |
| A10 检测要点 | `src/api/openai.ts downloadImageAsDataURI` | `src/chathub/client.ts validateRemoteDownloadURL/downloadImage`（附件路径）；openai.ts 图片回传与上游一致无校验 |
| A8 检测要点 | 三头 | 补注：缺 `Permissions-Policy`（上游 security_http.go:27） |
| A3 检测要点 | "COORD 绑定时 5 次/15min" | 补注：**COORD 未绑定时无任何登录锁定**（上游恒有进程内锁定） |

## 3. 建议行动项（按优先级）

1. **低成本高收益**：`withSecurityHeaders` / `_headers` 补 `Permissions-Policy`（A8 全对齐，一行）。
2. **安全补强（可选）**：COORD 未绑定场景在 isolate 内加登录失败计数兜底（对齐上游进程内锁定语义），或至少在 README 部署说明中明确该限制。
3. **部署对齐（推荐）**：wrangler vars 显式设 `M365_TOKEN_ENDPOINT=https://login.microsoftonline.com/organizations/oauth2/v2.0/token`，使 ROPC 与上游 organizations 行为逐字一致（A7）。
4. **文档维护**：按第 2 节回写 `ALIGNMENT-CHECKLIST-non-model.md`（A8/A10/A11 状态与位置），保持清单与代码事实同步。
5. 密码强度策略（A3/K6）：若在意，可在 `validNewAdminPassword` 恢复上游的字符类 + 长度规则（12 位 + 3/4 类），成本小、收益明确。

## 4. 代码位置对照速查

| 功能 | 上游（Go） | Worker（TS） |
|------|-----------|-------------|
| API Key 提取 | `internal/web/server.go:599-617` | `src/api/auth.ts:7-19` |
| API Key 存储 | `internal/web/keys.go` | `src/store/keys.ts` |
| Admin 登录/锁定/改密 | `internal/web/admin_security.go` + `server.go:393-540` | `src/store/admin.ts` + `src/admin/handlers.ts:72-163` |
| Admin Cookie | `server.go:522/575` | `src/admin/handlers.ts:57-63` |
| PKCE | `internal/auth/pkce.go` + `server.go:891-1039` | `src/auth/oauth.ts` + `src/admin/handlers.ts:212-260` |
| 刷新单飞 | `internal/auth/cache.go:445-539` | `src/store/accounts.ts:456-504` + `src/do/coordination.ts` |
| ROPC | `internal/auth/token.go:108-116` | `src/auth/oauth.ts:102-111` |
| 安全头 | `internal/web/security_http.go:22-33` | `src/index.ts:119-125` + `src/pages.ts:29-35` + `assets/_headers` |
| X-Request-ID | `internal/web/request_id.go` | `src/index.ts:281-285` |
| SSRF | `internal/chathub/ssrf.go` | `src/chathub/client.ts:75-136` |
| 图片回传（无校验，两端一致） | `internal/web/images.go:529-545` | `src/api/openai.ts:253-274` |
| 明文 token 存储 | （AES-GCM）`internal/auth/cache.go:104-162` | `src/store/accounts.ts`（明文，K2） |
