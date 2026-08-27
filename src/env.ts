// Environment bindings and OAuth configuration (port of internal/auth/config.go).

export interface Env {
  "m365-copilot2api_KV": KVNamespace;
  ASSETS: Fetcher;

  // Optional D1 binding: when present, usage events and debug records are
  // stored in D1 instead of KV (see migrations/0001_init.sql).
  DB?: D1DatabaseLite;
  // Optional DO binding for MCP cross-isolate sessions.
  MCP_HUB?: DurableObjectNamespaceLite;
  // Optional DO binding for global coordination (login lockout, account
  // round-robin cursor, per-account concurrency semaphore, refresh mutex).
  // When unbound every consumer falls back to the previous isolate-local
  // behavior.
  COORD?: DurableObjectNamespaceLite;

  // secrets / vars (all optional)
  ADMIN_PASSWORD?: string;
  M365_BROWSER_CLIENT_ID?: string;
  M365_BROWSER_AUTHORITY?: string;
  M365_BROWSER_REDIRECT_URI?: string;
  M365_BROWSER_SCOPE?: string;
  M365_CLIENT_ID?: string;
  M365_AUTHORITY?: string;
  M365_REDIRECT_URI?: string;
  M365_SCOPE?: string;
  M365_DEVICE_CLIENT_ID?: string;
  M365_DEVICE_AUTHORITY?: string;
  M365_DEVICE_SCOPE?: string;
  M365_CHAT_TIMEOUT_SECONDS?: string;
  M365_RATE_LIMIT_COOLDOWN_SECONDS?: string;
  M365_INCLUDE_UPSTREAM_EVENTS?: string;
  // Exact AAD endpoint overrides (port of auth/config.go AuthorizeEndpoint /
  // TokenEndpoint / DeviceCodeEndpoint / DeviceTokenEndpoint). Highest
  // priority over the authority-derived defaults.
  M365_AUTHORIZE_ENDPOINT?: string;
  M365_TOKEN_ENDPOINT?: string;
  M365_DEVICE_ENDPOINT?: string;
  M365_DEVICE_TOKEN_ENDPOINT?: string;
}

export const DEFAULT_ADMIN_PASSWORD = "admin123";

// Minimal structural types so the app compiles without pulling the full
// workers-types definitions for D1/DO (runtime objects are richer).
export interface D1PreparedStatementLite {
  bind(...values: (string | number | null | boolean)[]): D1PreparedStatementLite;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface D1DatabaseLite {
  prepare(query: string): D1PreparedStatementLite;
  batch(statements: D1PreparedStatementLite[]): Promise<unknown>;
}
export interface DurableObjectNamespaceLite {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): {
    fetch(input: RequestInfo | string, init?: RequestInit): Promise<Response>;
  };
}
export interface DurableObjectStorageLite {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface DurableObjectStateLite {
  storage: DurableObjectStorageLite;
}

// Office web Copilot first-party client (verified working with ChatHub via
// browser PKCE), mirrored from internal/auth/config.go.
export const DEFAULT_CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
export const FOCI_CLIENT_ID = "d3590ed6-52b3-4102-aeff-aad2292ab01c";
export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/common";
export const DEFAULT_REDIRECT_URI =
  "https://login.microsoftonline.com/common/oauth2/nativeclient";
export const DEFAULT_SCOPE =
  "openid profile offline_access https://substrate.office.com/sydney/M365Chat.Read https://substrate.office.com/sydney/sydney.readwrite";

function pick(env: Env, specific: string[], generic: string[], fallback: string): string {
  for (const key of specific) {
    const v = (env as unknown as Record<string, string | undefined>)[key];
    if (v && v.trim() !== "") return v.trim();
  }
  for (const key of generic) {
    const v = (env as unknown as Record<string, string | undefined>)[key];
    if (v && v.trim() !== "") return v.trim();
  }
  return fallback;
}

export function oauthConfig(env: Env) {
  const clientId = pick(env, ["M365_BROWSER_CLIENT_ID"], ["M365_CLIENT_ID"], DEFAULT_CLIENT_ID);
  const deviceClientId = pick(env, ["M365_DEVICE_CLIENT_ID"], ["M365_CLIENT_ID"], FOCI_CLIENT_ID);
  const authority = pick(env, ["M365_BROWSER_AUTHORITY", "M365_DEVICE_AUTHORITY"], ["M365_AUTHORITY"], DEFAULT_AUTHORITY);
  const deviceAuthority = pick(env, ["M365_DEVICE_AUTHORITY"], ["M365_AUTHORITY"], DEFAULT_AUTHORITY);
  const redirectUri = pick(env, ["M365_BROWSER_REDIRECT_URI"], ["M365_REDIRECT_URI"], DEFAULT_REDIRECT_URI);
  const scope = pick(env, ["M365_BROWSER_SCOPE", "M365_DEVICE_SCOPE"], ["M365_SCOPE"], DEFAULT_SCOPE);
  // Exact endpoint overrides win over the authority-derived paths (upstream
  // config.go: exact env vars are checked first, then Authority()+suffix).
  const authorizeEndpoint = pick(env, ["M365_AUTHORIZE_ENDPOINT"], [], `${authority}/oauth2/v2.0/authorize`);
  const tokenEndpoint = pick(env, ["M365_TOKEN_ENDPOINT"], [], `${authority}/oauth2/v2.0/token`);
  const deviceCodeEndpoint = pick(env, ["M365_DEVICE_ENDPOINT"], [], `${deviceAuthority}/oauth2/v2.0/devicecode`);
  const deviceTokenEndpoint = pick(env, ["M365_DEVICE_TOKEN_ENDPOINT"], [], `${deviceAuthority}/oauth2/v2.0/token`);
  return {
    clientId,
    deviceClientId,
    authority,
    redirectUri,
    scope,
    authorizeEndpoint,
    tokenEndpoint,
    deviceCodeEndpoint,
    deviceTokenEndpoint,
  };
}

// Settings-saved OAuth fields take priority over deploy-time bindings
// (port of ApplyStartupSettingsEnv semantics, evaluated lazily per request).
export async function effectiveOAuthConfig(env: Env): Promise<ReturnType<typeof oauthConfig>> {
  const base = oauthConfig(env);
  try {
    const { getSettings } = await import("./store/settings");
    const s = await getSettings(env);
    const over = (v: string, fb: string) => (v && v.trim() !== "" ? v.trim() : fb);
    const clientId = over(s.clientId, base.clientId);
    const authority = over(s.authority, base.authority);
    const redirectUri = over(s.redirectUri, base.redirectUri);
    const scope = over(s.scope, base.scope);
    // Exact env overrides still win; otherwise derive from the effective
    // authority (device endpoints keep the base device authority since the
    // settings schema has no separate device-authority field).
    const authorizeEndpoint =
      (env.M365_AUTHORIZE_ENDPOINT && env.M365_AUTHORIZE_ENDPOINT.trim() !== "")
        ? env.M365_AUTHORIZE_ENDPOINT.trim()
        : `${authority}/oauth2/v2.0/authorize`;
    const tokenEndpoint =
      (env.M365_TOKEN_ENDPOINT && env.M365_TOKEN_ENDPOINT.trim() !== "")
        ? env.M365_TOKEN_ENDPOINT.trim()
        : `${authority}/oauth2/v2.0/token`;
    return {
      ...base,
      clientId,
      authority,
      redirectUri,
      scope,
      authorizeEndpoint,
      tokenEndpoint,
    };
  } catch {
    return base;
  }
}
