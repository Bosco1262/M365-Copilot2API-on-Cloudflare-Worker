// diagnose-stream.mjs — 诊断 Cherry Studio 流式输出丢字问题
//
// 用法（Node 18+，无需安装依赖）：
//   node scripts/diagnose-stream.mjs <API_BASE_URL> <API_KEY> [--model <模型名>] [--responses] [提示词...]
//
// 示例：
//   node scripts/diagnose-stream.mjs https://your-worker.workers.dev sk-xxxxxx \
//       --model gpt-4o-mini "用表格对比 NFS 与 Ceph 的部署、扩展性、可用性、学习成本"
//
// 它会：
//   1. 用 stream:false 拿一份"权威完整文本"；
//   2. 用 stream:true 逐 delta 打印并拼接；
//   3. 自动对比两者，报告第一个分歧位置，从而判断丢字发生在服务端还是客户端。

const [baseURL, apiKey, ...rest] = process.argv.slice(2);
if (!baseURL || !apiKey) {
  console.error("用法: node scripts/diagnose-stream.mjs <API_BASE_URL> <API_KEY> [--model M] [--responses] [提示词...]");
  process.exit(1);
}

const model = (() => {
  const i = rest.indexOf("--model");
  return i >= 0 && rest[i + 1] ? rest[i + 1] : "gpt-4o-mini";
})();
const useResponses = rest.includes("--responses");
const prompt = rest.filter((x) => !x.startsWith("--model") && x !== "--responses" && x !== model).join(" ") ||
  "用表格对比 NFS 与 Ceph 的部署、扩展性、可用性、学习成本，用中文 markdown 表格输出";

const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
const endpoint = useResponses ? "/v1/responses" : "/v1/chat/completions";

async function nonStreaming() {
  const body = useResponses
    ? { model, input: prompt }
    : { model, messages: [{ role: "user", content: prompt }], stream: false };
  const res = await fetch(`${baseURL}${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`非流式请求失败 HTTP ${res.status}:`, JSON.stringify(j)?.slice(0, 500));
    process.exit(1);
  }
  let text = "";
  if (useResponses) {
    text = j?.output?.filter((x) => x.type === "message").map((m) => m.content?.map((c) => c.text ?? "").join("")).join("") ?? "";
  } else {
    text = j?.choices?.[0]?.message?.content ?? "";
  }
  console.log("\n=== [1] 非流式完整内容（权威文本，长度 " + text.length + "）===");
  console.log(JSON.stringify(text));
  return text;
}

async function streaming() {
  const body = useResponses
    ? { model, input: prompt, stream: true }
    : { model, messages: [{ role: "user", content: prompt }], stream: true };
  const res = await fetch(`${baseURL}${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) });
  console.log("\n=== [2] 流式响应 status=" + res.status + " content-type=" + res.headers.get("content-type") + " ===");
  if (!res.ok || !res.body) {
    console.error("流式请求失败:", await res.text().catch(() => "").then((t) => t.slice(0, 500)));
    process.exit(1);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let joined = "";
  let n = 0;
  let reasonChunks = 0;
  let firstRaw = ""; // 前 2 个 SSE 事件的原始文本，用于检查字节层面是否损坏
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (firstRaw.length < 800) firstRaw += event + "\n----\n";
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          if (j.error) console.log("[上游错误事件]", JSON.stringify(j.error).slice(0, 300));
          const delta = j.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === "string" && delta.content !== "") {
            joined += delta.content;
            n++;
            if (n <= 30 || n % 50 === 0) console.log(`[delta#${n}] len=${delta.content.length} ${JSON.stringify(delta.content.slice(0, 60))}`);
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") reasonChunks++;
        } catch { /* 忽略非 JSON 行 */ }
      }
    }
  }
  console.log("\n=== [3] 流式 delta 拼接结果（文本 delta 共 " + n + " 个，reasoning delta 共 " + reasonChunks + " 个，拼接长度 " + joined.length + "）===");
  console.log(JSON.stringify(joined));
  console.log("\n=== [4] 前 2 个 SSE 事件原文（检查字节层是否完好）===");
  console.log(firstRaw);
  return joined;
}

const a = await nonStreaming();
const b = await streaming();

console.log("\n=== [5] 对比结论 ===");
if (!a || !b) {
  console.log("非流式或流式内容为空，无法对比。");
} else if (b === a) {
  console.log("✅ 流式拼接 === 非流式内容：服务端流式数据完整，丢字发生在 Cherry Studio 端（渲染/解析）。");
} else if (a.startsWith(b)) {
  console.log("⚠️ 流式拼接只是非流式的前缀：服务端流式在结尾截断了，缺失尾部：");
  console.log("   " + JSON.stringify(a.slice(b.length).slice(0, 200)));
} else {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  console.log(`⚠️ 第 ${i} 个字符处开始分歧（流式长度为 ${b.length}，非流式为 ${a.length}）：`);
  console.log("   非流式此处: " + JSON.stringify(a.slice(Math.max(0, i - 25), i + 35)));
  console.log("   流式此处:   " + JSON.stringify(b.slice(Math.max(0, i - 25), i + 35)));
  console.log("\n若流式输出的字符总数明显少于非流式 → 服务端流式 delta 丢字；");
  console.log("若字符总数一致但顺序/内容错位 → 服务端 delta 顺序或对账问题；");
  console.log("若完全一致 → 问题在 Cherry Studio 的渲染/复制。");
}
