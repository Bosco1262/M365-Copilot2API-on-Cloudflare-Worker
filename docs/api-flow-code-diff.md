# API 访问流程代码逻辑对比审计

**当前仓库**：`M365-Copilot2API-on-Cloudflare-Worker`（TypeScript / Cloudflare Workers）
**上游仓库**：`M365-Copilot2API-main`（Go）
**依据**：`docs/backend-correspondence.md` 的模块映射
**审计范围**：整个 API 访问流程 —— 入口/路由 → 鉴权 → 请求准备 → 账号选择/并发 → ChatHub 协议层（SignalR WS）→ 流式/工具调用 → 响应组装
**审计日期**：2026-08-27
**方法**：按 `backend-correspondence.md` 映射逐模块通读两侧源码，对核心路径做逐行对比。以下差异均标注 `文件:行号` 可回溯。

---

## 0.5 修复状态（2026-08-27 更新）

本次审计的全部 **A 级（8 项）与 B 级（14 项）** 已在本轮修复中落地。修改涉及：

- `src/chathub/protocol.ts`：variants 62 项、DEFAULT_TONE=Magic、WS URL 三参数、locale/tz/deviceOS、optionsSets 42 项 + 8 feature flags、clientInfo 9 字段、arg0 扩展字段、allowedMessageTypes 30 项、Metrics 真实时间戳、isStartOfSession=false、toolProtocolPrompt、Result 扩展、imageLimit/contentPolicy 检测、StripCitationMarkers
- `src/chathub/client.ts`：writeAtCursor token 级 delta、finalizeText 调和、Result 全量解析、onTool 事件管道、三层检测器
- `src/errors.ts`：ImageLimitError / ContentPolicyError + 判定函数
- `src/pipeline/contextBudget.ts`（新增）：滑动窗口预算（A2）
- `src/pipeline/account.ts`：markImageLimited（A7）
- `src/api/openai.ts`：canFailover 守卫（A1）、预算/工具校验接入（A2/A3）、流式 onTool + repair（A4/A5）、图片回传（A6）、imageLimited 标记（A7）、locale 接线（B4）、C14 元数据头
- `src/api/anthropic.ts`：failover 已流守卫（A1 同步）
- `src/api/responses.ts`：custom_tool_call / custom exec 桥接 + progress 校验（A8）
- `test/chathub.test.ts`、`test/responses.test.ts`：断言更新至新协议行为

验证：`tsc --noEmit` ✅，`vitest run` 167/167 ✅，`wrangler deploy --dry-run` ✅。

| 级别 | 问题 | 状态 |
|---|---|---|
| A1 | failover 守卫语义 | ✅ `canFailover(prepared, err)` + 流式 `emittedAny` 守卫 + resolver 会话清除 + 第二账号错误 |
| A2 | 上下文预算 | ✅ `src/pipeline/contextBudget.ts` slidingWindow + 400/截断头 |
| A3 | 工具消息校验 | ✅ `validateToolConversation`（400 tool_protocol_error） |
| A4 | 流式原生工具事件 | ✅ `ChatHandlers.onTool` + client extractToolEvents + 流式 streamedTools 优先 |
| A5 | 无效工具 repair | ✅ 流式 REPAIR RULE + 非流式 native-recovery |
| A6 | 图片多模态回传 | ✅ `downloadImageAsDataURI` → image_url 块 |
| A7 | 图片额度/内容策略标记 | ✅ client 层 ImageLimitError/ContentPolicyError + `markImageLimited` |
| A8 | custom exec 桥接 | ✅ responses.ts custom_tool_call + workspace 指令 |
| B1 | variants 62 项 | ✅ |
| B2 | DEFAULT_TONE=Magic | ✅（web 层 magic fallback 保持小写，与上游一致） |
| B3 | WS URL 三参数 | ✅ |
| B4 | locale/tz/deviceOS 请求头解析 | ✅ `parseLocaleFromHeaders` |
| B5 | optionsSets 42 项 + flags | ✅ |
| B6 | clientInfo 9 字段 | ✅ |
| B7 | arg0 扩展字段 | ✅（previousMessages 由调用方可选传入） |
| B8 | allowedMessageTypes 30 项 | ✅ |
| B9 | Metrics 真实时间戳 | ✅ |
| B10 | isStartOfSession=false | ✅ |
| B11 | 无工具 prompt 前缀 | ✅ `toolProtocolPrompt` 内嵌 chatPayload |
| B12 | writeAtCursor token 级 delta | ✅ |
| B13 | finalizeText 调和 | ✅ |
| B14 | Result 全量字段 | ✅（含 C14 元数据头输出） |

**第二轮已修复的 C 级**（2026-08-27）：C2 附件远程下载 + SSRF（scheme/IP/redirect 防护）、C3 DialError kind 分类（QUOTA_429 等 + classifyTransportError）、C4 lastHealthyAccount 偏好、C7 convCache 键粒度（account+model，去 API key 维度）、C9 Anthropic tool_use 结构化转换、C10 stop_sequences、C12 Responses 流式增量转换（streamResponsesAdapter 移植）、C14 流式元数据（x_m365_throttling/scores + m365-metrics，与 B14 同批完成）、C15 /v1/images/files/ 路由豁免、C17 CopilotTempSession、C18 控制台流引用标记剥离。**C8 核对后无需修复**——上游 `agent_ledger.go:66-68` 的 scopedCallID 实际就是 `"call_"+uuid.NewString()`（scope 参数未使用），与 TS 行为一致。

**仍保留的 C 级差异**：C1 WS 连接池（Workers 平台限制）、C5 并发门控降级语义（DO 未绑定时静默不门控，有意保留）、C11 Anthropic 流式形态（TS 真增量优于上游重放，保留）、C16 admin 密码未配置检查。

**第四轮（2026-08-27 晚间，A3/A5/A9/A10 批量修复）**：

| # | 差异 | 状态 |
|---|---|---|
| E1 | A3 兼容元数据 m365.events（`M365_INCLUDE_UPSTREAM_EVENTS`） | ✅ `m365Metadata` 升级为 `compatM365Metadata` 全字段版（throttling/suggestedResponses/offense/scores/conversationTransferToken/meteringInformation/spokenText/timestamps/storageMessageId/citations），events 开关按 envTrue 判定 |
| E2 | A5 限流确认探测（confirmRateLimitNotice） | ✅ 新增 `markFailureAfterConfirm`：`RateLimitNotice` 时用新会话发 "Reply with exactly: OK"（tone magic，30s）探测，成功=假阳性不冷却，再限流=确认冷却；接入 failoverChat/非流式 catch/流式 catch。上游函数本身为死代码（未接线），TS 侧按语义接线 |
| E3 | A9 AAD 精确端点覆写（4 个 env） | ✅ `oauthConfig`/`effectiveOAuthConfig` 支持 `M365_AUTHORIZE_ENDPOINT`/`M365_TOKEN_ENDPOINT`/`M365_DEVICE_ENDPOINT`/`M365_DEVICE_TOKEN_ENDPOINT`，env 精确值优先于 authority 推导；ROPC 端点统一走 `cfg.tokenEndpoint`（原硬编码 organizations 路径） |
| E4 | A10 Responses 历史隔离 | ✅ 键升级 `resp-history/{tenant}/{session}/{id}`（`tenant\0session` 双隔离），StoredHistory 存 tenant/sessionId 并在 load 时校验；put 带 metadata.at，`maxResponsesPerTenant=256` 超限 list 前缀删最旧；MockKV 补 list 支持 |

**第三轮（2026-08-27 下午，opencode 工具调用问题联动）**：

| # | 差异 | 状态 |
|---|---|---|
| D1 | **流式 router 预调用缺失**（本审计 §0 流程图的 [router 模式] 步骤在 TS 仅实现于非流式；上游 server.go 流式路径 1810-1881 在 `stream:true + tools` 时先跑 `modelToolRouterPrompt` 预调用，命中即输出 tool_calls，NO_TOOL_NEEDED 才 fall-through 到文本流式。缺它导致流式请求的模型在 answer turn 看不到工具定义 → GPT-5.x 回落到自带 `/mnt/data` 沙箱幻觉） | ✅ 已补齐（`streamChatCompletions` 预调用块，与上游 1810-1881 对齐，含 failover + NO_TOOL_NEEDED fall-through） |
| D2 | **holdback 尾缓冲 8-rune**（上游已从 8 改为 3：`server.go:1962` "replaces the old 8-rune threshold with a 3-rune buffer (enough to detect ```)"） | ✅ 已对齐（`src/api/holdback.ts` RUNE_HOLDBACK 8→3，含测试更新） |
| D3 | prompt 级工具协议注入（`injectToolProtocol`，应对 `toolProtocolPrompt` 的 `hasPlugins` 恒 true 死代码，使流式/非流式/Anthropic 三条路径的模型都能看到 `<tools>` 定义与反沙盒指令） | ✅ 已实施（`prepareCore` 末尾注入；Go 版 `clientPlugins` 同样恒产插件，注入同样失效——该差异为上游与移植共同存在的问题，TS 侧已先行绕过） |

---

## 0. 端到端流程对照

```
┌─ 上游 Go（server.go openaiChat, 1608 行起）─────────────────────────────┐
│ POST /v1/chat/completions                                                │
│  ├─ 10MiB 请求体上限 + bad json                                          │
│  ├─ reasoningTone(model, effort)                                         │
│  ├─ normalizeLegacyTools(functions→tools)                                │
│  ├─ validateToolConversation(messages)  ← tool_call_id 强制校验           │
│  ├─ buildAgentLedger + CanContinue(maxToolRounds) → 409 tool_round_limit │
│  ├─ slidingWindow(context_budget)  ← 上下文滑窗截断 + 截断头              │
│  ├─ flattenPromptMessages → attachments                                  │
│  ├─ publicIdentityAnswer（可选特性，默认关）                               │
│  ├─ sessionKey / userSessions / CopilotTempSession / sessionResolver      │
│  ├─ resolveAccount（lastHealthyAccount 偏好 + 冷却 + 并发检查 → 429）      │
│  ├─ convCache Lookup（acc.ID+model+sysHash）                              │
│  ├─ MCP：mcpServerURL 注入 + GlobalToolRegistry.MergeTools                │
│  ├─ [router 模式] modelToolRouterPrompt → chatWithAccount →              │
│  │    parseModelToolDecision → filterCompletedCalls → scopedCallID →     │
│  │    repair（未解析时）→ required-retry（required 无选择时）              │
│  ├─ [流式] chatWithAccountEvents：onEvent 收原生 tool 事件（边流边收）     │
│  │    + pending 围栏 holdback（3-rune 尾缓冲）                            │
│  │    + failover 守卫：text.Len()==0 && 无 streamedTools && 仅限流/鉴权   │
│  ├─ [非流式] chatWithAccount → tone=magic 兜底 → failover（限流/鉴权）    │
│  ├─ tool 检测：fenced → native → native-recovery(router) → 无效工具 repair│
│  ├─ contentPolicy 503 / imageLimit 标记 / completionEvidence 门禁         │
│  └─ 响应：m365 元数据 + X-M365-Throttling/Scores/Metrics 头 +             │
│       Images→image_url 多模态块 + usage                                   │
└──────────────────────────────────────────────────────────────────────────┘

┌─ 当前仓库 TS（api/openai.ts runCompletionsCore/streamChatCompletions）──┐
│ POST /v1/chat/completions                                                │
│  ├─ bad json                                                             │
│  ├─ reasoningTone（✅ 等价）                                              │
│  ├─ normalizeTools（✅ functions→tools）                                  │
│  ├─ ✗ validateToolConversation 缺失                                       │
│  ├─ ledgerCanContinue（✅ 等价，仅 router 分支）                           │
│  ├─ ✗ slidingWindow 缺失（长上下文全量发送）                               │
│  ├─ flattenPromptMessages（✅ 等价）                                      │
│  ├─ sessionKey / userSessions / sessionResolver / convCache（✅）         │
│  ├─ resolveAccount（⚠️ 无 lastHealthyAccount 偏好；并发门控可降级静默）    │
│  ├─ MCP：mcpServerUrl + globalToolRegistry（✅）                          │
│  ├─ [router 模式] 等价 + scopedCallID 缺失（用全局 uuid）                  │
│  ├─ [流式] ✗ 无 onEvent 工具事件管道（事后从 events 提取）                │
│  │    + holdback（8-rune 尾缓冲，上游 3-rune）                             │
│  │    + ✗ failover 无"已流内容"守卫（无条件切换）                          │
│  ├─ [非流式] tone=magic 兜底（✅）+ failover（⚠️ 任何错误都切换）          │
│  ├─ tool 检测：fenced → native（✅）但 ✗ 无 repair / required-retry        │
│  ├─ contentPolicy 503（✅）+ ✗ imageLimit 标记缺失                         │
│  └─ 响应：m365 元数据精简版；✗ 无 throttling/scores/timestamps 头；       │
│       ✗ Images 不回传；usage（✅）                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 1. 差异清单（按严重度分组）

### 🔴 A 级 — 功能缺失 / 行为偏差，影响可用性

| # | 差异 | 上游（Go） | 当前（TS） | 影响 |
|---|---|---|---|---|
| A1 | **failover 守卫语义不同** | 非流式：`err!=nil && !convReused && 无绑定 && (IsRateLimited\|\|IsAuthFailure)`；流式额外要求 `text.Len()==0 && len(streamedTools)==0`（`server.go:2002,2361,2476`） | `failoverChat` 只要 `canFailover()`（无 accountID/conversationID）就切换，**不区分错误类型、不检查是否已流内容**（`openai.ts:542-564,1021-1031`） | ① 非限流错误（如 EmptyCompletion、TCP 断连）也会无谓换号；② **流式已发出部分内容后再失败会换号重流，客户端看到两段重叠内容**；③ 上游 failover 失败时返回第二账号的真实错误，TS 抛回 `firstErr` 丢失信息 |
| A2 | **上下文预算（context_budget）缺失** | `slidingWindow(body.Messages, ContextWindow-MaxOutput-512)`，超限 400 `context_length_exceeded`，截断时置 `X-M365-Context-Truncated: 1`（`server.go:1661-1675`） | 无任何滑窗/预算逻辑，messages 全量发送 | 长上下文请求可能超 M365 上下文窗口导致上游截断/空回复；无截断告警头 |
| A3 | **工具消息校验缺失** | `validateToolConversation`：tool 消息必须有 `tool_call_id`，未知 id 拒绝（`server.go:1647`，`toolloop.go:153-165`） | 无对应调用（`tools.ts` 无 validateToolResult 入口） | 格式错误的 tool 消息直接送上游，可能产生空回复/卡死 |
| A4 | **流式原生工具事件管道缺失** | `chatWithAccountEvents` + `onEvent` 边流边收 `kind=="tool"` 事件（`account_concurrency.go:125`，`client.go:768-779`） | `ChatHandlers` 只有 onDelta/onReasoning；工具调用只能等响应完整后从 `res.events` 提取（`client.ts:21-24`） | 工具调用帧本身不会被 holdback 拦截（上游对 tool 帧不触发文本）；检测时序延迟，极端情况下 fence 提前泄露 |
| A5 | **无效工具 repair 缺失** | 流式/非流式路径对 `rejected>0` 的工具调用做 repair 二次调用（`server.go:2128-2149,2604-2625`） | 流式路径无 repair（`openai.ts:1036-1068` 直接丢弃无效调用）；非流式也无 | 上游选了未声明/非法工具时 TS 直接丢掉工具调用，客户端收不到 tool_calls |
| A6 | **图片多模态响应不回传** | 非流式 content 将 `res.Images` 下载转 data URI 后作为 `image_url` 块返回（`server.go:2705-2712`） | `res.images` 被解析但响应只回 `content: res.text`（`openai.ts:911-926`） | 图像生成类请求（Designer/图形生成）在 TS 网关拿不到图片结果 |
| A7 | **图片额度 / 内容策略错误标记缺失** | `ErrImageLimit`（检测"无法生成更多图像"）、`ErrOffensiveContent`（内容策略 7 条模式）在 client 层直接抛出，web 层 `MarkImageLimited` 特殊处理（`client.go:34,568-580,986-1047`） | TS client 只检测 `rateLimitedText`（`protocol.ts:252`）；web 层只有 `isContentPolicyBlock`（`tools.ts:566`），**无 imageLimit 检测、无 imageLimited 账号标记** | 图片额度耗尽时 TS 把错误当普通文本/通用错误返回，且账号不会进入 imageLimited 冷却 |
| A8 | **custom_tool_call / Codex exec 桥接缺失** | Responses 转换支持 `custom_tool_call` + `custom exec` 工具 + `customExecWorkspaceInstruction` 注入（`protocol_compat.go:78-99,118-148`） | `responses.ts:140-141` 对 `custom_tool_call` 直接 `continue`，custom 工具仅透传（`responses.ts:162-178`） | Codex/OpenCode exec 执行桥在 TS 不可用 |

### 🟠 B 级 — 协议载荷差异（可能影响上游行为/特性开关）

| # | 差异 | 上游（Go） | 当前（TS） |
|---|---|---|---|
| B1 | **variants 长度** | 62 项（`client.go:173`），多出 21 项：`feature.EnableImageGenInsufficientTokensThrottled`、`feature.EnableImageGenSystemCapacityThrottled`、`feature.EnableConversationShareApis`、`IsCitationsReferencesOutputEnabled`、`enableDeltaStreamingForReferences`、`enableIncludeReferencesInDeltaResponse`、`enablereferencesforagents`、`EnableMergingPureDeltas`、`EnableRemoveStreamingMode`、`EnableCodeInterpreterConversion`、`agt_module_attr_enableReferencesForCodeInterpreter`、`agt_module_enableCodeInterpreterHallucinatedUrlFilter`、`SingletonEnvOn`、`cdxenablefccinmainline`、`EnableComposeWidget`、`EnableContentApiandDocTypeHtmlInRichAnswers`、`cdxgrounding_api_v2_rich_web_answers_reference_bottom_force`、`cdxenablerenderforisocomp`、`EnableSkipRehydrationForSpeCIdImages`、`EnablePersonalization`、`EnableBase64DataInMessageAnnotations`、`EnableSkipEmittingMessageOnFlush`、`EnableRemoveEmptySourceAttributions`、`agt_researcheragent_enableMemoryRead` | 41 项，结尾 `Agt_bizchat_enableGpt5ForHelix`（`protocol.ts:21`） | 引用（references）、图片生成节流、代码解释器转换等特性在 TS 网关的会话中未启用 |
| B2 | **默认 tone** | `defaultTone = "Magic"`（大写 M，`client.go:164`） | `DEFAULT_TONE = "Magic"`（大写，`protocol.ts:15`） | **已解决（2026-08-28）**：官方确认 tone 为 `Magic`，全库统一大写（含图片生成/限流探测/empty 兜底/modelTone） |
| B3 | **WS URL 参数** | 多 `XRoutingParameterSessionKey`、`isEdu=false`、`disableMemory=1`（`client.go:1129-1162`） | 无这三项（`protocol.ts:105-121`） | 路由亲和/教育租户/内存开关行为差异 |
| B4 | **locale/tz/deviceOS** | 从请求头 `X-M365-Locale`/`Accept-Language`/`X-M365-Market`/`X-M365-TimeZone`/`X-M365-DeviceOS` 解析（`server.go:2900-2940`），默认 en-us/UTC/Windows | 硬编码 `zh-cn` / `Asia/Shanghai` / +8，无 deviceOS（`protocol.ts:143`） | 非中文用户收到中文 locale 载荷；时区硬编码 +8 |
| B5 | **optionsSets** | 42 项，含 `cwc_code_interpreter` 系列 6 项、`flux_v3_references*` 3 项、`rich_responses`、`add_filestore_filetype` 等 + 8 个 FeatureFlags 开关（DeepWork/ComputerUse/RealtimeVoice/SystemPromptOverride/DesignerImageGen4o/CodeCanvas/SydneyReconnect，`client.go:1421-1478`） | 14 项精简集，仅 memoryV2 开关（`protocol.ts:178-196`） | 代码解释器、实时语音、深度工作、图像维度等上游特性在 TS 载荷中不可用 |
| B6 | **message.clientInfo** | message 内嵌 9 字段 clientInfo（clientEntrypoint/clientSessionId/ProductCategory/clientAppType/productEntryPoint/deviceOS/deviceType/clientPlatformVersion）（`client.go:1344-1355`） | 无（TS 的 clientInfo 在 arg0 层仅 clientPlatform/clientAppName 2 字段，`protocol.ts:220-223`） | 载荷形态与浏览器探测不一致 |
| B7 | **arg0 扩展字段** | `previousMessages`、`extraExtensionParameters`、`isSbsSupported`、`renderReferencesBehindEOS`、`disconnectBehavior`（`client.go:1509-1514`） | 缺上述字段；多了 `productThreadType: "Office"`（`protocol.ts:219`） | 侧边栏渲染、断开续传行为差异 |
| B8 | **allowedMessageTypes** | 30 项（含 InternalSearchQuery/GeneratedCode/RenderCardRequest/AdsQuery/SemanticSerp/GenerateContentQuery/GenerateGraphicArt/SearchQuery/ConfirmationCard/AuthError/DeveloperLogs/TriggerPlugin/HintInvocation/MemoryUpdate/TriggerConfirmation/ResumeInvokeAction/ResumeUserInputRequest/TriggerUserInputRequest/EscapeHatch/TriggerPluginAuth/ResumePluginAuth/SideBySide/ReferencesListComplete/SwitchRespondingEndpoint，`client.go:1485-1496`） | 6 项（Chat/Suggestion/Disengaged/Progress/EndOfRequest/InternalLoaderMessage，`protocol.ts:206-213`） | 搜索/图形生成/插件/记忆等消息类型在 TS 会话中不会被上游发送 |
| B9 | **Metrics 帧时间戳** | 真实 RFC3339Nano 时间戳（ConnectionStart/UserInputStart/ConnectionEstablished/UserInputSubmit/RequestSent）（`client.go:1524-1544`） | 空字符串占位（`protocol.ts:235-247`） | 遥测/时序分析无意义 |
| B10 | **isStartOfSession** | 恒 `false`（HAR 12/12 样本证据，`client.go:1502`） | 首轮 `firstTurn=true` 时置 `true`（`protocol.ts:218`） | 与已验证浏览器行为不一致 |
| B11 | **无工具 prompt 前缀** | `chatPayload` 内嵌 `toolProtocolPrompt`：无工具且无 plugins 时加 "Please answer the following request in full. Do not truncate or abbreviate your response."（`tool_protocol.go:12-18`） | TS 直接用原文，无前缀 | 上游防截断提示词在 TS 缺失 |
| B12 | **writeAtCursor 增量粒度** | streamed 非空时直接 `emitDelta`（token 级），否则 `emitSnapshot`（`client.go:820-837`） | 恒走 `emitSnapshot`（`client.ts:315-324`） | TS 流式 chunk 更粗（上游 33-47 帧 → 2-3 大块的问题在 TS 复现） |
| B13 | **type-3 finalizeText 调和** | 完成帧用 `finalizeText` 补发缺失尾部（issue #51 修复）（`client.go:1108-1123`） | 直接 `streamed || finalText || deltasTotal`，无补发（`client.ts:370-372`） | 非前缀重写/尾部丢失时 TS 客户端缺字 |
| B14 | **patches/references/suggestions/offense/scores/transferToken/metering/storageMessageID** | 全量解析进 `chathub.Result`（`client.go:805-942,957-999`） | `ChatResult` 仅 text/reasoning/conversationId/sessionId/requestId/throttling/rawResult/events/images（`protocol.ts:92-102`） | 控制台流（chatStream）与元数据输出能力降级 |

### 🟡 C 级 — 结构/机制差异（等价替代或行为差异较小）

| # | 差异 | 上游（Go） | 当前（TS） |
|---|---|---|---|
| C1 | **WS 连接池** | `ConnPool` 复用 + warm 预热（`connpool.go`，`client.go:393-412`） | 每请求新建连接（Workers 平台限制） | 每请求多一次握手 RTT；无 warm 预连接 |
| C2 | **附件上传** | 支持远程 URL 下载（SSRF 校验 + 重定向防护 + 10MiB 上限 + base64 解码校验）（`client.go:1170-1236`） | 仅 data: URL 直传，无下载/校验（`client.ts:52-101`） | 图 URL 附件上传失败；无 SSRF 防护（对应 `docs/backend-correspondence.md` §五 [未做] `ssrf.go`） |
| C3 | **DialError 分类** | `Kind` 分类：QUOTA_429/OVERLOAD_503/AUTH_EXPIRED_401/FORBIDDEN_403/CLIENT_CANCELED/WS_READ_TIMEOUT/WS_HANDSHAKE/TCP/DNS/TLS/SOCKS5（`client.go:83-121,418-441`） | 仅 status/retryAfter（`errors.ts:17-26`） | 错误诊断与冷却分桶精度降低 |
| C4 | **账号偏好选择** | `resolveAccount` 优先 `lastHealthyAccount`，失败才轮询（`server.go:1041-1052`） | 每次 `nextAccount` 轮询（`account.ts:126-150`） | 高频请求在多个账号间轮转，云端会话碎片化，convCache 命中率下降 |
| C5 | **并发门控降级语义** | `accountConcurrency.Acquire` 失败 → 直接 429（`account_concurrency.go:111-116`） | 门控仅在 DO 绑定时生效，失败/未绑定**静默不门控**（`openai.ts:469-511`） | 无 DO 绑定时完全无并发限制；与上游 429 语义不同 |
| C6 | **限流确认探测** | `confirmRateLimitNotice`：收到 rate-limit notice 后用 "Reply with exactly: OK" 主动探测确认再标记（`server.go:100-131`） | `markFailure` 直接按错误类型标记冷却（`account.ts:54-71`） | 误判率略高（部分假阳性直接冷却 30s） |
| C7 | **convCache 键粒度** | `acc.ID + model + sysHash`（`server.go:1776`） | `apiKeyHash + accountID + model + sysHash`（`openai.ts:313`） | TS 键更细（含 API key），跨 key 不共享缓存；命中率略低但隔离性更好 |
| C8 | **scopedCallID** | router 决策路径用 `scopedCallID(name,args,i,scope)`（消息数+已完成调用列表派生确定性 ID）（`server.go:1870-1873`） | 全部用全局随机 `call_uuid`（`tools.ts:65-67`） | tool_call id 稳定性差异（客户端幂等依赖时可能有影响） |
| C9 | **Anthropic tool_use 转换** | tool_use block → assistant 消息 `ToolCalls` 结构化数组（`protocol_compat.go:231-232`） | tool_use block → 文本 `[tool_call name] {...}` 塞入 text 块（`anthropic.ts:124-131`） | 工具历史的结构化信息丢失；后续 flatten 无法识别 tool_calls |
| C10 | **Anthropic stop_sequences** | 映射 `o.Stop`（`protocol_compat.go:178-180`） | 未实现（`anthropic.ts` 无 stop_sequences 字段） | 客户端 stop 序列不生效 |
| C11 | **Anthropic 流式** | replay 模式（内适配非流式，完成后重放 SSE） | 真流式（message_start → 逐块 delta）（`anthropic.ts:392-621`） | TS 为增强行为；时序/语义与上游不同（上游无逐 token） |
| C12 | **Responses 流式** | `streamResponsesAdapter` 内部 openaiChat 流式增量转换（`protocol_handlers.go:110-199`） | 缓冲后 `buildResponsesResponse(stream)` 重放（`responses.ts:233`） | 首 token 延迟更高；工具进度事件缺失 |
| C13 | **Responses 隔离** | 内存历史 `responseNamespace(tenant\x00session)` 双隔离（`protocol_handlers.go:25`） | KV `resp-history/{tenant}/{id}` + 1h TTL（`responses.ts:196-220`） | 机制不同（KV vs 内存）；隔离粒度少 session 维度 |
| C14 | **流式元数据输出** | finishChunk/usageChunk 带 `x_m365_throttling`、`x_m365_scores`；结尾 `: m365-metrics {timestamps}` 注释；HTTP 头 `X-M365-Throttling/Scores/Metrics`（`server.go:2176-2186,2454-2464,2727-2736`） | m365 元数据仅 conversationId/sessionId/requestId/usage_source（`openai.ts:929-940`） | 限流/评分/时序元数据缺失 |
| C15 | **路由豁免差异** | adminMiddleware 豁免 `/v1/images/files/` 前缀（`server.go:395-398`） | `authorize()` 对全部 `/v1/` 前缀要求 API key（`index.ts:141-146`） | 生成的图片文件访问在 TS 需要 API key（上游无需） |
| C16 | **admin 密码未配置检查** | 非 /v1 控制台路径先查 `adminPassword==""` → 503（`server.go:411-414`） | 无等价检查 | 首启未设密码时行为差异 |
| C17 | **CopilotTempSession** | `body.Metadata.CopilotTempSession` 清空会话实现一次性请求（`server.go:1724-1728`） | 无 metadata 解析 | 一次性会话特性缺失 |
| C18 | **引用标记剥离** | 控制台流对 `res.Text` 做 `StripCitationMarkers` + 输出 References（`stream.go:89, client.go:1573-1599`） | 无 | 引用 marker（\uE200…）可能直接出现在控制台输出 |

---

## 2. 已对齐（无差异或行为等价）的关键点

- **API Key 提取**：`X-API-Key` → `Authorization: Bearer`（`auth.ts:7-13` ↔ `server.go:603-617`）✅
- **tone 解析**：`reasoningTone(model, effort)`（`catalog.ts` ↔ `server.go:1137,1638`）✅
- **prompt 扁平化**：system/developer 归并 + tool_calls/tool result 标注 + 附件提取 + 4000 字符工具结果截断（`prompt.ts:95-140` ↔ `prompt.go:23-81`）✅
- **functions→tools / function_call→tool_choice 归一化**（`openai.ts:125-139` ↔ `server.go:1554-1564`）✅
- **tool_choice 校验**：none/required/named 的允许矩阵（`tools.ts:50-62` ↔ `toolloop.go:87-104`）✅
- **fencedToolCalls**：bash 块自动转换 + 未声明 shell 映射 + 裸 `{"command":...}` 行扫描（`tools.ts:208-276` ↔ `fenced_tools.go:24-96`）✅
- **nativeToolCalls / extractToolEvents**：递归全帧扫描 + name+args 去重（`tools.ts:290-340` ↔ `stream_events.go:65-93`）✅
- **schema 校验**：enum/type/required/additionalProperties/嵌套（`tools.ts:70-151` ↔ `tooldecision.go:19-107`）✅
- **buildToolResponse 流式分片**：512 字符 UTF-8 安全切块 + finish_reason=tool_calls（`tools.ts:619-708` ↔ `tool_response.go:10-79`）✅
- **tool refusal / sandbox hallucination 纠正重试**：两侧一致（`openai.ts:786-807` ↔ `server.go:2561-2576`）✅
- **流式 router 预调用**（`streamChatCompletions` ↔ `server.go:1810-1881`）：流式 + tools 先跑 `modelToolRouterPrompt` 预调用，命中即输出 tool_calls，NO_TOOL_NEEDED 才 fall-through 到文本流式；2026-08-27 已补齐（D1）✅
- **流式 holdback 尾缓冲 3-rune**（`holdback.ts` ↔ `server.go:1962`）：上游从 8-rune 降为 3-rune，TS 已对齐（D2）✅
- **completionEvidence 门禁**（`ledger.ts` ↔ `server.go:2637-2639`）✅
- **contentPolicy 503**（`openai.ts:773-783` ↔ `server.go:2627-2631`）✅
- **tone=magic 空完成兜底**（`openai.ts:759-764` ↔ `server.go:2467-2475`）✅
- **maxToolRounds 409**（`openai.ts:704-709` ↔ `server.go:1655-1660`）✅（TS 仅 router 分支，语义近似）

---

## 3. 影响评估与修复优先级

### 必须处理（P0，直接影响正确性/可用性）
1. **A1 failover 守卫**：流式路径增加"已流内容为 0"守卫；错误类型收敛到限流/鉴权再切换。改 `failoverChat` 调用点（`openai.ts:1021`）与 `canFailover` 定义。
2. **A7 图片额度/内容策略错误**：在 `protocol.ts:rateLimitedText` 旁补 `imageLimitText` / `contentPolicyText` 检测，client 层抛出；web 层 `markFailure` 增加 imageLimited 标记（对齐 `accountPool.MarkImageLimited`）。
3. **A4 原生工具事件**：`ChatHandlers` 增加 `onTool` 回调，`client.ts` update 帧解析时调 `extractToolEvents`（`tools.ts:290` 已有实现，只是未接入 client 层）。

### 应当处理（P1，协议一致性与特性保真）
4. **B2 tone 大小写**：~~确认 M365 是否接受小写 `magic`；如上游实测有效则保持，否则改为 `Magic`。建议在桌面端实测。~~ **已解决（2026-08-28）**：官方确认 tone 为 `Magic`，`protocol.ts`/默认映射表/白名单/图片/探测/兜底/modelTone 全库统一大写。
5. **B1 variants / B5 optionsSets / B8 allowedMessageTypes**：对齐上游 62 项 variants 与关键 optionsSets（至少补 references/code_interpreter 相关项），feature flags 按设置透传。
6. **A6 图片回传**：非流式响应把 `res.images` 转 image_url 块（`downloadImageAsDataURIWithToken` 的 Workers 版）。
7. **A5 repair**：流式无效工具时补 router repair 调用。
8. **A3 validateToolConversation**：`prepareCore` 里校验 tool 消息的 tool_call_id。

### 建议处理（P2，增强/元数据/可观测性）
9. **A2 上下文预算**：补滑动窗口（可先用 token 估算简化版 + `X-M365-Context-Truncated` 头）。
10. **B9/B14/C14 元数据**：Metrics 时间戳、throttling/scores/timestamps 输出。
11. **C4 lastHealthyAccount 偏好**：KV 记上次健康账号，优先复用。
12. **A8 custom exec**：responses.ts 补 `custom_tool_call` 转换 + workspace 指令。
13. **C15 路由豁免**：`/v1/images/files/` 免 API key（对齐上游）。

---

## 4. 结论

`backend-correspondence.md` 的模块映射在**文件级**成立（ChatHub 协议层、工具调用等均有对应文件），但**代码逻辑级**存在 18 项 B/C 级载荷差异和 8 项 A 级功能差异。核心问题集中在四类：

1. **failover 语义**（A1）：TS 无条件换号 + 流式无已流守卫，是可用性风险最高的差异；
2. **ChatHub 载荷保真度**（B1-B13）：variants/tone/optionsSets/allowedMessageTypes 等协议敏感字段与已验证的上游不一致，部分（tone 大小写）可能直接导致请求失败，需实测；
3. **上游特性未移植**（A2/A3/A5/A6/A8）：上下文预算、工具校验、repair、图片回传、custom exec 属"技术上可行但未做"；
4. **错误分类与账号健康**（A7/C3/C5/C6）：imageLimited/contentPolicy 检测与连接池错误分类缺失，影响多账号场景下的健康管理精度。

建议按 P0 → P2 顺序推进，其中 **A1、A7、B2 三项先做**（A1 改 failover 语义、A7 补 client 层检测器、B2 桌面端实测 tone 大小写后定论），完成后更新 `docs/PARITY.md` 与 `docs/PORTING-BACKLOG.md` 的相关条目。
