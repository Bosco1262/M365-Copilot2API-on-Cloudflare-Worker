// Image generation endpoints (port of internal/web/images.go):
//   POST /v1/images/generations      — prompt -> ChatHub GPT Image 2 turn
//   POST /v1/images/edits            — multipart form with image + instructions
//   GET  /v1/images/files/<id>       — generated image files (KV, 15 min TTL)
//
// Designer-hosted downloads use a separate Designer App Service token obtained
// by redeeming the account refresh token with the designer scope.

import { jsonOut, uuid } from "../util";
import type { HandlerCtx } from "../router";
import { oauthConfig } from "../env";
import {
  resolveAccount,
  markFailure,
  markSuccess,
} from "../pipeline/account";
import { chat as chathubChat, uploadAttachments } from "../chathub/client";
import { ORIGIN, USER_AGENT, isImageURL } from "../chathub/protocol";
import type { Attachment } from "../chathub/protocol";
import { extractOIDTID, writeOpenAIError } from "../util";
import { getSettings } from "../store/settings";
import type { AccountToken } from "../types";

const DESIGNER_SCOPE = "https://designerappservice.officeapps.live.com/.default";
const MAX_GENERATED_IMAGE_BYTES = 15 << 20; // KV value limit headroom
const GENERATED_IMAGE_TTL_SECONDS = 15 * 60;

function isDesignerImageURL(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "designerapp.officeapps.live.com";
  } catch {
    return false;
  }
}

async function designerAccessToken(env: import("../env").Env, acc: AccountToken): Promise<string> {
  if (!acc.refreshToken || acc.refreshToken.trim() === "") {
    throw new Error("account has no refresh token for Designer image download");
  }
  const { effectiveOAuthConfig } = await import("../env");
  const cfg = await effectiveOAuthConfig(env);
  const clientId = acc.clientId || cfg.clientId;
  const form = new URLSearchParams();
  form.set("client_id", clientId);
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", acc.refreshToken);
  form.set("scope", DESIGNER_SCOPE);
  const resp = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = (await resp.json()) as Record<string, unknown>;
  if (data["error"]) throw new Error(`obtain Designer image token: ${data["error"]}`);
  const token = data["access_token"];
  if (typeof token !== "string" || token === "") {
    throw new Error("obtain Designer image token: empty access token");
  }
  // Persist rotated refresh token when Microsoft rotates it.
  const newRefresh = data["refresh_token"];
  if (typeof newRefresh === "string" && newRefresh !== "" && newRefresh !== acc.refreshToken) {
    const { updateRefreshToken } = await import("../store/accounts");
    await updateRefreshToken(env, acc.id, newRefresh).catch(() => {});
  }
  return token;
}

async function downloadImage(
  url: string,
  accessToken?: string
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const headers: Record<string, string> = { Accept: "image/*" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`download returned ${resp.status}`);
  const ct = resp.headers.get("Content-Type") ?? "";
  if (ct && !ct.startsWith("image/") && !ct.startsWith("application/octet-stream")) {
    throw new Error("non-image content");
  }
  return { bytes: await resp.arrayBuffer(), contentType: ct || "image/png" };
}

function isImageQuotaRefusal(text: string): boolean {
  const low = text.trim().toLowerCase();
  return [
    "generate any more images",
    "image generation quota",
    "daily image limit",
    "try again tomorrow",
    "无法再生成图片",
    "请明天再试",
  ].some((p) => low.includes(p));
}

// Port of extractImageURLs: URL-shaped values inside the raw result JSON.
function extractImageURLs(raw: string): string[] {
  if (raw === "") return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const e of x) walk(e);
      return;
    }
    if (x && typeof x === "object") {
      for (const [k, e] of Object.entries(x as Record<string, unknown>)) {
        const lk = k.toLowerCase();
        if (typeof e === "string" && ["url", "imageurl", "thumbnailurl", "downloadurl", "src", "value", "data"].includes(lk)) {
          const lower = e.toLowerCase();
          if (
            e.startsWith("https://") &&
            !seen.has(e) &&
            (lower.includes("image") || /\.(png|jpe?g|webp|gif)$/.test(lower))
          ) {
            seen.add(e);
            out.push(e);
          }
        } else {
          walk(e);
        }
      }
    }
  };
  walk(v);
  return out;
}

interface ImageGenRequest {
  prompt?: string;
  n?: number;
  size?: string;
  response_format?: string;
  model?: string;
  accountId?: string;
  user?: string;
  operation?: string;
}

async function runGeneration(
  ctx: HandlerCtx,
  b: ImageGenRequest,
  attachments: Attachment[]
): Promise<Response> {
  if ((b.prompt ?? "").trim() === "") {
    return writeOpenAIError(400, "invalid_request_error", "prompt is required");
  }
  let n = b.n ?? 1;
  if (n <= 0) n = 1;
  if (n > 10) {
    return writeOpenAIError(400, "invalid_request_error", "n must be between 1 and 10");
  }
  let format = (b.response_format ?? "url").trim().toLowerCase();
  if (format === "") format = "url";
  if (format !== "url" && format !== "b64_json") {
    return writeOpenAIError(400, "invalid_request_error", "response_format must be url or b64_json");
  }

  const settings = await getSettings(ctx.env);
  let acc: AccountToken;
  try {
    acc = await resolveAccount(ctx.env, b.accountId || b.user || "");
  } catch (e) {
    console.error("[image-gen] resolve failed:", e instanceof Error ? e.stack : String(e));
    return writeOpenAIError(502, "upstream_error", describeFailure(e));
  }
  if (!acc.oid || !acc.tid) {
    const { oid, tid } = extractOIDTID(acc.accessToken);
    acc.oid = acc.oid || oid;
    acc.tid = acc.tid || tid;
  }
  if (!acc.oid || !acc.tid) {
    return writeOpenAIError(400, "invalid_request_error", "account missing oid/tid — re-login with PKCE");
  }

  const size = b.size || "1024x1024";
  const endpoint = b.operation === "edit" ? "/v1/images/edits" : "/v1/images/generations";
  const prompt =
    b.operation === "edit"
      ? `Edit the first attached image with GPT Image 2. Size: ${size}. Instructions: ${b.prompt}. Preserve everything not requested to change. Return the edited image URL directly.`
      : `Generate an image with GPT Image 2. Size: ${size}. Description: ${b.prompt}. Return the image URL directly.`;

  let res;
  try {
    res = await chathubChat(
      { accessToken: acc.accessToken, oid: acc.oid, tid: acc.tid },
      { text: prompt, tone: "magic", attachments },
      {},
      { timeoutMs: settings.imageTimeoutSeconds * 1000 }
    );
  } catch (e) {
    await markFailure(ctx.env, acc.id, e);
    console.error("[image-gen] chat failed:", e instanceof Error ? e.stack : String(e));
    return writeOpenAIError(502, "upstream_error", describeFailure(e));
  }
  await markSuccess(ctx.env, acc.id);

  let images = res.images.length > 0 ? res.images : extractImageURLs(res.rawResult);
  if (images.length === 0) images = extractImageURLs(res.text);
  if (images.length === 0) {
    if (isImageQuotaRefusal(`${res.text}\n${res.rawResult}`)) {
      return writeOpenAIErrorWithHeaders(
        429,
        "rate_limit_error",
        "M365 image generation quota is exhausted; try again later or use another account",
        { "Retry-After": "86400" }
      );
    }
    return writeOpenAIError(502, "upstream_error", "upstream returned no image resource");
  }
  images = images.slice(0, n);

  const data: Record<string, string>[] = [];
  for (const sourceUrl of images) {
    if (sourceUrl.toLowerCase().startsWith("data:image/")) {
      if (format === "b64_json") {
        const parts = sourceUrl.split(",", 2);
        if (parts.length !== 2) {
          return writeOpenAIError(502, "upstream_error", "invalid upstream image data");
        }
        data.push({ b64_json: parts[1] });
      } else {
        data.push({ url: sourceUrl });
      }
      continue;
    }
    if (!isDesignerImageURL(sourceUrl)) {
      if (format === "b64_json") {
        return writeOpenAIError(502, "unsupported_response_format", "upstream returned URL, not b64_json");
      }
      data.push({ url: sourceUrl });
      continue;
    }
    try {
      const designerToken = await designerAccessToken(ctx.env, acc);
      const { bytes, contentType } = await downloadImage(sourceUrl, designerToken);
      if (bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
        // Too large for KV storage; only b64_json can carry it inline.
        if (format === "b64_json") {
          const b64 = arrayBufferToBase64(bytes);
          data.push({ b64_json: b64 });
          continue;
        }
        return writeOpenAIError(502, "upstream_error", "generated image exceeds storage limit");
      }
      if (format === "b64_json") {
        data.push({ b64_json: arrayBufferToBase64(bytes) });
        continue;
      }
      const fileId = uuid();
      await ctx.env["m365-copilot2api_KV"].put(`img/${fileId}`, arrayBufferToBase64(bytes), {
        expirationTtl: GENERATED_IMAGE_TTL_SECONDS,
        metadata: { contentType },
      });
      const proto = ctx.req.headers.get("X-Forwarded-Proto") ?? ctx.url.protocol.replace(":", "");
      data.push({ url: `${proto}://${ctx.url.host}/v1/images/files/${fileId}` });
    } catch (e) {
      console.error("[image-gen-download]", e instanceof Error ? e.stack : String(e));
      return writeOpenAIError(502, "upstream_error", "designer image download failed");
    }
  }

  ctx.waitUntil(
    Promise.resolve().then(async () => {
      const { recordUsage } = await import("../store/usage");
      const { extractAPIKeyPrefix } = await import("./auth");
      await recordUsage(ctx.env, {
        time: new Date().toISOString(),
        api_key_prefix: extractAPIKeyPrefix(ctx),
        account_email: acc.email,
        model: b.model || "gpt-image-2",
        endpoint,
        stream: false,
        input_tokens: Math.floor((prompt.length * 2) / 3),
        output_tokens: 0,
        cache_tokens: 0,
        duration_ms: 0,
        status: 200,
      }).catch(() => {});
    })
  );

  return jsonOut({
    created: Math.floor(Date.now() / 1000),
    data,
    m365: { conversationId: res.conversationId, sessionId: res.sessionId, images },
  });
}

export async function handleImageGenerations(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let b: ImageGenRequest;
  try {
    b = (await ctx.req.json()) as ImageGenRequest;
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "prompt is required");
  }
  return runGeneration(ctx, b, []);
}

export async function handleImageEdits(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let form: FormData;
  try {
    form = await ctx.req.formData();
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "multipart form required");
  }
  const prompt = String(form.get("prompt") ?? "");
  if (prompt.trim() === "") {
    return writeOpenAIError(400, "invalid_request_error", "prompt is required");
  }
  const size = String(form.get("size") ?? "");
  const responseFormat = String(form.get("response_format") ?? "");
  const nRaw = Number(form.get("n") ?? 1);

  const attachments: Attachment[] = [];
  for (const field of ["image", "image[]"]) {
    const file = form.get(field);
    if (file && typeof file !== "string") {
      const buf = await (file as File).arrayBuffer();
      const mime = (file as File).type || "image/png";
      const b64 = arrayBufferToBase64(buf);
      attachments.push({
        type: "image",
        url: `data:${mime};base64,${b64}`,
        mimeType: mime,
        name: (file as File).name || undefined,
      });
      break;
    }
  }
  if (attachments.length === 0) {
    return writeOpenAIError(400, "invalid_request_error", "image is required");
  }
  return runGeneration(
    ctx,
    { prompt, size, response_format: responseFormat, n: Number.isFinite(nRaw) ? nRaw : 1, operation: "edit" },
    attachments
  );
}

export async function handleGeneratedImageFile(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const id = ctx.url.pathname.slice("/v1/images/files/".length);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return new Response("Not Found", { status: 404 });
  }
  const meta = await ctx.env["m365-copilot2api_KV"].getWithMetadata<{ contentType?: string }>(`img/${id}`);
  const b64 = await ctx.env["m365-copilot2api_KV"].get(`img/${id}`);
  if (!b64) return new Response("Not Found", { status: 404 });
  const contentType = meta.metadata?.contentType ?? "image/png";
  const body = base64ToArrayBuffer(b64);
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=300",
    },
  });
}

function writeOpenAIErrorWithHeaders(
  status: number,
  typ: string,
  msg: string,
  headers: Record<string, string>
): Response {
  return new Response(JSON.stringify({ error: { message: msg, type: typ } }) + "\n", {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function describeFailure(e: unknown): string {
  const name = (e as Error)?.name ?? "";
  if (name === "RateLimitNotice") return "upstream is rate limiting; try again shortly";
  if (name === "EmptyCompletion")
    return "upstream returned empty completion; the requested model may be unavailable for this tenant";
  return "upstream request failed";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Re-export for potential reuse.
export { uploadAttachments, ORIGIN, USER_AGENT, isImageURL };
