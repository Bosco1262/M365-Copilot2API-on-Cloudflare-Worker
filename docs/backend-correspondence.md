# 后端文件对应名单

**当前仓库**：`M365-Copilot2API-on-Cloudflare-Worker`（TypeScript / Cloudflare Workers）
**上游仓库**：`M365-Copilot2API-main`（Go + 少量 Python 部署脚本）

> 两个仓库是同一项目的**两种语言实现**。当前仓库是上游 Go 后端的 Cloudflare Workers 移植版（见 `docs/PARITY.md`、`docs/PORTING-BACKLOG.md`）。本文按"功能模块"为单位做对应——因为上游 Go 习惯把每个职责拆成独立小文件，而当前 TS 把多个上游文件合并进少数文件，所以文件名并非 1:1。

## 口径说明

- **后端文件** = 运行时服务端源码 + 存储迁移 + 构建/部署配置 + 测试。
- **不计**：前端 HTML（`assets/*.html`、`web/*.html`、`internal/web/web/*.html`）、图片/字体等静态资源、`.wrangler/` 运行时状态、`node_modules/`、`dist/`。
- **标记**：✅ 双向对应 ｜ 🟦 仅当前仓库（上游无对应） ｜ 🟥 仅上游（当前未移植）。
- 当前仓库每个 `src/**` 源码文件头部都带有 `port of <上游文件>` 注释，下文映射据此核对，非推测。

---

## 一、源码对应总表（按功能模块）

| 功能模块 | 当前仓库（TS / Workers） | 上游仓库（Go / Py） | 状态 |
|---|---|---|---|
| 入口 / 路由注册 | `src/index.ts`、`src/router.ts` | `cmd/server/main.go`、`internal/web/server.go`（Routes） | ✅ 双向对应 |
| 环境绑定 / OAuth 配置 | `src/env.ts` | `internal/auth/config.go` | ✅ 双向对应 |
| 错误分类 / 脱敏 | `src/errors.ts` | `internal/web/account_health.go`（错误辅助） | ✅ 双向对应 |
| 共享类型 | `src/types.ts` | 各包内联 struct（无单文件） | ✅ 双向对应 |
| 共享工具（uuid/sha256/jsonOut/estimateTokens） | `src/util.ts` | 散落各包辅助函数 + `codex_usage.go` 估算 | ✅ 双向对应 |
| KV 文档存取层 | `src/kv.ts` | `internal/web/persist.go`、`atomicfile.go` | ✅ 双向对应（机制不同：KV vs 文件） |
| 静态页面路由 | `src/pages.ts` | `internal/web/security_http.go`（rootPage） | ✅ 双向对应 |
| OAuth PKCE / token | `src/auth/oauth.ts` | `internal/auth/pkce.go`、`internal/auth/token.go` | ✅ 双向对应 |
| ChatHub 协议层 | `src/chathub/protocol.ts` | `internal/chathub/`（protocol、events、images、stream_events） | ✅ 双向对应 |
| ChatHub 客户端 / 上传 | `src/chathub/client.ts` | `internal/chathub/client.go` | ✅ 双向对应 |
| MCP SSE 服务端 | `src/mcp/server.ts` | `internal/mcp/server.go`、`tools.go` | ✅ 双向对应 |
| MCP 出站客户端（SSE 桥接） | `src/mcp/outbound.ts` | `internal/mcp/client.go` | ✅ 双向对应 |
| MCP 会话 / 队列（DO 原语） | `src/do/mcp-hub.ts` | `internal/mcp/server.go`（会话）、`queue.go` | ✅ 双向对应（Workers DO 运行时原语） |
| 跨 isolate 协调（锁/信号量/刷新互斥） | `src/do/coordination.ts` | `account_concurrency.go`、`account_health.go`（锁定）、`auth/token.go`（刷新互斥） | ✅ 双向对应（DO 跨 isolate 等价上游进程内逻辑） |
| OpenAI `/v1/chat/completions`、`/v1/models` | `src/api/openai.ts` | `server.go`（openaiChat/openaiModels）、`toolloop.go`、`fenced_tools.go`、`native_tools.go`、`stream.go`、`prompt.go`、`tool_*.go`、`xml_tools.go` | ✅ 双向对应 |
| Anthropic `/v1/messages` | `src/api/anthropic.ts` | `internal/web/protocol_compat.go`（anthropicRequest.openAI） | ✅ 双向对应 |
| Responses `/v1/responses` | `src/api/responses.ts` | `protocol_compat.go`、`protocol_handlers.go`（responses）、`codex_responses.go`、`codex_usage.go` | ✅ 双向对应 |
| 图片生成 / 编辑 / 文件 | `src/api/images.ts` | `internal/web/images.go`、`m365cloud.go`、`chathub/images.go` | ✅ 双向对应 |
| API Key 校验 | `src/api/auth.ts` | `server.go`（validAPIKey/extractAPIKey） | ✅ 双向对应 |
| SSE 辅助 | `src/api/sse.ts` | `internal/web/stream.go` | ✅ 双向对应 |
| 流式文本 holdback（围栏扣留） | `src/api/holdback.ts` | `server.go` 流式分支内联（无独立文件） | ✅ 双向对应（行为移植） |
| 控制台聊天（原生 / 流） | `src/admin/chat.ts` | `server.go`（chatOnce）、`stream.go`（chatStream） | ✅ 双向对应 |
| 全部 `/api/*` 管理端点 | `src/admin/handlers.ts` | `server.go`、`admin_security.go`、`settings.go`、`keys.go`、`account_health.go`、`version.go`、`deployments.go`、PKCE 流程 | ✅ 双向对应 |
| 白名单 / 用户会话 / 调试 / memory / 部署 stub | `src/admin/extras.ts` | `conversation_manager.go`、`sessions.go`、`debug.go`、`memory_handlers.go`、`deployments.go`、`plugins.go` | ✅ 双向对应（`/api/plugins` 已实现：substrate 透传 + 5min KV 缓存，2026-08-27 复核） |
| 账号健康 / 选择 / 轮询 | `src/pipeline/account.ts` | `account_health.go`、`server.go`（resolveAccount/nextHealthyAccount） | ✅ 双向对应 |
| 模型目录 / tone 路由 | `src/pipeline/catalog.ts` | `codex_catalog.go`、`server.go`（modelTone/reasoningTone） | ✅ 双向对应 |
| 对话自动清理 | `src/pipeline/cleanup.ts` | `auto_cleanup.go` | ✅ 双向对应 |
| M365 云端对话管理 | `src/pipeline/m365cloud.ts` | `m365cloud.go` | ✅ 双向对应 |
| 提示词扁平化 / 多模态 | `src/pipeline/prompt.ts` | `prompt.go`、`multimodal.go` | ✅ 双向对应 |
| 会话解析（内容指纹复用） | `src/pipeline/resolver.ts` | `session_resolver.go` | ✅ 双向对应 |
| Function calling 工具箱 | `src/pipeline/tools.ts` | `toolloop.go`、`fenced_tools.go`、`tooldecision.go`、`model_tool_router.go`、`native_tools.go`、`tool_response.go` | ✅ 双向对应 |
| Agent 证据账本 | `src/pipeline/ledger.ts` | `agent_ledger.go` | ✅ 双向对应 |
| 账号存储（token/健康/并发） | `src/store/accounts.ts` | `account_health.go`、`account_concurrency.go`、`auth/cache.go` | ✅ 双向对应 |
| 管理员密码 / 会话 | `src/store/admin.ts` | `admin_security.go` | ✅ 双向对应 |
| 缓存命中统计 | `src/store/cacheStats.ts` | `cache_stats.go` | ✅ 双向对应 |
| **对话转录存储（D1）** | `src/store/chatMessages.ts` | —（上游 detail 走云端实时拉取，无落库转录） | 🟦 **仅当前仓库**（D1 特有） |
| 会话缓存 convCache | `src/store/convCache.ts` | `conv_cache.go` | ✅ 双向对应 |
| 会话键绑定 / 本地对话记录 | `src/store/conversations.ts` | `sessions.go`、`conversation_manager.go` | ✅ 双向对应 |
| API Keys 存储 | `src/store/keys.ts` | `keys.go` | ✅ 双向对应 |
| 运行时设置 | `src/store/settings.ts` | `settings.go`、`config/config.go` | ✅ 双向对应 |
| 用量统计 | `src/store/usage.ts` | `usage.go`、`usage_http.go` | ✅ 双向对应 |

---

## 二、构建 / 部署 / 配置 / 文档 对应

| 类别 | 当前仓库 | 上游仓库 | 状态 |
|---|---|---|---|
| 依赖清单 | `package.json` | `go.mod` | ✅ 双向对应（生态不同） |
| 锁文件 | `package-lock.json` | `go.sum` | ✅ 双向对应 |
| 环境变量模板 | `.dev.vars.example` | `.env.example` | ✅ 双向对应 |
| 忽略规则 | `.gitignore` | `.gitignore` | ✅ 双向对应 |
| 许可证 | `LICENSE` | `LICENSE` | ✅ 双向对应 |
| 说明文档 | `README.md` | `README.md` | ✅ 双向对应 |
| 部署工具 | `wrangler.jsonc`、`wrangler.dev.jsonc` | `Dockerfile`、`docker-compose.yml`、`manage.py` | ✅ 双向对应（部署方式不同） |
| TS 构建配置 | `tsconfig.json` | —（Go 无需） | 🟦 仅当前仓库 |
| 测试运行器配置 | `vitest.config.ts` | —（Go 内置 `go test`） | 🟦 仅当前仓库 |
| 移植追踪文档 | `docs/PARITY.md`、`docs/PORTING-BACKLOG.md` | —（上游无此类文档） | 🟦 仅当前仓库 |
| D1 表结构迁移 | `migrations/0001_init.sql`、`migrations/0002_chat_messages.sql` | —（上游用文件/JSON 持久化，无 SQL） | 🟦 仅当前仓库（D1 特有） |
| i18n 一致性检查脚本 | `scripts/check-i18n.mjs` | —（上游无对应脚本） | 🟦 仅当前仓库 |
| 本地回调网关 | — | `pkce_auth_gateway.py` | 🟥 仅上游（Workers 部署无需） |
| CI 工作流 | — | `.github/workflows/ci.yml`、`release.yml` | 🟥 仅上游 |
| 贡献 / 安全文档 | — | `CONTRIBUTING.md`、`SECURITY.md` | 🟥 仅上游 |
| 审计 / HAR 研究文档 | — | `docs/audit-*.md`（3）、`docs/har-mining/*`（8+README）、`docs/image-upload-references.md` | 🟥 仅上游（研究类，非运行时） |
| 前端截图 | — | `docs/screenshots/*.png`（8） | 🟥 仅上游（资源） |
| 开发探针脚本 | — | `scripts/*.py`（7）、`scripts/test-recorder.ps1` | 🟥 仅上游（开发工具，非运行时） |
| Python 端到端 / 压测 | — | `tests/*.py`（6） | 🟥 仅上游（见测试说明） |
| Web 根目录开发/运行产物 | `_all.cjs`、`_c.cjs`、`_result.txt`、`ext-out.txt`、`flow.log`、`flow.tmp.cjs`、`.dev-err.log`、`.dev-out.log`、`.devpid` | — | 🟦 仅当前仓库（临时产物，非源码） |

---

## 三、测试对应（组织方式不同，但套件对应）

- **当前仓库**：`test/` 独立目录，20 个 `.ts` 文件（`anthropic`、`chathub`、`chat-messages`、`conv-cache`、`coordination`、`extras`、`holdback`、`i18n`、`ledger`、`native-tools`、`outbound-mcp`、`pipeline`、`protocol`、`resolver`、`responses`、`stream-tail`、`tools` 等 + `helpers/mockkv.ts`）。
- **上游仓库**：约 **51 个 `*_test.go`** 文件，与源码同目录 colocated。
- **结论**：✅ 套件级双向对应（协议 / 解析器 / 工具 / 原生事件抽取 / agent ledger / 协调 DO / 对话转录 / convCache / 出站 MCP / 流式调试 / 转换 / 错误体系），但**组织方式不同**：Go 同文件内联 vs TS 独立 `test/` 目录。上游真实 WS 往返的集成测试不在单元范围内。

---

## 四、🟦 仅当前仓库存在（上游无对应）

| 文件 | 原因 |
|---|---|
| `docs/PARITY.md`、`docs/PORTING-BACKLOG.md` | 移植进度追踪文档，上游无 |
| `migrations/0001_init.sql`、`migrations/0002_chat_messages.sql` | D1 表结构，上游用文件/JSON 持久化 |
| `src/store/chatMessages.ts` | D1 对话转录存储；上游 detail 走云端实时拉取，无落库 |
| `scripts/check-i18n.mjs` | i18n 一致性检查，上游无 |
| `tsconfig.json`、`vitest.config.ts` | TS 构建/测试配置，Go 不需要 |
| `_all.cjs`、`_c.cjs`、`_result.txt`、`ext-out.txt`、`flow.log`、`flow.tmp.cjs`、`.dev-err.log`、`.dev-out.log`、`.devpid` | 仓库根目录构建/运行临时产物，非源码 |

> 注：`src/do/mcp-hub.ts`、`src/do/coordination.ts` 虽是 Workers DO 运行时原语，但功能上对应上游 mcp 会话/队列 + 账号并发/锁定/刷新互斥逻辑，故归为 ✅ 双向对应。

---

## 五、🟥 仅上游存在（当前未移植，按原因归类）

### [平台] Workers 运行时限制 → 已裁剪
| 文件 | 说明 |
|---|---|
| `internal/outbound/proxy.go`(+test)、`pool.go`、`health.go` | HTTP/SOCKS 出站代理；Workers `fetch` 不支持 |
| `internal/web/proxy_pool.go` | 代理池端点（控制台"代理池"页已整体移除） |
| `internal/chathub/connpool.go` | WS 连接池；isolate 无法跨请求持有连接，每请求新建 |
| `internal/web/atomicfile.go` | 文件原子写；KV 无文件语义 |
| `internal/web/persist.go` | 后台落盘循环；KV 即时写替代 |

### [等价替代] 由 Workers 原生能力覆盖
| 文件 | 说明 |
|---|---|
| `internal/web/http_trace.go` | 访问日志；Workers 内置请求日志/wrangler tail 覆盖 |
| `internal/web/recover.go` | panic 恢复中间件；fetch 入口 try/catch 500 覆盖 |

### [未做] 尚未移植（技术上可行）
| 文件 | 说明 |
|---|---|
| `internal/web/public_identity.go`(+test) | 公开身份清洗（上游默认关闭的可选特性） |
| `internal/chathub/ssrf.go`(+test) | 附件 SSRF 防护（当前为平台近似：scheme/IP 字面量/主机名段拦截，域名复查依赖 CF 边缘，无运行时 DNS API） |
| `internal/web/compat_metadata.go`(+test) | `m365.events` 兼容元数据（`M365_INCLUDE_UPSTREAM_EVENTS`；env.ts 有类型声明但未接线） |
| `internal/auth/cache.go` | refresh token 落盘 AES-GCM 加密（当前明文存 KV） |
| `internal/web/context_budget.go` | 上下文预算（已由 `src/pipeline/contextBudget.ts` slidingWindow 覆盖） |
| `internal/web/tool_progress.go`(+test) | 工具进度卡（聊天流已移植，Responses 路径暂跳过） |
| `internal/auth/device.go` | Device Code 流（**[上游死代码]**，上游未挂接任何路由） |

### 研究与部署/CI/脚本（非运行时，上游特有）
- `docs/audit-*.md`、`docs/har-mining/*`、`docs/image-upload-references.md`、`docs/screenshots/*.png`
- `.github/workflows/ci.yml`、`release.yml`、`CONTRIBUTING.md`、`SECURITY.md`
- `Dockerfile`、`docker-compose.yml`、`manage.py`、`pkce_auth_gateway.py`
- `scripts/*.py`（7）、`scripts/test-recorder.ps1`
- `tests/*.py`（6，Python 端到端/压测）

---

## 六、关键结论

1. **当前仓库的 `src/` 几乎全部有上游对应**：42 个源码文件中，41 个能映射到上游 Go 模块，**唯一真正无上游对应**的是 `src/store/chatMessages.ts`（D1 转录，Workers 特有增强）。
2. **上游"仅存在"的主体是平台裁剪 + 测试/脚本组织差异**，并非功能缺失：代理池、连接池、文件原子写、加密落盘属 [平台]/[差异]；SSRF、public_identity、plugins、m365.events 属 [未做]（PARITY.md 已标注优先级）。
3. **前端**：当前 `assets/*.html`(+`vendor/`) ↔ 上游 `web/*.html` + `internal/web/web/*.html`，为同源控制台页面，属前端不计后端。
4. 完整移植状态以 `docs/PARITY.md` 为准（最近核对 2026-08-26）。
