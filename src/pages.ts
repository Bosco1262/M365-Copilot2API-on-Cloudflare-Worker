// HTML page routes (port of rootPage from security_http.go).
// "/" is served directly by Workers Static Assets; /login, /conversation and
// /debug are mapped onto their asset files here.

import type { HandlerCtx } from "./router";
import { writeOpenAIError } from "./util";

const PAGES: Record<string, string> = {
  "/login": "/login.html",
  "/conversation": "/conversation.html",
  "/debug": "/debug.html",
};

export async function handlePage(ctx: HandlerCtx): Promise<Response> {
  const name = PAGES[ctx.url.pathname];
  if (!name) {
    return writeOpenAIError(404, "not_found", "not found");
  }
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const assetUrl = new URL(ctx.req.url);
  assetUrl.pathname = name;
  assetUrl.search = "";
  const resp = await ctx.env.ASSETS.fetch(new Request(assetUrl.toString()));
  if (!resp.ok) {
    return writeOpenAIError(500, "server_error", "web interface unavailable");
  }
  const headers = new Headers(resp.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(resp.body, { status: resp.status, headers });
}
