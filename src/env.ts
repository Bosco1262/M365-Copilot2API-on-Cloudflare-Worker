// Environment bindings and OAuth configuration (port of internal/auth/config.go).

export interface Env {
  "m365-copilot2api_KV": KVNamespace;
  ASSETS: Fetcher;

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
  M365_INCLUDE_UPSTREAM_EVENTS?: string;
}

export const DEFAULT_ADMIN_PASSWORD = "admin123";

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
  const redirectUri = pick(env, ["M365_BROWSER_REDIRECT_URI"], ["M365_REDIRECT_URI"], DEFAULT_REDIRECT_URI);
  const scope = pick(env, ["M365_BROWSER_SCOPE", "M365_DEVICE_SCOPE"], ["M365_SCOPE"], DEFAULT_SCOPE);
  return {
    clientId,
    deviceClientId,
    authority,
    redirectUri,
    scope,
    authorizeEndpoint: `${authority}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${authority}/oauth2/v2.0/token`,
    deviceCodeEndpoint: `${authority}/oauth2/v2.0/devicecode`,
  };
}
