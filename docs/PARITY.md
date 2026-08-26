# 移植完整度对比报告：M365-Copilot2API-on-Cloudflare-Worker vs 上游 M365-Copilot2API

> 对照基准：上游 `internal/` 全部 Go 源文件、`server.go Routes()` 全部路由、README 功能表。
> 本文档逐项列出实现状态；未实现项均标注原因分类：
> **[平台]** Workers 运行时能力限制（已确认裁剪）｜ **[简化]** 行为等价但实现方式适配 Workers/KV ｜ **[未做]** 尚未移植（技术上可行）｜ **[上游死代码]** 上游存在但未被任何路由调用

---

## 一、对外 API 端点对照（56 条路由）

### /v1/* 兼容端点

| 上游端点 | 状态 | 说明 |
|---|---|---|
| `POST /v1/chat/completions` | ✅ 完整 | 流式+非流式、reasoning_content、function calling（router 规划/fenced/native 检测/schema 校验信任边界/流式参数分片）、多模态图片上传、会话复用增量发送、failover、tone 回退、内容策略拦截、工具拒答/沙盒幻觉纠偏 |
| `GET /v1/models` | ✅ 完整 | Codex 风格目录全字段，`data`+`models` 双别名 |
| `POST /v1/responses` | ⚠️ 功能等价 | instructions/input 全项转换、previous_response_id 历史（KV 1h TTL）、function_call 投影、SSE 事件序列。**差异**：流式为"完成后事件重放"而非逐字增量转换 [简化]；usage 为启发式估算非 tiktoken o200k [简化]；`function_call_progress` 项无条件跳过（上游解析成功才跳过）[简化] |
| `POST /v1/messages` (Anthropic) | ✅ 增强 | system/块转换、thinking/tool_use block。**流式为真增量**（ChatHub onDelta/onReasoning 直接映射 thinking_delta/text_delta，含工具围栏扣留与 tool_use 块切换），优于上游的"完成后重放"实现 |
| `POST /v1/images/generations` | ✅ 完整 | 提示词模板、事件图片提取、rawResult/text 兜底提取、配额拒绝 429+Retry-After 86400、Designer 域名换 token 下载转存。**差异**：转存用 KV TTL 15min（上限 15MB，超出时仅 b64_json 可用），上游为内存 map 20MB [简化] |
| `POST /v1/images/edits` | ✅ 完整 | multipart 表单（Workers 原生 formData 解析），operation=edit 复用生成管线 |
| `GET /v1/images/files/<id>` | ✅ 完整 | KV 存储 + metadata contentType，UUID 校验 |
| `GET /v1/sessions` | ✅ 完整 | 解析器会话 + 显式绑定合并列表 |
| `POST /v1/sessions` | ✅ 完整 | session_id 查询/创建语义一致 |
| `DELETE /v1/sessions/{id}` | ✅ 完整 | |
| `/v1/mcp/sse` · `/v1/mcp/message` · `/v1/mcp/tools` | ❌ 未移植 | **[平台+未做]** MCP stdio 传输依赖子进程，Workers 无进程概念（已确认裁剪）；SSE 传输技术上可移植，尚未排期 |

### /api/* 管理端点

| 上游端点 | 状态 | 说明 |
|---|---|---|
| `POST /api/admin/login` | ✅ 完整 | 密码 SHA-256 存 KV（上游明文文件，更安全）。**差异**：失败锁定为 isolate 内存态（5 次/15min），跨 isolate 不共享 [简化] |
| `/api/admin/logout` · `/api/admin/session` | ✅ 完整 | |
| `POST /api/admin/change-password` | ✅ 完整 | 含强制改密门禁、全会话失效 |
| `/api/admin/keys` GET/POST/PUT/DELETE | ✅ 完整 | 仅哈希存储、回读语义一致 |
| `GET /api/admin/models` | ✅ 完整 | |
| `POST /api/admin/models/test` | ✅ 完整 | 真实 ChatHub 连通测试，走管理员会话鉴权 |
| `POST /api/admin/models/sync` | ⚠️ 部分 | CDN bundle tone 探测已移植；但探测结果未接入设置校验的合法 tone 白名单（校验仍用静态 KNOWN_UPSTREAM_TONES）[简化] |
| `GET/PUT /api/admin/settings` | ⚠️ 部分 | 校验规则完整移植。**缺口**：OAuth 相关字段（clientId/authority/redirectUri/scope）保存后**不生效**——上游通过 ApplyStartupSettingsEnv 在启动时把持久化设置灌入环境变量，Workers 的绑定变量在部署时固定，控制台修改无法覆盖 [未做，可通过 wrangler vars 解决]；listenAddress/configPath/tokenCachePath/debugLogPath 等字段在 Workers 上天然无效 [平台] |
| `/api/admin/proxy-pool` | ❌ 已移除 | **[平台→已删除]** Workers fetch 不支持 HTTP/SOCKS 出站代理；应用户要求已彻底移除端点（控制台对应操作将收到 404） |
| `/api/accounts/bind-proxy` | ❌ 已移除 | 同上 |
| `/api/admin/deployments` · `/deployment` · `/deployment/check` | ❌ 占位 | Codex 反向代理部署管理。**原因**：依赖本地文件持久化与自定义反代 URL 管理，与 Worker 无状态模型冲突；控制台对应页签不可用 [未做] |
| `/api/admin/debug/logs` · `/debug/detail` | ❌ 占位 | **[未做]** 上游为内存环形 debug 存储（M365_TRACE=1 时记录请求/响应元数据）；Workers 对应方案是 Workers Logs/tail workers，未移植采集侧 |
| `GET /api/health` | ⚠️ 等价 | accountConcurrency 恒为 `{}`（并发限制器未移植，见下） |
| `GET /api/version` | ⚠️ 等价 | version 为 `0.5.0-cfworker.x` 标识；go 字段填 `cloudflare-workers`；uptimeSeconds 恒 0（isolate 无常驻概念）；proxyPool 计数字段已随代理池移除 [平台] |
| `GET /api/update` | ✅ 等价 | 上游本身即为只读 stub（updateAvailable 恒 false） |
| `GET /api/accounts` | ✅ 完整 | 冷却/健康快照来自 KV；callCount 恒 0（计数器随并发限制器一并省略）|
| `POST /api/accounts/refresh` | ✅ 完整 | EnsureValid 单飞防抖（isolate 内） |
| `POST /api/accounts/schedule` | ✅ 完整 | |
| `/api/accounts/token-health` GET/POST | ✅ 完整 | expires_in 格式为纯秒数（上游为 Go duration 字符串），仅显示差异 [简化] |
| `POST /api/accounts/clear-cooldown` | ✅ 完整 | |
| `POST /api/accounts/delete` | ✅ 完整 | |
| `POST /api/accounts/provision` | ✅ 完整 | ROPC 密码流移植 |
| `GET /api/auth/start` · `/status` · `/callback` | ✅ 完整 | PKCE S256、state KV TTL 600s、粘贴回调 URL 兼容、loopback 自动关窗页 |
| `POST /api/chat` | ✅ 完整 | |
| `POST /api/chat/stream` | ✅ 完整 | 归一化事件+语义事件+done 帧，与上游同为完成后发送 |
| `GET /api/conversations` | ⚠️ 简化 | 返回显式绑定（sessions.json 等价物）。上游同源；形状含 id/conversationId/title 等，兼容控制台 |
| `POST /api/conversations/delete` | ✅ 完整 | 本地索引+绑定联动删除 |
| `POST /api/conversations/cleanup` | ❌ 占位 | **[未做]** conversation_manager 的 after_response/keep_n/max_age 三种清理模式未移植；云端回收由 Cron 自动清理承担（见下） |
| `/api/conversations/whitelist` | ❌ 占位 | **[未做]** 白名单机制未移植（自动清理的保护集目前只含活跃会话与最近使用记录） |
| `GET /api/m365/conversations` | ⚠️ 简化 | 云端列表已移植（RefreshNavPane action API）。**缺口**：上游会把解析器会话合并进列表（gateway 来源标记、chatName 从历史推导、messageCount 统计），本移植仅返回云端原始行 [未做] |
| `GET /api/m365/conversations/detail` | ❌ 占位 | **[未做]** 应返回解析器 ContextHistory 消息数组供控制台对话查看器使用，当前返回空 |
| `POST /api/m365/conversations/delete` | ✅ 完整 | 云端 DeleteConversation + 本地联动 |
| `POST /api/m365/conversations/cleanup` | ❌ 占位 | 循环拉取清空全部对话的逻辑未移植；Cron 自动清理是受预算约束的等价物 [简化] |
| `GET /api/stats` · `POST /api/stats/reset` | ✅ 完整 | 缓存命中统计真实数据（KV） |
| `GET /api/usage` · `/api/usage/logs` | ⚠️ 等价 | 聚合口径一致。**存储差异** [简化]：KV 日桶（90 天过期、单桶 5000 条上限）替代 usage.jsonl 的 5 万条滚动窗口；Free 计划面板最多回读约 30 桶 |
| `/` · `/login` · `/conversation` | ✅ 完整 | Static Assets 托管原版 HTML |
| （未注册路径 fallback） | ✅ | 404 OpenAI 错误格式 |

---

## 二、核心机制对照

| 上游机制 | 状态 | 说明 |
|---|---|---|
| ChatHub SignalR 协议（握手/\x1e 分帧/ping/type1-3 帧/writeAtCursor 快照去重/限流文案检测/5min 总超时/90s 读超时） | ✅ 逐字移植 | `src/chathub/*` |
| WS URL 构造（variants/source 引号等协议细节） | ✅ 逐字移植 | |
| UploadFile 图片上传（form-urlencoded + feature gate 头 + jpeg→jpg 规范化） | ✅ 完整 | |
| 多模态注解注入（ImageFile annotation + connectedFederatedConnections + imageBase64/imageUrl 双路径） | ✅ 完整 | |
| 远程图片下载转 data URL | ⚠️ 不同路径 | 上传前先下载远程 https 图转为 data URL 再走 UploadFile；本移植直接把 https URL 放入 message.imageUrl 字段（上游保留的旧网关注入路径）。多数场景可用，未经上游同等测试 [简化] |
| 附件下载 SSRF 防护（ssrf.go：仅 https 公网地址、DNS 解析复查私网/环回/云元数据段） | ❌ 未移植 | **[未做]** 当前接受任意 URL 作为 imageUrl 注入。Workers 出口为 CF 边缘，传统 SSRF 面较小，但仍建议补齐 scheme/host 校验 |
| OAuth PKCE（S256、nativeclient 手动粘贴流、AADSTS 错误归类） | ✅ 完整 | |
| Device Code 流（auth/device.go StartDeviceCode/PollDeviceCode） | — | **[上游死代码]** 上游未挂接任何路由；仅 FOCI clientId 影响 refresh endpoint 选择，该逻辑已移植 |
| ROPC 密码登录 | ✅ 完整 | |
| Token 刷新单飞防抖（AAD 刷新令牌一次性） | ⚠️ isolate 内 | 跨 isolate 并发刷新可能竞态；个人自部署概率极低 [简化] |
| 账号轮询 round-robin | ✅ 完整 | nextIdx 持久化 KV |
| 账号健康（限流冷却/auth 失败冷却/MarkSuccess 清除/最早恢复时间） | ✅ 完整 | KV 持久化 |
| 账号并发限制（account_concurrency.go，默认每账号 8） | ❌ 未移植 | **[未做]** 需要 Durable Object 原子计数器才能跨 isolate 强一致；当前靠上游 429 自然背压 |
| 故障转移（429/401/403 且未钉定账号/会话时换号重试） | ✅ 完整 | |
| 内容键会话复用（显式 ID > 严格前缀 > 同后缀 ≥2；IP+UA 指纹隔离；512 条历史上限；LRU 1000） | ✅ 逐字移植 | README 所述"Jaccard 相似度兜底"在上游代码中并不存在（文档滞后），实际为前后缀匹配，已如实移植 |
| 会话/上下文 TTL 环境变量（SESSION_TTL/CONTEXT_TTL_MINUTES） | ❌ 固定 2h | **[未做]** 环境旋钮未读取（M365_CONTEXT_SIMILARITY 上游代码中亦不存在） |
| 用户级会话（body.user → userSessionStore 固定账号+对话） | ❌ 未移植 | **[未做]** openaiChat 的 User 分支及其 Put/Get 未实现 |
| 对话缓存 convCache（account+model 维度 system-prompt-hash 增量复用） | ❌ 未移植 | **[未做]** 与会话复用重叠度高，独立收益有限；上游命中时可省系统提示词重建延迟 |
| 自动清理（闲置 2h / keepN=5 / 活跃保护集 / 删除联动解绑 / 100 轮滑动窗口） | ✅ 完整 | Cron 每 30 分钟执行；新增单次 30 个删除预算（Free 子请求限制保护）[简化] |
| 白名单（conversationManager.WhitelistedIDs 进保护集） | ❌ 未移植 | 见路由表 |
| WS 连接池（connpool.go Take/Return 复用） | ❌ 裁剪 | **[平台]** isolate 无法跨请求持有连接；每请求新建（上游 Dialer 直连路径同样支持） |
| 连接预热（preheater.go） | — | **[上游死代码]** 上游 Preheater 本身就是 stub（Take 返回 nil、Stats 返回 mode:stub），无功能损失 |
| Function calling router 模式 | ✅ 完整 | CALL_TOOL/JSON 信封/修复轮/并行自适应限制（exec 类串行） |
| Function calling fenced 检测（```bash 自动转换+裸 JSON command 扫描+声明校验） | ✅ 完整 | |
| 流式围栏扣留（疑似工具调用文本不外流，确认后整体转分片 tool_calls） | ✅ 完整 | rune 边界保持 |
| 原生事件工具检测（native_tools.go walk） | ✅ 完整 | |
| JSON Schema 校验信任边界 | ✅ 完整 | object/array/string/number/integer/boolean/null/enum/required/additionalProperties |
| `<m365-tool-call>` 协议块提取 | ✅ 完整 | |
| 工具响应写出（流式 512B 参数分片 + finish_reason=tool_calls + usage chunk） | ✅ 完整 | |
| **Native 规划模式注入**（planningMode=native 时把 tools 作为 ChatHub payload `plugins` 下发 + MCPServerURL 插件桥接） | ❌ 未移植 | **[未做]** chatPayload 恒发空 plugins；settings 的 toolPlanningMode=native 目前无实际效果，一律走 router/事后检测路径。影响需要云端原生规划的场景 |
| Agent ledger（证据链 RouterContext/CanContinue 轮次熔断/completionEvidenceAllows 收尾校验） | ❌ 未移植 | **[未做]** router 提示词中的"已完成调用不得重复"规则已保留，跨轮证据链与轮次硬限制缺失 |
| validateToolConversation（tool 消息格式前置校验） | ❌ 未移植 | **[未做]** 格式异常消息会进入 flatten 渲染而非 400 拒绝 |
| 工具进度卡（tool_progress.go parseToolProgress + Progress 事件转发） | ⚠️ 部分 | Responses 转换无条件跳过该类项；聊天流内 Progress 事件不透传（上游在 chatStream 语义事件里透传——该部分已移植） |
| Codex 模型目录（capabilities 双位置/effort 预设/truncation policy 等 60+ 字段） | ✅ 完整 | |
| 动态 tone 探测（CDN main.*.js 正则抓取） | ⚠️ 部分 | sync 接口可用；未接入目录/校验白名单（见路由表） |
| 用量估算 EstimateTokens（rune×2/3） | ✅ 完整 | |
| Codex usage tiktoken o200k | ⚠️ 启发式 | Worker 不内置词表；heuristic_character_estimate 口径，m365.usage_source 如实标注 [简化] |
| public_identity 公开身份策略（M365_PUBLIC_IDENTITY_POLICY 总开关、身份预设、正文/推理/流式清洗器） | ❌ 未移植 | **[未做]** 上游默认关闭的可选特性（20KB），面向公开反代场景清洗微软痕迹；个人自部署收益低 |
| sanitizePublicAssistantTextForModel 等清洗 | ❌ 未移植 | 随 public_identity 一并归属；基础错误脱敏（不泄 token/URL）已由 describeUpstream 覆盖 |
| 兼容元数据 m365.events（M365_INCLUDE_UPSTREAM_EVENTS=1 时附带原始事件） | ❌ 未移植 | **[未做]** 小开关，非默认行为 |
| normalizeJSONText / response_format json(_schema) 注入 | ✅ 完整 | |
| estimateResponsesUsage 协议帧常数 | ✅ 完整 | 常数一致，计数器为启发式 |
| previous_response_id 历史租户隔离 + 1h 过期 + 容量上限 | ⚠️ 等价 | 上游内存 map（每租户 maxResponsesPerTenant+1h）；KV TTL 版无容量上限（TTL 自然清理）[简化] |
| 管理员安全（强制改密/会话 Cookie HttpOnly+SameSite/SameSite=Lax/登出失效/X-Forwarded-Proto Secure 判定） | ✅ 完整 | |
| 安全响应头（nosniff/X-Frame-Options/Referrer-Policy） | ✅ 完整 | |
| 完整 CSP 头（style/script 白名单域名等） | ❌ 页面缺失 | **[未做]** Static Assets 直接服务页面绕过了 Worker 头注入；需 `_headers` 文件补 CSP |
| X-Request-ID 响应头关联 | ❌ 未移植 | **[未做]** 内部已生成 requestId 用于日志，但未写入响应头 |
| httpTrace 访问日志中间件 | ❌ 未移植 | **[未做]** Workers 自带请求日志（wrangler tail / dashboard）覆盖同一需求 |
| recover 中间件 | ✅ 等价 | fetch 入口 try/catch 500 JSON |
| 数据文件原子写（atomicfile 0600） | — | **[平台]** KV 无文件语义；敏感数据仅存哈希或服务端密文边界内 |
| 后台落盘循环 persistStore | — | **[平台]** KV 即时写替代 |
| graceful shutdown | — | **[平台]** 无常驻进程概念 |
| manage.py / Dockerfile / docker-compose | — | 由 wrangler dev/deploy 替代 |
| pkce_auth_gateway.py 本地回调网关 | — | Workers 部署无需；nativeclient 粘贴流 + loopback 自动关窗页均可用 |
| scripts/*.py 探针 | — | 开发期工具，不属于运行时 |
| 测试套件（go test ./...） | ⚠️ 等价替换 | vitest 57 例覆盖协议/解析器/工具/转换/错误体系关键路径；上游集成类测试（真实 WS 往返）不在单元范围 |

---

## 三、环境变量对照

| 变量 | 状态 |
|---|---|
| ADMIN_PASSWORD / M365_BROWSER_* / M365_CLIENT_ID / M365_AUTHORITY / M365_REDIRECT_URI / M365_SCOPE / M365_DEVICE_* | ✅ 生效（vars/secrets） |
| M365_CHAT_TIMEOUT_SECONDS / M365_AUTO_CLEANUP* | ✅ 生效 |
| M365_INCLUDE_UPSTREAM_EVENTS | ❌ **[未做]** 随 m365.events 元数据开关未移植 |
| M365_LISTEN / M365_DATA_DIR / M365_CONFIG / M365_TOKEN_CACHE / M365_SESSION_CACHE / M365_API_KEYS / M365_USAGE_LOG / M365_DEBUG_LOG / M365_PERSIST_INTERVAL | — **[平台]** 无文件系统/端口概念 |
| M365_PROXY_POOL / M365_PROXY_INSECURE_TLS / M365_PROXY_HEALTH_URL / outbound.EnvProxy | ❌ **[平台]** 代理池裁剪 |
| M365_SESSION_TTL_MINUTES / M365_CONTEXT_TTL_MINUTES | ❌ **[未做]** 固定 2h 默认值 |
| M365_CONTEXT_SIMILARITY | — **[上游死代码]** 代码中不存在 |
| M365_MAX_TOOL_CALLS_PER_TURN / M365_MAX_TOOL_ROUNDS | ⚠️ 前者经 settings 生效；后者属 agent ledger 轮次熔断，随 ledger 未移植 |
| M365_PUBLIC_IDENTITY_POLICY | ❌ 随 public_identity 未移植 |
| M365_TRACE | ❌ **[未做]** 详细 trace 日志未实现（console.error 关键路径已有） |
| M365_USER_SESSION_TTL_MINUTES / M365_ACCOUNT_DEFAULT_CONCURRENCY | ❌ 随用户会话/并发限制器未移植 |
| M365_AUTHORIZE_ENDPOINT / M365_TOKEN_ENDPOINT / M365_DEVICE_ENDPOINT / M365_DEVICE_TOKEN_ENDPOINT | ⚠️ authorize/token 主端点可由 authority 推导覆盖；四个精确端点覆写变量未单独读取 |

---

## 四、控制台功能影响评估

| 控制台页签/功能 | 影响 |
|---|---|
| 登录/改密/仪表盘/账号/API Keys/用量/缓存统计/模型测试/设置（运行时字段） | ✅ 可用 |
| 「对话」页列表+删除 | ✅ 可用（列表不含 gateway 合并行，查看器详情按钮打开后无历史内容） |
| 「对话」页查看器详情（conversation.html?id=） | ⚠️ 打开但无消息内容（detail 端点占位） |
| 「代理池」页 | ✅ 已彻底移除：导航入口、页面区块、账号表 Proxy 列/Bind 按钮、相关 JS 函数与 showPage 钩子均从 `assets/index.html` 删除（内联脚本通过 node --check 校验）；i18n 词典残留少量不可见死键，不影响任何功能 |
| 「部署」页 | ❌ 空数据（deployments 占位） |
| 「调试日志」入口 | ❌ 空数据（debug 占位） |
| 设置页 OAuth 字段修改 | ⚠️ 保存成功但不生效（见 settings 行说明） |

---

## 五、优先级建议（如继续迭代）

1. **高**：`/api/m365/conversations` 合并解析器会话 + `detail` 返回 ContextHistory（控制台体验闭环）
2. **高**：附件 SSRF 校验（scheme/host 白名单级即可）与远程图先下载再上传对齐上游
3. **中**：native 规划模式 payload 注入（tools → plugins），否则该设置形同虚设
4. **中**：SESSION/CONTEXT TTL 旋钮读取；X-Request-ID 响应头；页面 CSP（assets `_headers`）
5. **低**：userSessions、convCache、agent ledger、whitelist、conversation_manager 清理模式、MCP SSE、public_identity
