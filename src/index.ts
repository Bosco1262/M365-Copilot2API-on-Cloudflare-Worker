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
router.on("/api/admin/debug/logs", adminHandlers.handleDebugLogs);
router.on("/api/admin/debug/detail", adminHandlers.handleDebugDetail);

// --- conversations ---
router.on("/api/chat/stream", handleChatStream);
router.on("/api/chat", handleChat);
router.on("/api/conversations/delete", adminHandlers.handleConversationDelete);
router.on("/api/conversations/cleanup", adminHandlers.handleConversationCleanup);
router.on("/api/conversations/whitelist", adminHandlers.handleConversationWhitelist);
router.on("/api/conversations", adminHandlers.handleConversations);
router.on("/v1/sessions/", adminHandlers.handleSessionDeleteV1);
router.on("/v1/sessions", adminHandlers.handleSessionsV1);
router.on("/api/m365/conversations/detail", adminHandlers.handleM365ConversationDetail);
router.on("/api/m365/conversations/delete", adminHandlers.handleM365Delete);
router.on("/api/m365/conversations/cleanup", adminHandlers.handleM365Cleanup);
router.on("/api/m365/conversations", adminHandlers.handleM365Conversations);

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
const NOT_PORTED: Record<string, string> = {
  "/v1/mcp/sse": "MCP gateway arrives in a later phase",
  "/v1/mcp/message": "MCP gateway arrives in a later phase",
  "/v1/mcp/tools": "MCP gateway arrives in a later phase",
};

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
    path === "/api/auth/callback";
  if (exempt) return null;

  if (path.startsWith("/v1/")) {
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
  if (denied) return withSecurityHeaders(denied);

  const matched = await router.dispatch(ctx);
  if (matched) return withSecurityHeaders(matched);

  const notPortedMsg = NOT_PORTED[url.pathname];
  if (notPortedMsg) {
    return withSecurityHeaders(jsonOut({ error: { message: notPortedMsg, type: "not_implemented" } }, 501));
  }

  return withSecurityHeaders(writeOpenAIError(404, "not_found", "not found"));
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
      })()
    );
  },
};
