# M365-Copilot2API on Cloudflare Worker

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/API-OpenAI%20Compatible-412991?logo=openai" alt="OpenAI Compatible">
</p>

将 [M365-Copilot2API](https://github.com/HEXUXIU/M365-Copilot2API)（Go 自托管网关）移植到 **Cloudflare Workers** 的版本：把微软 365 Copilot 商业订阅背后的 **ChatHub 私有协议**（SignalR over WebSocket）翻译成标准的 **OpenAI 兼容 API**，无需自己的服务器。

> ⚠️ **免责声明**：本项目不是微软官方产品；使用第三方方式接入 M365 服务可能违反服务商条款，后果自负。仅供个人学习研究，禁止商业转售或规模化运营。账号被封禁等损失概不负责。

## 当前状态（阶段 3）

| 能力 | 状态 |
|------|------|
| `/v1/chat/completions`（流式 + 非流式，`reasoning_content` 推理增量） | ✅ |
| **Function calling**：router 规划模式（CALL_TOOL/JSON 信封）、fenced bash 块自动转换、原生 ChatHub 工具事件检测、JSON Schema 校验信任边界、流式参数分片 `tool_calls`、工具拒答/沙盒幻觉纠偏 | ✅ 阶段 3 |
| `/v1/messages`（Anthropic 协议：system/内容块转换、thinking/tool_use block、**真流式增量**） | ✅ 阶段 2+增强 |
| `/v1/responses`（Codex：instructions/input 项转换、`previous_response_id` 历史、function_call 输出投影、SSE 事件序列） | ✅ 阶段 3 |
| 多模态图片输入（data URL / https URL → UploadFile 上传 + ImageFile 注解注入） | ✅ 阶段 3 |
| `/v1/images/generations` + `/v1/images/edits`（multipart 表单）+ 生图文件服务（KV，15 分钟 TTL）；Designer 域名图片自动换取 Designer token 下载转存 | ✅ 阶段 3 |
| `/v1/models`（Codex 风格模型目录，`data` 与 `models` 双别名） | ✅ |
| 内容键会话复用（严格前缀命中→只发增量；同后缀兜底；IP 指纹隔离） | ✅ 阶段 2 |
| 云端对话自动清理（Cron 每 30 分钟：闲置 2h 或超出 keep_n=5 回收，白名单保护） | ✅ 阶段 2 |
| 缓存命中统计仪表盘（命中率 / 节省 token / 按 Key 统计） | ✅ 阶段 2 |
| Web 管理控制台（上游 `web/*.html` 原样托管） | ✅ |
| PKCE 账号授权 + 自动 token 刷新（请求内防抖 + Cron 兜底） | ✅ |
| 多账号轮询 + 故障转移 + 限流冷却 | ✅ |
| API Key 管理 / 云端对话列表删除 / 用量统计 | ✅ |
| MCP 网关（SSE / stdio）、agent ledger 证据链 | ⏳ 后续 |

**阶段 3 简化说明**：
- Responses 流式采用"完成后事件重放"（与上游一致）；**Anthropic `/v1/messages` 流式为本移植的真流式增强**（上游本身是完成后重放），ChatHub 增量直接映射为 `thinking_delta`/`text_delta`，工具调用经围栏扣留后以 `tool_use` 块输出
- Codex usage 为启发式字符估算（上游用 tiktoken o200k；Worker 内不内置词表），`m365.usage_source` 标注
- agent ledger（跨轮工具证据链）未移植，router 提示词中的重复调用抑制规则已保留

**平台裁剪说明**（Workers 运行时限制）：出站代理池（HTTP/SOCKS）、跨请求 WebSocket 连接池、MCP stdio 无法实现。代理池相关端点与账号绑定代理字段已按需求**彻底移除**。

**自动清理说明**：与上游代码一致（README 上游文档写 keep 100，实际代码默认 `keepN=5`），受保护对话（活跃会话绑定、最近使用）永不回收。Cron 单次运行最多删除 30 个对话（Free 计划子请求预算保护）。可用 vars 覆盖：`M365_AUTO_CLEANUP=0` 关闭、`M365_AUTO_CLEANUP_MAX_AGE_HOURS`、`M365_AUTO_CLEANUP_KEEP_N`。

## 部署

> **前置要求**：Cloudflare 账号；Node.js 18+（仅 CLI 方式需要）。**强烈建议 Workers Paid（$5/月）**：Free 计划每请求仅 10ms CPU 时间，长对话的流式帧解析可能触发 1102 错误（等待网络不占 CPU，但 JSON 解析占）。Paid 默认 30s 并可在 `wrangler.jsonc` 中调至 5 分钟：
>
> ```jsonc
> "limits": { "cpu_ms": 300000 }
> ```
>
> **控制台语言**：默认 English，可在设置页切换 简体中文（仅这两种，选择保存在浏览器 localStorage）。

### 方式 A：Fork 后在 Cloudflare 面板一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HEXUXIU/M365-Copilot2API-on-Cloudflare-Worker)

1. Fork 本仓库到你自己的 GitHub 账号
2. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Import a repository** → 选择你 fork 的仓库 → Deploy
3. Cloudflare 会自动识别 `wrangler.jsonc` 并**自动创建并绑定 m365-copilot2api_KV 命名空间**（配置里无需预填 id），构建部署全自动
4. （可选）部署完成后在该 Worker 的 Settings → Variables 中添加 secret `ADMIN_PASSWORD`
5. 打开分配的 `*.workers.dev` 域名即可使用

> 未设置 secret 时可用默认密码 `admin123` 登录，控制台会强制要求修改（修改后的密码存于 KV）。

### 方式 B：CLI 部署

```bash
npm install

# 1. 创建 KV namespace，把返回的 id 取消注释填入 wrangler.jsonc
npx wrangler kv namespace create m365-copilot2api_KV

# 2. （推荐）设置管理员密码引导值；不设置则默认 admin123，首次登录强制改密
npx wrangler secret put ADMIN_PASSWORD

# 3. 本地验证（本地 KV 模拟，无需真实 id）
npm run dev          # http://127.0.0.1:8787

# 4. 部署
npx wrangler deploy
```

部署后打开 `https://<your-worker>.workers.dev/`：

1. 用管理员密码登录控制台（默认密码 `admin123` 时会强制修改）。
2. 「账号」页 → 开始授权 → 在微软登录页完成登录 → 从跳转后的地址栏复制完整 URL（含 `code=...&state=...`）→ 粘贴回控制台确认。
3. 「API Keys」页创建密钥。
4. 调用测试：

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer m365_你的密钥" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

对接 Claude Code / Cursor：把 `ANTHROPIC_BASE_URL` 指向 Worker 地址即可（`/v1/messages` 已支持，含 thinking/tool_use block）。对接 Codex：把 OpenAI Responses `base_url` 指向 Worker（`/v1/responses` 已支持 function calling 与 `previous_response_id`）。

## 控制台多语言（en / zh-CN）

控制台使用内嵌的语义键 i18n（无运行时依赖）：

- **静态元素**：加 `data-i18n="key"` 属性（另有 `-placeholder/-title` 变体）
- **JS 动态串**：调用 `t('key', { 参数名: 值 })`，译文里用 `{参数名}` 占位
- 字典 `I18N` 位于 index.html 内联脚本顶部（`/*I18N-START*/ … /*@I18N-END*/`），en 与 zh-CN 两表键集必须一致
- 已知后端返回消息通过 `BACKEND_MSG_MAP` 映射；未命中的原样显示
- 修改后运行 `npm run check:i18n` 校验键完整性（双语齐全、无缺失）

新增一种语言：在 `I18N` 加对应 locale 表并补齐全部键 → `SUPPORTED_LOCALES` 加入语言码 → 设置页语言下拉框加 `<option>`。

## 配置

所有 OAuth 参数与上游一致（Office web 第一方客户端），可通过 vars/secrets 覆盖：`M365_BROWSER_CLIENT_ID` / `M365_BROWSER_AUTHORITY` / `M365_BROWSER_REDIRECT_URI` / `M365_BROWSER_SCOPE`。运行时设置（模型映射、超时等）直接在控制台「设置」页修改，存于 KV。

KV 数据布局（单 namespace `m365-copilot2api_KV`）：

| 键 | 内容 |
|----|------|
| `accounts` | 账号池（token、轮询索引） |
| `api-keys` | API Key 记录（仅 SHA-256 哈希） |
| `admin-password-hash` / `admin-sessions` | 管理员凭据与会话 |
| `settings` | 运行时设置 |
| `resolver-sessions` / `sessions` / `conversations` | 会话解析器状态 / 显式绑定 / 本地对话索引 |
| `usage/<yyyyMMdd>` | 用量记录日桶（保留 90 天） |
| `cache-stats` | 缓存命中统计 |
| `account-health` | 账号冷却 / 故障状态 |
| `pkce/<state>` | 待完成的授权流程（10 分钟 TTL） |
| `resp-history/<key>/<id>` | Responses `previous_response_id` 历史（1 小时 TTL） |
| `img/<uuid>` | 生成的图片文件（15 分钟 TTL） |

## 架构对照

```
上游 Go                        本移植 (TypeScript on Workers)
─────────────────────────     ─────────────────────────────────
internal/chathub/client.go →  src/chathub/{protocol,client}.ts   # SignalR 帧/握手/快照去重/限流检测逐字移植
internal/auth/*            →  src/auth/oauth.ts + store/accounts.ts
internal/web/server.go     →  src/api/openai.ts + admin/*.ts + index.ts
JSON 文件持久化             →  Workers KV 文档键
后台 goroutine 循环         →  Cron Trigger (scheduled) + ctx.waitUntil
gorilla/websocket          →  fetch() WebSocket 升级
embed.FS web 控制台        →  Workers Static Assets (assets/)
```

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest 单元测试
npm run check       # typecheck + test + wrangler dry-run
```

测试覆盖：SignalR URL/payload 构造、限流文案检测、推理事件分类、PKCE S256（RFC 7636 向量）、JWT claims 解析、prompt 扁平化、tone 路由、模型目录、错误分类体系。

## 与上游的差异

- 管理员密码在 KV 中以 SHA-256 存储（上游为明文文件），登录/改密流程不变。
- 登录失败锁定为 isolate 内存态（多 isolate 下弱化）；其余安全行为（强制改密、会话 Cookie、API Key 哈希）一致。
- token 刷新防抖仅在单个 isolate 内生效；个人自部署场景下跨 isolate 竞争概率极低。
- 用量统计为日桶近似聚合，并发写入极端情况下可能丢个别记录。
- Free 计划下用量面板最多回读约 30 个 KV 桶（子请求数限制），更早的数据不计入图表。

## 常见问题

**Q：不设置 `ADMIN_PASSWORD` secret 会怎样？**

可以用默认密码 `admin123` 登录控制台，但首次登录会被强制要求修改密码（改密前其他管理接口返回 403）。想跳过强制改密，请在部署前设置 secret 为非默认值。注意：一旦在网页上改过密码（KV 已存哈希），之后设置的 secret 不会覆盖它；只有当 KV 中的哈希仍对应默认密码时，secret 才会接管。

**Q：聊天报错 "chathub ws dial rejected by upstream (HTTP 401/403)"？**

账号的 access_token 被微软拒绝。到控制台「账号」页点击刷新令牌；若持续失败（refresh token 已失效），删除账号重新 PKCE 授权。HTTP 429 则是限流冷却，稍等即可。

## 许可证

MIT（同上游）。
