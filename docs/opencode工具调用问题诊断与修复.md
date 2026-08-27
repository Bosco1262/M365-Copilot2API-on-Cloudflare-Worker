# opencode 接入后工具调用失败诊断报告（/mnt/data 沙盒幻觉）

> 诊断时间：2026-08-27
> **修复状态：✅ 已实施（2026-08-27），见文末「六、已执行的修复」**
> 项目：M365-Copilot2API-on-Cloudflare-Worker（已部署：https://m365-copilot2api.kongfanhao14.workers.dev）
> 症状：在 `C:\Github Desktop\Cloudflare-AI-Aggregator` 目录用 opencode（provider = m365，模型 gpt-5.6-reasoning）问"请阅读当前仓库"，模型回复"执行环境中没有挂载目标仓库。目录是 /mnt/data，目录为空且不是 Git 仓库……"，工具调用失败；而 `M365-Copilot2API-main` 目录和其他模型（DeepSeek/Kimi/GLM 等）正常。

---

## 一、结论（TL;DR）

**根因不是仓库/目录，也不是 opencode 配置，而是三层叠加：**

1. **模型固有行为**：通过本网关调用的 GPT-5.x（M365 Copilot / ChatHub 协议）是自带沙箱的 agentic 模型，它的"执行环境"就是自己云端沙箱 `/mnt/data`（OpenAI 系 code interpreter 沙箱的标准挂载路径）。被要求"读当前仓库"时它选择用自己的沙箱工具，而不是客户端声明的工具。
2. **网关在默认 router 模式下没有把客户端工具交给模型**：`chathubRequest` 只在 `toolPlanningMode === "native"` 或启用 MCP 网关时才把工具传给 ChatHub 客户端（`src/api/openai.ts:690-693`）。默认 `toolPlanningMode = "router"`（`src/store/settings.ts:163`），导致 `chatPayload` 里的 `toolProtocolPrompt` 因 `tools.length === 0` 走兜底分支（`src/chathub/protocol.ts:231-233`），**模型完全收不到 `<tools>` 工具定义和"不要用 /mnt/data、不要提 Linux 容器"的反沙盒指令**。
3. **沙盒幻觉纠正只存在于非流式路径**：`isSandboxHallucination()` 检测（`src/pipeline/tools.ts:605`，模式表里就包含 `/mnt/data`）和纠正重试（`src/api/openai.ts:1023-1033`）**只写在 `runCompletionsCore`（非流式）里，`streamChatCompletions`（流式）完全没有**。opencode 默认以 `stream: true` 请求，所以纠正逻辑永远不会触发，`/mnt/data` 散文被原样透传。

> 一句话：**模型想用自己云端沙箱读文件 → 网关没拦住也没纠正（因为流式路径没有纠正逻辑）→ 幻觉散文直接显示给用户。**

---

## 二、证据链（代码位置）

| # | 事实 | 位置 |
|---|------|------|
| 1 | 默认工具规划模式是 `router` | `src/store/settings.ts:163` → `toolPlanningMode: "router"` |
| 2 | router 模式下工具不传给 ChatHub 客户端 | `src/api/openai.ts:690-693`：`nativeTools = toolMaps.length > 0 && (planningMode === "native" \|\| mcpServerUrl) ? ... : undefined` |
| 3 | 工具定义注入依赖 `tools` 非空 | `src/chathub/protocol.ts:230-233`：`tools.length === 0` 时 `toolProtocolPrompt` 走兜底"Please answer the following request in full" |
| 4 | 反沙盒指令写死在工具协议提示词里（含 `/mnt/data`、Linux container） | `src/chathub/protocol.ts:247` |
| 5 | 沙盒幻觉检测模式表包含 `/mnt/data` | `src/pipeline/tools.ts:572-603`（`SANDBOX_HALLUCINATION_PATTERNS` 含 `"/mnt/data"`、`"linux container"`、`"execution environment has changed"`、`"cannot access the windows path"` 等） |
| 6 | 沙盒幻觉纠正重试**只在非流式路径** | `src/api/openai.ts:1023-1033`（在 `runCompletionsCore` 内）；流式 `streamChatCompletions`（`src/api/openai.ts:1232-1441`）无任何 `isSandboxHallucination`/`isToolRefusal` 调用 |
| 7 | Anthropic/Responses 适配器同样没有纠正 | `src/api/anthropic.ts`、`src/api/responses.ts` 中无 `isSandboxHallucination` 引用 |
| 8 | 流式 holdback 只拦截代码围栏，不拦截幻觉散文 | `src/api/holdback.ts:19-60`：仅当文本含 ` ```bash ` 或 `"command"` 时整体扣留；其余文本只保留尾部 8 个字符后即发出 → `/mnt/data` 散文会被逐字流出，事后纠正无法撤回 |
| 9 | opencode 默认流式 | opencode 基于 Vercel AI SDK `streamText`，`/v1/chat/completions` 请求 `stream: true`（客户端行为，非本仓库代码） |

---

## 三、为什么 `M365-Copilot2API-main` 目录正常 / 目录不是原因

- 目录本身对 opencode 和 Worker 没有任何影响：`.git` 有无、`.workbuddy/` 是否 untracked、`[submodule]`/`[lfs]` 配置段都与 `/mnt/data` 无关（已核实 `Cloudflare-AI-Aggregator` 的 `.git` 健康、`git rev-parse` 正常）。
- 真正差异在**模型路由 / 会话状态**：
  1. 两个目录可能用了不同模型/变体（`gpt-5.6-reasoning` vs `gpt-5.6-sol`；或其他 provider）。
  2. **会话复用放大**：网关按 IP 指纹 + 上下文前缀复用 ChatHub 会话（`src/pipeline/resolver.ts:225-328`）。opencode 每次启动的系统提示 + "请阅读当前仓库" 前缀一致时会被命中复用；一旦某次会话让模型进入了"我的环境是 /mnt/data"的错误认知，同一目录后续请求会继续沿用该会话，失败表现会"粘住"。
  3. "其他正常模型"（DeepSeek/Kimi/GLM/grok 直连）没有自带沙箱、严格遵循 OpenAI function-calling 协议，所以 opencode 本地执行工具 → 正常。

**验证方法（2 条 curl 即可证实根因）**：

```bash
# A. 非流式（应触发沙盒幻觉纠正 → 返回 tool_calls 或干净回答）
curl https://m365-copilot2api.kongfanhao14.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer m365_你的密钥" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-reasoning",
    "stream": false,
    "messages": [{"role":"user","content":"请阅读当前仓库"}],
    "tools": [{"type":"function","function":{"name":"bash","description":"在本地 Windows 执行命令","parameters":{"type":"object","properties":{"command":{"type":"string"},"workdir":{"type":"string"}},"required":["command"]}}}]
  }'

# B. 流式（opencode 实际走的路径，应复现 /mnt/data 散文）
curl -N https://m365-copilot2api.kongfanhao14.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer m365_你的密钥" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-reasoning",
    "stream": true,
    "messages": [{"role":"user","content":"请阅读当前仓库"}],
    "tools": [{"type":"function","function":{"name":"bash","description":"在本地 Windows 执行命令","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}]
  }'
```

若 A 正常、B 复现幻觉 → 根因 100% 证实（流式路径缺纠正）。

---

## 四、解决方案

### 方案一：立即可用，不改代码（推荐先用）

| 做法 | 操作 | 说明 |
|------|------|------|
| 1. 换用已验证的模型 | opencode 里 `Ctrl+K` 切到 mota/nvidia1/qq 的模型（DeepSeek-V4 / Kimi / GLM / grok） | 这些模型无自带沙箱，工具调用已确认正常 |
| 2. 避开 Sol 类 agentic 变体 | 用 `gpt-5.6-reasoning`（若曾用 `gpt-5.6-sol`） | Sol 变体自带执行环境，最易触发沙箱行为 |
| 3. 清掉"坏会话" | Worker 控制台 → 对话/会话列表 → 删除；或新开 opencode 会话 | 避免 resolver 复用陷入幻觉的旧会话（症状粘住的放大器） |
| 4. 强制一次性会话 | 在 opencode 请求头带 `metadata.copilot_temp_session=true` 语义（代码已支持 C17） | 绕过所有会话复用；opencode 不易直接传，可用 curl 验证 |
| 5. （如已用 Claude Code）走 `/v1/messages` | `ANTHROPIC_BASE_URL` 指向 Worker | Anthropic 协议 tool_use 块转换较鲁棒，但同样无沙盒纠正，效果需实测 |

### 方案二：改代码，治本（两处补丁）

**补丁 1（主修复）：给流式路径补上沙盒幻觉/工具拒答纠正**

位置：`src/api/openai.ts` `streamChatCompletions` 的 `Post-stream tool detection` 之前（约 1329 行处），在检测工具调用前对累计文本做纠正重试，逻辑与 1023-1033 行完全一致：

```ts
// --- 流式沙盒幻觉/工具拒答纠正（与 runCompletionsCore 对齐）---
if (hasTools && toolCalls.length === 0) {
  const accText = holdback.totalText() || res.text;
  if (isSandboxHallucination(accText) || isToolRefusal(accText)) {
    const correction = isSandboxHallucination(accText)
      ? "CRITICAL: You must NOT use any built-in code interpreter, Python sandbox, or cloud execution environment. The caller has provided a bash tool that runs Windows PowerShell 5.1 on their local machine — use it to execute any commands or code. Do NOT say you cannot run code. Do NOT say you only have a Linux container. Do NOT mention /mnt/data. Call the bash tool NOW.\n\nUser request:\n" + prepared.prompt
      : "Your previous response incorrectly denied that caller tools are available. They are real, active, and callable on the caller's Windows machine. Call the appropriate tool now.\n\nUser request:\n" + prepared.prompt;
    try {
      const res2 = await chatCall(ctx, prepared, acc, { textOverride: correction });
      if (!isSandboxHallucination(res2.text) && !isToolRefusal(res2.text)) {
        res = res2;
        const rawCalls = fencedToolCalls(res2.text, prepared.toolMaps, prepared.toolChoice);
        const validated = validateDetectedToolCalls(rawCalls, prepared.toolMaps, prepared.toolChoice);
        if (validated.valid.length > 0) toolCalls = validated.valid;
      }
    } catch { /* 保留原文 */ }
  }
}
```

> 注意：事后纠正无法撤回已发出的字符。若要在流式过程中就拦截，需要把幻觉模式检测前移到 `onDelta`：命中即停止输出并触发纠正（见补丁 1b，可选）。

**补丁 1b（更稳，可选）：流式过程中文本级抑制**

在 `onDelta` 回调里对累积文本做前缀匹配（如出现 `"执行环境中"`、`"/mnt/data"`、`"沙箱"` 等模式且已发出内容很短时），立即中断当前轮并走纠正重试，避免幻觉散文先展示给用户。

**补丁 2：router 模式下也让模型拿到工具定义与反沙箱指令**

位置：`src/api/openai.ts:690-693`（`chathubRequest`）。最小改动：当声明了工具时总是传给 ChatHub 客户端，让 `toolProtocolPrompt` 注入 `<tools>` 块：

```ts
const nativeTools =
  prepared.toolMaps.length > 0 && (planningMode === "native" || prepared.mcpServerUrl || true)
    ? toolMapsToTools(prepared.toolMaps)
    : undefined;
```

（即把条件恒真；或更保守：`planningMode !== "router" || true` 前先小流量验证。）配合 protocol.ts:247 已有的反沙盒指令，模型从一开始就被告知"bash 工具跑在调用者 Windows 机器上、不要提 /mnt/data"，从源头降低幻觉概率。

> 风险提示：native 传工具后，ChatHub 可能返回微软原生工具事件（如 web_search），网关的 `nativeToolCalls` 会按客户端声明名过滤掉它们（`src/pipeline/tools.ts:331-340`），不会误报；router 模式下的围栏检测（`fencedToolCalls`）仍是主通道。

### 方案三：验证与回归

```bash
cd "C:/Github Desktop/M365-Copilot2API-on-Cloudflare-Worker"
npm run typecheck && npm test      # 类型与单测
npm run dev                        # 本地 127.0.0.1:8787
# 本地复现：用上面的 curl 把域名换成 http://127.0.0.1:8787 分别测 stream:true/false
npx wrangler deploy                # 确认后再上线
```

---

## 五、风险与注意

- `/mnt/data` 是模型自述的**云端沙箱**路径，不是 opencode 或本机路径；任何"让执行环境挂载该目录"的想法都无效，方向应是把模型导向客户端工具。
- 本网关本质是把"模型文本里的工具调用意图"翻译成 OpenAI `tool_calls`（router 模式靠 `CALL_TOOL:` / 围栏块 / `<m365-tool-call>` 三种格式 + 原生事件检测），翻译链路对 GPT-5.x 这类自带 agent 能力的模型天然脆弱。
- 会话复用（resolver）会放大单次失败的粘性；排查时优先开新会话。
- 未提交的工作区改动很多（openai.ts +435/-111），部署前建议先 `git commit`，便于回滚定位。

---

## 六、已执行的修复（2026-08-27）

> **补充（同日二轮）**：对照上游 Go 源码后确认**真正的移植缺口**——上游 `server.go` 的流式路径（1810-1881 行）在 `stream:true + tools` 时**先跑 router 预调用**（`modelToolRouterPrompt` 把完整工具定义嵌入 prompt → 模型返回 `CALL_TOOL:` → 直接输出 `tool_calls`），只有预调用判定"不需要工具"才 fall-through 到文本流式。Worker 版 `streamChatCompletions` **漏掉了这个预调用**（只在非流式 `runCompletionsCore` 实现了），导致流式请求的模型在 answer turn 看不到任何工具定义 → GPT-5.x 用自己的 `/mnt/data` 沙箱。**这就是"上游本地版能读文件、Worker 版不能"的真正原因（与部署位置无关）**。补丁 3 补齐该预调用后，与上游行为完全对齐。

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/api/openai.ts` | ① 新增 `injectToolProtocol()`：把 `<tools>` 工具定义 + 反沙盒指令注入 answerPrompt（替代失效的 `toolProtocolPrompt` 协议注入）；② `streamChatCompletions` 增加流式 router 预调用（对齐上游 Go `server.go` 流式路径）；③ 增加流式沙盒幻觉/工具拒答纠正（对齐 `runCompletionsCore`）；④ 增加流式文本级抑制（`suppressed`/`suppressedText`）与纠正失败回退 |
| `test/stream-correction.test.ts` | 新增 2 个回归测试：纠正成功→`tool_calls`；纠正失败→回退原始文本（mock 已适配预调用序列） |
| `test/stream-router.test.ts` | 新增 2 个回归测试：预调用命中→直接输出 `tool_calls`（answer turn 不执行）；预调用 `NO_TOOL_NEEDED`→fall-through 到流式文本 |

### 关键实现说明

1. **流式 router 预调用（补丁 3，治本）**：`streamChatCompletions` 在 answer turn 之前，若 `toolPlanningMode==="router"` 且声明了工具且 `tool_choice !== "none"`，先 `chatCall` 跑 `modelToolRouterPrompt` 预调用（prompt 内嵌完整工具定义 JSON）→ `parseModelToolDecision` 解析 `CALL_TOOL:` → 验证通过即 `buildToolResponse` 直接输出流式 `tool_calls` 并 return。失败可 failover；预调用未选中工具则 fall-through 到原有 answer turn 逻辑（此时原有注入/纠正/抑制继续兜底）。
2. **注入点**：`prepareCore` 末尾、会话解析（convCache/resolver 增量）之后，避免增量覆盖；流式/非流式/Anthropic 三条路径共用 `prepareCore`，全部受益。
3. **协议注入为何失效**：`buildChatPlugins` 恒产出插件（空工具时 BingWebSearch，有工具时每工具一个 API 插件）→ `toolProtocolPrompt` 的 `hasPlugins` 恒 true → `<tools>` 注入分支永不执行（Go 版 `clientPlugins`/`tool_protocol.go` 同样如此）。因此改为直接在 prompt 文本注入。
4. **流式纠正（兜底）**：流结束后若累积文本命中 `isSandboxHallucination`/`isToolRefusal`，用与 `runCompletionsCore` 相同的纠正文案 `chatCall` 重试；纠正成功且命中 fenced 工具块 → 输出 `tool_calls`。注意 `detectSource` 必须用纠正后的 `res.text`（而非 holdback 原始文本），否则纠正结果被忽略。
5. **文本级抑制（兜底）**：`onDelta` 预检（`holdback.buffered() + part`，<400 字符），命中即整块扣留（独立 `suppressedText` 累积，holdback 只留尾 8 rune 会丢前缀）；纠正失败时释放被抑制文本，用户不会看到空流。

### 验证结果

```
npm run typecheck   → 通过（tsc --noEmit，exit 0）
vitest run          → 22 个文件 / 183 个测试全部通过
  ├─ 新增 test/stream-router.test.ts (2) ✅
  ├─ 新增 test/stream-correction.test.ts (2) ✅
  └─ 原有 179 个测试无回归 ✅
```

### 部署步骤

```bash
cd "C:/Github Desktop/M365-Copilot2API-on-Cloudflare-Worker"
git add -A && git commit -m "fix: streamed sandbox-hallucination correction + tool protocol injection"
npx wrangler deploy
# 部署后用诊断报告「三」的 2 条 curl 复测：stream:true 应不再返回 /mnt/data 散文
```
