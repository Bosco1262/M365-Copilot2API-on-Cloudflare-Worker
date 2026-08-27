# 剩余移植项实施规格(续作手册)

> 来源:2026-08-26 对上游 Go 源码的完整研读。每批独立可交付,完成后更新 PARITY.md。

## 批次 A:#4 原生 tool 事件抽取 + #2 agent ledger ✅ 已完成（2026-08-26）

> 落地:`src/pipeline/tools.ts` 新增 `extractToolEvents`(全层级递归+去重)并重构 `nativeToolCalls(events, declaredNames:Set<string>)`;`src/api/openai.ts` 非流式与流式均按 fenced→native→校验/限额接线,流式补发 toolPlugins/MCPServerURL 且 tool 事件只收集不出文本;新文件 `src/pipeline/ledger.ts`(纯函数:重建/backfill/compact 4000/失败正则/签名计数/CanContinue/RouterContext/completionEvidenceAllows+固定免责句)接入 runCompletionsCore 的 router 规划轮(轮次熔断+证据注入)与终稿输出(证据门)。测试 `test/native-tools.test.ts`(8 例)+`test/ledger.test.ts`(13 例),全套 125 例绿,tsc/wrangler dry-run 通过。PARITY.md 对应行已更新。

**#4 规格**(上游 chathub/events.go、native_tools.go):
- `extractToolEvents(updateArgsRaw)`:递归遍历 update 帧 arguments 的所有层级(不只 messages[]);对象同时含名称字段(`name|toolName|pluginName|functionName`)与参数字段(`arguments|args|parameters|input|functionArguments`)即记 `{toolName, arguments}`;按 name+JSON(args) 去重。
- `nativeToolCalls(events, declaredNames:Set<string>)`:仅接受声明过的工具名 → `detectedToolCall{ID:"call_"+uuid, Name, Arguments}`;绝不从散文推断。
- 接线:`src/api/openai.ts` 检测顺序 = fenced(已有)→ native(新增)→ 校验/限额(已有)。流式中 tool 事件只收集不出文本。
- 测试:test/native-tools.test.ts 构造含 `pluginName/functionArguments` 的帧。

**#2 规格**(上游 internal/web/agent_ledger.go 262 行):
- 每次请求从 messages 重建(无服务端状态):assistant.tool_calls 建 `{id:{name,args}}`;role=tool 按 tool_call_id 回填 Result(compact 4000 字符=头 limit/3+尾 limit-head-80);失败正则 `(?i)(exit\s*(code|status)?\s*[:=]?\s*[1-9]\d*|\berror\b|\bfailure\b|exception|traceback|timed?\s*out|permission denied|not found|refused)`。
- 签名计数:name+"\x00"+args 规范化(trimmed+合法 JSON 重序列化);≥2 RepeatedCall / ≥3 StuckLoop;失败签名(name\0args\0normalize(result):小写、数字→#、截500)≥2 RepeatedFailure ≥3 StuckLoop。
- `CanContinue(maxRounds)`:依次报 轮数达限/StuckLoop/RepeatedFailure/pending 未回填。
- RouterContext 注入:"A completed call is final evidence..." + EVIDENCE_LEDGER JSON(completed/pending/repeated)+ FINAL ANSWER RULE 行。
- `completionEvidenceAllows(answer,ledger)`:pending→false;无工具记录且答案含 installed/completed/succeeded 类动词→false;有 Completed 且答案含 cannot confirm/not verified 类→false;false 且请求带工具→正文替换为固定免责句。
- 新文件 `src/pipeline/ledger.ts`(纯函数),接线 openai.ts routeRes 循环与终稿输出。

## 批次 B:CoordinationDO(#9/#10/#12 + #11 执行器) ✅ 已完成(2026-08-26)

> 落地:`src/do/coordination.ts` 单例 DO("gateway-coord",SQLite 类,migrations v2)action 路由 `/lockout`(5 次/15min,check 不记账)/`/next-account`(DO 内原子游标,KV accounts 文档不再每次写 nextIdx)/`/acquire`+`/release`(每账号信号量,上限=settings.accountConcurrencyLimit,满时有界等待后 429+Retry-After;15min 租约 TTL+alarm 兜底回收)/`/mutex`+`/mutex/release`(带 token 的 TTL 互斥)。接线:admin/handleLogin 登录失败锁定、store/accounts.nextAccount 游标与 ensureValid 跨 isolate 刷新单飞(未抢到方轮询 KV ≤15s 等远端结果)、openai resolveAndValidateAccount 槽位获取+两条流式路径与非流式 core finally 释放。env 加 `COORD?`;未绑定全走现行为。测试 test/coordination.test.ts 14 例(DO 单元+client 假 NS+store 集成),全套 139 例绿,tsc/wrangler dry-run 通过(COORD 绑定已出现在 binding 列表)。

`src/do/coordination.ts` 单例 DO("gateway-coord"),action 路由:
- `POST /lockout {ip}` → {locked,remaining};15min 窗 5 次(全局共享,替代 isolate Map)
- `POST /next-account {ids:string[]}` → 返回选中 id(内部原子游标;KV accounts 文档不再每次写 nextIdx)
- `POST /acquire {accountId}` / `/release {accountId}` → 并发信号量上限=settings.accountConcurrencyLimit;acquire 满时阻塞等待(用 alarm 轮询或直接 429 语义)
- `POST /mutex {key:"refresh:"+accId, ttlMs}` → 单飞互斥
接线点:index.ts 登录失败处、openai resolveAndValidateAccount、auth 刷新入口。env 加 `COORD?: DurableObjectNamespaceLite`;未绑定全走现行为。wrangler migrations v2 new_sqlite_classes:["CoordinationDO"]。

## 批次 C:#7 对话详情查看器 ✅ 已完成(2026-08-26)

> 落地:migration 0002 建 D1 表 `chat_messages(conversation_id,seq,role,content,created_at,PK(conversation_id,seq))`;新 `src/store/chatMessages.ts`(appendChatTurn 每轮 user+assistant 两行、MAX(seq)+1 冲突重试一次、单条 64KiB 截断;listMessages 按 seq 升序;deleteByConversation;cleanupOld 7 天 TTL)。写入点=recordFinalize 成功路径(sentPrompt===answerPrompt 才记,router 规划轮跳过),覆盖 /v1/chat/completions 流/非流、/v1/messages 流、/v1/responses。detail handler 按 ContextHistory 形状返回(chatName/messageCount/accountEmail/messages[]),conversation.html 零改动渲染。删除联动:两个 delete 端点+cleanup.dropConversation 均清转录,cron scheduled 加 cleanupOld。D1 未绑定→空时间线+detail_unavailable。测试 test/chat-messages.test.ts 7 例(mock D1),全套 146 例绿,tsc/wrangler dry-run 通过。

方案:D1 表 `chat_messages(conversation_id TEXT, seq INTEGER, role TEXT, content TEXT, created_at TEXT, PRIMARY KEY(conversation_id,seq))`;afterChat 成功路径把本轮 user prompt 与 assistant text 各 INSERT 一行(TTL 由清理 DELETE);detail handler 按 seq 组装 ContextHistory 形状返回。conversation.html 已能渲染消息数组。注意截断单条 64KiB。

## 批次 D:#3 convCache + #16 FeatureFlags ✅ 已完成(2026-08-26)

> 落地:`src/store/convCache.ts`(KV 键 `convcache:<apiKeyHash|anon>|<accId|auto>|<model>`,比上游多一层 key 隔离;TTL 2h);prepareCore 无显式 conv 且 sysHash 一致且新条数>缓存→复用并增量 flatten(messages[count:])、命中钉定缓存账号,recordFinalize 应答轮回写;无系统提示词不参与。FeatureFlags:settings.featureFlags 由 M365_ENABLE_MEMORY_V2 等 8 个 env 播种,memoryV2 实际生效(protocol.ts 门控 update_memory_plugin/add_custom_instructions),其余存储待核对。测试 test/conv-cache.test.ts 7 例。

## 批次 E:#19 MCP 出站客户端(SSE) / #20 异步桥 / #21 流式调试补录 ✅ 已完成(2026-08-26)

> 落地:`src/mcp/outbound.ts` 移植 client.go——GET url(sse) 读 endpoint 帧拿 message URL;POST JSON-RPC 按 id 关联 SSE 回读(initialize/tools/list 10s、tools/call 30s 超时);syncOutboundTools(settings.mcpServers,5min 缓存/URL)把外部工具并入全局注册表,#20 队列语义=callBridgedTool 等 ≤30s,超时回 isError+placeholder 占位文案;server.ts tools/call 先查桥接再回落 -32603;prepareCore 在广告插件前同步外部工具。#21:index.ts 流式分支 tee 出探针分支聚合 ≤256KiB,stream 完成回调里 captureDebugRecord 补 responseBody(logLevel=debug 才落库,探针始终排空防背压)。测试 test/outbound-mcp.test.ts 6 例(mock SSE server+超时占位+聚合截断)。

## 批次 F:控制台 UI(白名单 + memory) ✅ 已完成(2026-08-26)

> 落地:index.html 对话页加白名单管理卡片(GET 渲染+输入添加+逐行移除,调既有 /api/conversations/whitelist);设置页加 M365 Memory 卡片(flags/instructions JSON 编辑保存+按 ID 删除);新端点 /api/admin/memory/flags(GET/PATCH)、/api/admin/memory/instructions(GET/PUT)、/api/admin/memory/instructions/delete(POST{id})为 substrate 代理的管理员会话变体(复用 m365Proxy);i18n en+zh 全套键(wl.* 6 + mem.* 9),沿用 card/table/status 样式与 trBackend 错误链路;check:i18n 通过(288 键)。

## 完成定义
每批:tsc --noEmit ✅ + vitest 全绿 + 新增针对性测试 + PARITY.md 对应行改状态 + 本文件勾销该批次。
