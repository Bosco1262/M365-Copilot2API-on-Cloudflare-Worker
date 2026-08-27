// Worker entry: routing + auth middleware (port of Routes()/adminMiddleware)
// and the scheduled token-refresh cron.

import { Router, type HandlerCtx } from "./router";
import type { Env } from "./env";
import { jsonOut, writeOpenAIError, uuid } from "./util";
import { handlePage } from "./pages";
import { handleModels, handleChatCompletions } from "./api/openai";
import { handleAnthropicMessages } from "./api/anthropic";
import { handleResponses } from "./api/responses";
import {
  handleImageGenerations,
  handleImageEdits,
  handleGeneratedImageFile,
} from "./api/images";
import { validAPIKey } from "./api/auth";
import * as extras from "./admin/extras";
import { handleMcpSse, handleMcpMessage, handleMcpToolsList } from "./mcp/server";

// Durable Objects must be exported from the entrypoint (wrangler requirement).
export { McpSessionDO } from "./do/mcp-hub";
export { CoordinationDO } from "./do/coordination";
import * as adminHandlers from "./admin/handlers";
import { handleChat, handleChatStream } from "./admin/chat";
import { hasValidAdminSession } from "./admin/handlers";
import { currentMustChange } from "./store/admin";
import { refreshAllExpired } from "./store/accounts";

const router = new Router();

// --- console / auth (exempt from middleware) ---
router.on("/api/admin/login", adminHandlers.handleLogin);
router.on("/api/admin/logout", adminHandlers.handleLogout);
router.on("/api/admin/session", adminHandlers.handleSessionStatus);
router.on("/api/admin/change-password", adminHandlers.handleChangePassword);
router.on("/api/auth/start", adminHandlers.handleAuthStart);
router.on("/api/auth/status", adminHandlers.handleAuthStatus);
router.on("/api/auth/callback", adminHandlers.handleAuthCallback);

// --- health/version ---
router.on("/api/health", adminHandlers.handleHealth);
router.on("/api/version", adminHandlers.handleVersion);
router.on("/api/update", adminHandlers.handleUpdate);

// --- accounts ---
router.on("/api/accounts/refresh", adminHandlers.handleAccountRefresh);
router.on("/api/accounts/schedule", adminHandlers.handleAccountSchedule);
router.on("/api/accounts/token-health", adminHandlers.handleTokenHealth);
router.on("/api/accounts/clear-cooldown", adminHandlers.handleClearCooldown);
router.on("/api/accounts/delete", adminHandlers.handleDeleteAccount);
router.on("/api/accounts/provision", adminHandlers.handleProvisionAccount);
router.on("/api/accounts", adminHandlers.handleAccountsList);

// --- admin keys/models/settings ---
router.on("/api/admin/keys", adminHandlers.handleAdminKeys);
router.on("/api/admin/models/test", adminHandlers.handleAdminModelTest);
router.on("/api/admin/models/sync", adminHandlers.handleAdminModelSync);
router.on("/api/admin/models", adminHandlers.handleAdminModels);
router.on("/api/admin/settings", adminHandlers.handleAdminSettings);
router.on("/api/admin/deployments", adminHandlers.handleDeployments);
router.on("/api/admin/deployment/check", adminHandlers.handleDeploymentCheck);
router.on("/api/admin/deployment", adminHandlers.handleDeploymentAction);
router.on("/api/admin/debug/logs", extras.handleDebugLogs);
router.on("/api/admin/debug/detail", extras.handleDebugDetail);
router.on("/api/admin/migrate/usage-kv-to-d1", extras.handleUsageKvBackfill);
router.on("/api/plugins", extras.handlePluginsList);

// --- conversations ---
router.on("/api/chat/stream", handleChatStream);
router.on("/api/chat", handleChat);
router.on("/api/conversations/delete", adminHandlers.handleConversationDelete);
router.on("/api/conversations/cleanup", adminHandlers.handleConversationCleanup);
router.on("/api/conversations/whitelist", extras.handleConversationWhitelist);
router.on("/api/conversations", adminHandlers.handleConversations);
router.on("/v1/sessions/", adminHandlers.handleSessionDeleteV1);
router.on("/v1/sessions", adminHandlers.handleSessionsV1);
router.on("/api/m365/conversations/detail", adminHandlers.handleM365ConversationDetail);
router.on("/api/m365/conversations/delete", adminHandlers.handleM365Delete);
router.on("/api/m365/conversations/cleanup", adminHandlers.handleM365Cleanup);
router.on("/api/m365/conversations", adminHandlers.handleM365Conversations);

// --- memory passthrough (memory_handlers.go port) ---
router.on("/v1/memory/flags", extras.handleMemoryFlags);
router.on("/v1/memory/instructions", extras.handleMemoryInstructions);
router.prefix("/v1/memory/instructions/", extras.handleMemoryInstructionDelete);
router.on("/v1/memory/settings", extras.handleMemorySettings);

// --- console memory management card (admin-session variants) ---
router.on("/api/admin/memory/flags", extras.handleAdminMemoryFlags);
router.on("/api/admin/memory/instructions", extras.handleAdminMemoryInstructions);
router.prefix("/api/admin/memory/instructions/", extras.handleAdminMemoryInstructionDelete);

// --- MCP gateway (internal/mcp server.go port) ---
router.on("/v1/mcp/sse", handleMcpSse);
router.on("/v1/mcp/message", handleMcpMessage);
router.on("/v1/mcp/tools", handleMcpToolsList);

// --- deployments (empty stubs on Workers) ---
router.on("/api/admin/deployments", extras.handleDeploymentsList);

// --- stats & usage ---
router.on("/api/stats/reset", adminHandlers.handleStatsReset);
router.on("/api/stats", adminHandlers.handleStats);
router.on("/api/usage/logs", adminHandlers.handleUsageLogs);
router.on("/api/usage", adminHandlers.handleUsage);

// --- OpenAI / Anthropic / Responses compatible ---
router.on("/v1/models", handleModels);
router.on("/v1/chat/completions", handleChatCompletions);
router.on("/v1/messages", handleAnthropicMessages);
router.on("/v1/responses", handleResponses);
router.on("/v1/images/generations", handleImageGenerations);
router.on("/v1/images/edits", handleImageEdits);
router.prefix("/v1/images/files/", handleGeneratedImageFile);

// Not yet ported (later phases):
const NOT_PORTED: Record<string, string> = {};

function withSecurityHeaders(resp: Response): Response {
  const headers = new Headers(resp.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(resp.body, { status: resp.status, headers });
}

async function authorize(ctx: HandlerCtx): Promise<Response | null> {
  const path = ctx.url.pathname;
  const exempt =
    path === "/api/admin/login" ||
    path === "/api/admin/session" ||
    path === "/api/admin/change-password" ||
    path === "/api/admin/logout" ||
    path === "/api/auth/start" ||
    path === "/api/auth/status" ||
    path === "/api/auth/callback" ||
    // upstream HandleSSE performs no API-key check either
    path === "/v1/mcp/sse";
  if (exempt) return null;

  if (path.startsWith("/v1/")) {
    // /v1/images/files/* is exempt like upstream adminMiddleware (C15).
    if (path.startsWith("/v1/images/files/")) return null;
    if (!(await validAPIKey(ctx))) {
      return writeOpenAIError(401, "auth_error", "valid API key required");
    }
    return null;
  }

  if (!(await hasValidAdminSession(ctx))) {
    return writeOpenAIError(401, "auth_error", "administrator login required");
  }
  if (
    (await currentMustChange(ctx.env)) &&
    path !== "/api/admin/change-password" &&
    path !== "/api/admin/logout"
  ) {
    return writeOpenAIError(
      403,
      "password_change_required",
      "administrator password must be changed before using the console"
    );
  }
  return null;
}

async function handleRequest(env: Env, req: Request, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  if (!env["m365-copilot2api_KV"]) {
    // Misconfigured deployment: the m365-copilot2api_KV binding is missing. Surface a
    // clear, actionable error instead of failing every store call with a
    // generic 500 (which previously presented as "cannot log in").
    return jsonOut(
      {
        error: {
          message:
            "KV namespace binding m365-copilot2api_KV is missing. For CLI deploys run `npx wrangler kv namespace create m365-copilot2api_KV` and set its id in wrangler.jsonc; dashboard Git deploys provision it automatically.",
          type: "configuration_error",
        },
      },
      503
    );
  }
  const url = new URL(req.url);
  const ctx: HandlerCtx = {
    env,
    req,
    url,
    requestId: uuid(),
    waitUntil,
  };

  // Pages handled by the worker (assets serve nothing else directly).
  if (url.pathname === "/" || url.pathname === "/login" || url.pathname === "/conversation" || url.pathname === "/debug") {
    if (url.pathname === "/") {
      // delegate to static assets for the SPA entry
      const resp = await env.ASSETS.fetch(new Request(new URL("/index.html", url).toString()));
      if (resp.ok) {
        const headers = new Headers(resp.headers);
        headers.set("Cache-Control", "no-store");
        return withSecurityHeaders(new Response(resp.body, { status: resp.status, headers }));
      }
    }
    return withSecurityHeaders(await handlePage(ctx));
  }

  const denied = await authorize(ctx);
  if (denied) return withSecurityHeaders(withRequestId(denied, ctx));

  const isV1 = url.pathname.startsWith("/v1/");
  const started = Date.now();
  let reqBodyText: string | undefined;
  if (
    isV1 &&
    req.method !== "GET" &&
    Number(req.headers.get("content-length") ?? "0") > 0 &&
    Number(req.headers.get("content-length") ?? "0") < 256 * 1024
  ) {
    try {
      reqBodyText = await req.clone().text();
    } catch {}
  }

  const matched0 = await router.dispatch(ctx);
  if (matched0) {
    let matched = matched0;
    if (isV1) {
      const durationMs = Date.now() - started;
      const contentType = matched.headers.get("content-type") ?? "";
      let responseBody: string | undefined;
      let responseTruncated = false;
      // #21: SSE streams pass through a passive tap (pure transform — the
      // client branch is byte-identical and never blocked by the capture);
      // the aggregated body is recorded after the stream completes.
      let streamCapture: Promise<{ text: string; truncated: boolean }> | null = null;
      if (contentType.includes("text/event-stream") && matched.body) {
        const tapped = createStreamTap(matched.body, 256 * 1024);
        matched = new Response(tapped.client, matched);
        streamCapture = tapped.done;
      } else if (contentType.includes("application/json")) {
        try {
          responseBody = (await matched.clone().text()).slice(0, 256 * 1024);
        } catch {}
      }
      ctx.waitUntil(
        (async () => {
          try {
            if (streamCapture) {
              const agg = await streamCapture;
              responseBody = agg.text;
              responseTruncated = agg.truncated;
            }
            const { getSettings } = await import("./store/settings");
            const s = await getSettings(env);
            const rank: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
            if ((rank[s.logLevel] ?? 1) > 0) return; // capture only at debug level (upstream parity)
            const { captureDebugRecord } = await import("./admin/extras");
            await captureDebugRecord(env, {
              path: url.pathname,
              method: req.method,
              status: matched.status,
              durationMs,
              requestBody: reqBodyText,
              responseBody,
              responseTruncated,
            });
          } catch {}
        })()
      );
    }
    return withSecurityHeaders(withRequestId(matched, ctx));
  }

  const notPortedMsg = NOT_PORTED[url.pathname];
  if (notPortedMsg) {
    return withSecurityHeaders(jsonOut({ error: { message: notPortedMsg, type: "not_implemented" } }, 501));
  }

  return withSecurityHeaders(withRequestId(writeOpenAIError(404, "not_found", "not found"), ctx));
}

function withRequestId(resp: Response, ctx: HandlerCtx): Response {
  const headers = new Headers(resp.headers);
  headers.set("X-Request-ID", ctx.requestId);
  return new Response(resp.body, { status: resp.status, headers });
}

// Passive tap for SSE bodies (#21): every chunk is forwarded untouched while
// a copy is buffered up to cap bytes; the done promise settles on upstream
// close OR abort, so capture can never stall or alter client delivery.
export function createStreamTap(
  source: ReadableStream<Uint8Array>,
  cap: number
): { client: ReadableStream<Uint8Array>; done: Promise<{ text: string; truncated: boolean }> } {
  let total = 0;
  let truncated = false;
  let text = "";
  let settled = false;
  const dec = new TextDecoder();
  let settleDone!: (r: { text: string; truncated: boolean }) => void;
  const done = new Promise<{ text: string; truncated: boolean }>((resolve) => {
    settleDone = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
  });
  const accept = (chunk: Uint8Array): void => {
    text += dec.decode(chunk, { stream: true });
    if (text.length >= cap) {
      text = text.slice(0, cap);
      truncated = true;
    }
  };
  const client = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const reader = source.getReader();
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            settleDone({ text, truncated: true });
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            return;
          }
          if (chunk.done) break;
          accept(chunk.value);
          controller.enqueue(chunk.value);
        }
        settleDone({ text, truncated });
        controller.close();
      })();
    },
    cancel(reason) {
      void reason;
      void source.cancel().catch(() => {});
      settleDone({ text, truncated: true });
    },
  });
  return { client, done };
}

// Aggregates a stream body up to cap bytes (kept for direct callers/tests).
export async function collectStreamBody(
  stream: ReadableStream<Uint8Array>,
  cap: number
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (text.length >= cap) {
        truncated = true;
        text = text.slice(0, cap);
        break;
      }
    }
  } catch {
    /* partial capture on stream errors */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return { text, truncated };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      return await handleRequest(env, request, (p) => ctx.waitUntil(p));
    } catch (e) {
      console.error("[recover] unhandled error:", e instanceof Error ? e.stack : String(e));
      return jsonOut(
        { error: { message: "internal error", type: "server_error" } },
        500
      );
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Port of RefreshExpiredTokens + StartAutoCleanup background loop.
    ctx.waitUntil(
      (async () => {
        try {
          const results = await refreshAllExpired(env);
          for (const r of results) {
            console.log(`[token-refresh] account=${r.email} success=${r.success}${r.error ? ` err=${r.error}` : ""}`);
          }
        } catch (e) {
          console.error("[scheduled] refresh failed:", e);
        }
        try {
          // Auto tone re-sync: refresh discoveredTones when older than 24h
          // (port of upstream liveUpstreamTones TTL behavior).
          const settingsStore = await import("./store/settings");
          const s = await settingsStore.getSettings(env);
          const age = s.discoveredTonesAt ? Date.now() - Date.parse(s.discoveredTonesAt) : Infinity;
          if (age > 24 * 3600_000) {
            const handlers = await import("./admin/handlers");
            const ctx = {
              env,
              req: new Request("https://local/cron-tone-sync"),
              url: new URL("https://local/cron-tone-sync"),
              requestId: "cron-tone-sync",
              waitUntil: () => {},
            } as never;
            const tones = await handlers.fetchUpstreamTonesAll(ctx);
            await handlers.persistDiscoveredTones(env, tones);
          }
        } catch (e) {
          console.warn("[tone-sync] auto-resync failed:", e instanceof Error ? e.message : e);
        }
        try {
          const { cleanupConfig, autoCleanupOnce } = await import("./pipeline/cleanup");
          const cfg = cleanupConfig(env);
          if (cfg.enabled) {
            const result = await autoCleanupOnce(env, cfg);
            if (result.skipped && result.deleted === 0) {
              console.log(`[auto-cleanup] skipped: ${result.skipped}`);
            }
          } else {
            console.log("[auto-cleanup] disabled via M365_AUTO_CLEANUP");
          }
        } catch (e) {
          console.error("[scheduled] cleanup failed:", e);
        }
        try {
          // Conversation viewer transcript TTL (batch C).
          const { cleanupOld } = await import("./store/chatMessages");
          await cleanupOld(env);
        } catch (e) {
          console.warn("[scheduled] chat-messages cleanup failed:", e instanceof Error ? e.message : e);
        }
        try {
          // Debug-record retention sweep (moved out of the request path by
          // the storage audit: the per-insert DELETE duplicated this cron).
          if (env.DB) {
            await env.DB.prepare("DELETE FROM debug_records WHERE at < datetime('now','-7 days')").run();
          }
        } catch (e) {
          console.warn("[scheduled] debug-records cleanup failed:", e instanceof Error ? e.message : e);
        }
      })()
    );
  },
};
