// API-key authentication helpers for /v1/* endpoints
// (port of validAPIKey / extractAPIKey from server.go).

import type { HandlerCtx } from "../router";
import { validKey } from "../store/keys";

export function rawAPIKey(ctx: HandlerCtx): string {
  const header = (ctx.req.headers.get("X-API-Key") ?? "").trim();
  if (header !== "") return header;
  const auth = ctx.req.headers.get("Authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

export async function validAPIKey(ctx: HandlerCtx): Promise<boolean> {
  const raw = rawAPIKey(ctx);
  if (raw === "") return false;
  return validKey(ctx.env, raw);
}

export function extractAPIKeyPrefix(ctx: HandlerCtx): string {
  const key = rawAPIKey(ctx);
  return key.length > 8 ? key.slice(0, 8) + "..." : key;
}
