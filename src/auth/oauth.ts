// OAuth helpers (port of internal/auth: pkce.go, token.go subset).

import { oauthConfig, type Env } from "../env";
import type { TokenSet } from "../types";
import { firstNonEmpty, randomHex, sha256B64Url } from "../util";

export class OAuthError extends Error {
  code: string;
  aadsts: string;
  httpStatus: number;
  constructor(code: string, description: string, httpStatus: number) {
    super(`${code}: ${description}`.trim());
    this.name = "OAuthError";
    this.code = code;
    this.aadsts = extractAadsts(description);
    this.httpStatus = httpStatus;
  }
}

function extractAadsts(description: string): string {
  const prefix = "AADSTS";
  const start = description.indexOf(prefix);
  if (start < 0) return "";
  let end = start + prefix.length;
  while (end < description.length && description[end] >= "0" && description[end] <= "9") end++;
  if (end === start + prefix.length) return "";
  return description.slice(start, end);
}

// Port of auth.Verifier / Challenge / AuthorizationURL.
export async function newVerifier(): Promise<string> {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let binary = "";
  for (const x of b) binary += String.fromCharCode(x);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return sha256B64Url(verifier);
}

export async function authorizationURL(
  env: Env,
  state: string,
  challenge: string
): Promise<{ url: string; redirectUri: string }> {
  const cfg = oauthConfig(env);
  const q = new URLSearchParams();
  q.set("client_id", cfg.clientId);
  q.set("response_type", "code");
  q.set("redirect_uri", cfg.redirectUri);
  q.set("response_mode", "query");
  q.set("scope", cfg.scope);
  q.set("state", state);
  q.set("code_challenge", challenge);
  q.set("code_challenge_method", "S256");
  return { url: `${cfg.authorizeEndpoint}?${q.toString()}`, redirectUri: cfg.redirectUri };
}

export interface PendingPKCE {
  verifier: string;
  created: string;
  status: "pending" | "processing" | "authenticated" | "error";
  redirectURI: string;
  account?: Record<string, unknown>;
  error?: string;
}

const PKCE_TTL_SECONDS = 600;

export async function savePendingPKCE(env: Env, state: string, p: PendingPKCE): Promise<void> {
  await env["m365-copilot2api_KV"].put(`pkce/${state}`, JSON.stringify(p), { expirationTtl: PKCE_TTL_SECONDS });
}

export async function loadPendingPKCE(env: Env, state: string): Promise<PendingPKCE | null> {
  return env["m365-copilot2api_KV"].get<PendingPKCE>(`pkce/${state}`, "json");
}

export async function newPKCEState(env: Env): Promise<string> {
  const state = randomHex(16);
  return state;
}

export async function exchangeCode(
  env: Env,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<TokenSet> {
  const cfg = oauthConfig(env);
  const form = new URLSearchParams();
  form.set("client_id", cfg.clientId);
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", redirectUri || cfg.redirectUri);
  form.set("code_verifier", verifier);
  form.set("scope", cfg.scope);
  return requestToken(form.toString(), cfg.tokenEndpoint);
}

export async function ropcToken(env: Env, username: string, password: string): Promise<TokenSet> {
  const cfg = oauthConfig(env);
  const form = new URLSearchParams();
  form.set("client_id", cfg.clientId);
  form.set("grant_type", "password");
  form.set("username", username);
  form.set("password", password);
  form.set("scope", cfg.scope);
  return requestToken(form.toString(), `${cfg.authority}/organizations/oauth2/v2.0/token`);
}

async function requestToken(body: string, endpoint: string): Promise<TokenSet> {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await resp.text();
  let tr: Record<string, unknown>;
  try {
    tr = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("decode token response: invalid json");
  }
  const errCode = tr["error"] as string | undefined;
  if (errCode) {
    throw new OAuthError(errCode, (tr["error_description"] as string) ?? "", resp.status);
  }
  const accessToken = tr["access_token"] as string | undefined;
  if (!accessToken) {
    throw new Error(`token endpoint HTTP ${resp.status}: empty access token`);
  }
  const expiresIn = (tr["expires_in"] as number) ?? 3600;
  const set: TokenSet = {
    access_token: accessToken,
    refresh_token: tr["refresh_token"] as string | undefined,
    id_token: tr["id_token"] as string | undefined,
    token_type: tr["token_type"] as string | undefined,
    scope: tr["scope"] as string | undefined,
    expires_in: expiresIn,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
  // Fill identity fields from JWT claims.
  const claims = decodeClaims(accessToken) ?? decodeClaims(set.id_token ?? "") ?? {};
  set.email = firstNonEmpty(claims["unique_name"], claims["upn"], claims["preferred_username"], claims["email"]);
  set.display_name = firstNonEmpty(claims["name"], set.email);
  set.home_oid = firstNonEmpty(claims["oid"], claims["sub"]);
  set.tenant_id = firstNonEmpty(claims["tid"], claims["tenant_id"]);
  return set;
}

function decodeClaims(token: string): Record<string, string> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const raw = atob(padded);
    const m = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}
