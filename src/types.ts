// Shared domain types mirrored from internal/auth/cache.go and server.go.

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  expires_at: string; // ISO timestamp
  email?: string;
  display_name?: string;
  home_oid?: string;
  tenant_id?: string;
}

export interface AccountToken {
  id: string;
  email: string;
  displayName?: string;
  status: string;
  scheduleDisabled?: boolean;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  updatedAt: string;
  oid?: string;
  tid?: string;
  clientId?: string;
}

export interface UsageRecord {
  time: string;
  api_key_prefix: string;
  account_email?: string;
  model: string;
  endpoint: string;
  stream: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  duration_ms: number;
  status: number;
}

export interface SessionBinding {
  // sessionKey -> cloud conversation binding (mirrors sessions.json entries)
  id: string;
  accountID: string;
  conversationID: string;
  sessionID: string;
  title: string;
  updatedAt: string;
}

export interface ConversationRecord {
  id: string; // conversation id
  accountID: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
