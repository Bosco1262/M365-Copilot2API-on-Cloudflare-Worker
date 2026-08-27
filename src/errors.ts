// Upstream error taxonomy (port of internal/web/account_health.go error helpers
// plus chathub DialError / ErrRateLimitNotice / ErrEmptyCompletion).

export class UpstreamHTTPError extends Error {
  status: number;
  retryAfter: number;
  body: string;
  /** Structured upstream error code (e.g. ErrorUserBanned), when parsed. */
  errorCode?: string;
  constructor(status: number, retryAfter = 0, body = "", errorCode = "") {
    super(`upstream http ${status}`);
    this.name = "UpstreamHTTPError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.body = body;
    if (errorCode !== "") this.errorCode = errorCode;
  }
}

export class DialError extends Error {
  status: number;
  retryAfter: number;
  /** Transport/upstream classification (port of chathub DialError.Kind, C3). */
  kind: string;
  constructor(status: number, retryAfter = 0, kind = "") {
    super(kind !== "" ? `ws dial: ${kind} upstream ${status}` : `ws dial: upstream ${status}`);
    this.name = "DialError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.kind = kind;
  }
}

// Port of chathub.classifyTransportError: maps an error message onto a
// transport category so cooldowns and diagnostics can be bucketed (C3).
export function classifyTransportError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("socks")) return "SOCKS5";
  if (
    m.includes("no such host") ||
    m.includes("no address associated") ||
    m.includes("name resolution") ||
    m.includes("dns")
  ) {
    return "DNS";
  }
  if (m.includes("tls") || m.includes("certificate") || m.includes("x509")) return "TLS";
  if (m.includes("handshake")) return "WS_HANDSHAKE";
  if (
    m.includes("i/o timeout") ||
    m.includes("deadline exceeded") ||
    (m.includes("timeout") && m.includes("read"))
  ) {
    return "WS_READ_TIMEOUT";
  }
  if (
    m.includes("connection refused") ||
    m.includes("connection reset") ||
    m.includes("broken pipe") ||
    m.includes("network is unreachable") ||
    m.includes("connection was forcibly closed")
  ) {
    return "TCP";
  }
  if (m.includes("timeout")) return "WS_READ_TIMEOUT";
  return "TCP";
}

// Port of chathub.wrapDialError: HTTP status kinds take precedence; otherwise
// classify the transport error (C3).
export function dialErrorKind(status: number, cause?: unknown): string {
  if (status === 429) return "QUOTA_429";
  if (status === 503) return "OVERLOAD_503";
  if (status === 401) return "AUTH_EXPIRED_401";
  if (status === 403) return "FORBIDDEN_403";
  if (cause instanceof Error && cause.name === "AbortError") return "CLIENT_CANCELED";
  if (cause instanceof Error) return classifyTransportError(cause.message);
  return "";
}

export class RateLimitNotice extends Error {
  constructor() {
    super("upstream rate-limit notice");
    this.name = "RateLimitNotice";
  }
}

export class EmptyCompletion extends Error {
  constructor() {
    super("upstream returned empty completion; tone may be unavailable for this tenant");
    this.name = "EmptyCompletion";
  }
}

export class ImageLimitError extends Error {
  constructor() {
    super("upstream image generation daily limit reached");
    this.name = "ImageLimitError";
  }
}

export class ContentPolicyError extends Error {
  constructor() {
    super("upstream content policy flagged as offensive");
    this.name = "ContentPolicyError";
  }
}

const anyErr = (e: unknown): Record<string, unknown> | null =>
  e instanceof Object ? (e as Record<string, unknown>) : null;

export function isRateLimited(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RateLimitNotice) return true;
  const e = anyErr(err);
  if (!e) return false;
  const name = (e["name"] as string) ?? "";
  if (name === "UpstreamHTTPError") {
    const status = e["status"] as number;
    const body = String(e["body"] ?? "").toLowerCase();
    if (status === 429 || status === 503) return true;
    if (body.includes("limited")) return true;
  }
  if (name === "DialError") {
    const status = e["status"] as number;
    if (status === 429 || status === 503) return true;
  }
  return false;
}

export function isAuthFailure(err: unknown): boolean {
  if (!err) return false;
  const e = anyErr(err);
  if (!e) return false;
  const name = (e["name"] as string) ?? "";
  if (name === "UpstreamHTTPError" || name === "DialError") {
    const status = e["status"] as number;
    return status === 401 || status === 403;
  }
  return false;
}

export function isEmptyCompletion(err: unknown): boolean {
  return err instanceof EmptyCompletion;
}

export function isImageLimited(err: unknown): boolean {
  return err instanceof ImageLimitError;
}

export function isContentPolicy(err: unknown): boolean {
  return err instanceof ContentPolicyError;
}

export function retryAfterSeconds(err: unknown): number {
  const e = anyErr(err);
  if (!e) return 0;
  const name = (e["name"] as string) ?? "";
  if (name === "UpstreamHTTPError" || name === "DialError") {
    return (e["retryAfter"] as number) ?? 0;
  }
  return 0;
}

// Safe, diagnostic error text for client-visible responses: identifies the
// failure category without leaking tokens, URLs or upstream payloads.
export function describeUpstream(err: unknown): string {
  if (!err) return "upstream request failed";
  const msg = err instanceof Error ? err.message : String(err);
  const name = (err as Error)?.name ?? "";
  if (name === "RateLimitNotice") return "upstream is rate limiting; try again shortly";
  if (name === "EmptyCompletion")
    return "upstream returned empty completion; the requested model may be unavailable for this tenant";
  if (name === "ImageLimitError")
    return "upstream image generation daily limit reached; try again tomorrow or switch account";
  if (name === "ContentPolicyError")
    return "M365 content policy flagged this request; try again or switch account";
  if (name === "DialError") {
    const status = (err as DialError).status;
    if (status === 429 || status === 401 || status === 403) {
      return `chathub ws dial rejected by upstream (HTTP ${status}); the account token may need refresh or re-authorization`;
    }
    if (status === 101) {
      // Legacy misclassification guard; should no longer occur.
      return "upstream request failed";
    }
    return `chathub ws dial failed (upstream HTTP ${status})`;
  }
  if (name === "OAuthError") return `Microsoft auth failed: ${msg}`;
  if (
    msg.startsWith("token_expired") ||
    msg.includes("AADSTS") ||
    msg.includes("no accounts; login first") ||
    msg.includes("account not found") ||
    msg.includes("cooling down") ||
    msg.includes("missing access token")
  ) {
    return msg;
  }
  if (msg.includes("deadline exceeded")) return "chathub response deadline exceeded before completion";
  if (msg.includes("ws read before completion")) return "chatHub connection dropped before completion";
  if (msg.includes("completion error")) return `chathub ${msg}`;
  return "upstream request failed";
}

// ------------------------------------------------------------ classification ---
// Error taxonomy for account-health cooldowns (port of upstream
// ClassifyError + CooldownForCategory from internal/web/account_health.go).

export type ErrorCategory =
  | "QUOTA_429"
  | "OVERLOAD_503"
  | "AUTH_EXPIRED_401"
  | "FORBIDDEN_403"
  | "RETRYABLE_422"
  | "USER_BANNED"
  | "USER_THROTTLED"
  | "INSUFFICIENT_TOKENS"
  | "DESIGNER_DISABLED"
  | "SOCKS5"
  | "DNS"
  | "TCP"
  | "TLS"
  | "WS_HANDSHAKE"
  | "WS_READ_TIMEOUT"
  | "UPSTREAM_STRUCTURED"
  | "CLIENT_CANCELED"
  | "GLOBAL_UNAVAILABLE"
  | "UNKNOWN";

const CATEGORY_KINDS: Record<string, ErrorCategory> = {
  QUOTA_429: "QUOTA_429",
  OVERLOAD_503: "OVERLOAD_503",
  AUTH_EXPIRED_401: "AUTH_EXPIRED_401",
  FORBIDDEN_403: "FORBIDDEN_403",
  SOCKS5: "SOCKS5",
  DNS: "DNS",
  TCP: "TCP",
  TLS: "TLS",
  WS_HANDSHAKE: "WS_HANDSHAKE",
  WS_READ_TIMEOUT: "WS_READ_TIMEOUT",
  CLIENT_CANCELED: "CLIENT_CANCELED",
};

// Port of upstream ClassifyError (account_health.go:50-179) mapped onto the
// Worker error model (DialError kind/status, UpstreamHTTPError status/body,
// RateLimitNotice, EmptyCompletion, ContentPolicyError, ImageLimitError).
export function classifyError(err: unknown): ErrorCategory {
  if (!err) return "UNKNOWN";
  const name = err instanceof Error ? err.name : (err as { name?: string } | null)?.name ?? "";
  if (name === "RateLimitNotice") return "QUOTA_429";
  if (err instanceof EmptyCompletion || err instanceof ContentPolicyError || err instanceof ImageLimitError) {
    return "UPSTREAM_STRUCTURED";
  }
  if (name === "AbortError") return "CLIENT_CANCELED";
  if (err instanceof DialError) {
    if (err.kind !== "") {
      const mapped = CATEGORY_KINDS[err.kind];
      if (mapped) return mapped;
      // Raw transport kind string ("SOCKS5" etc.) — already covered above.
      return (CATEGORY_KINDS[String(err.kind).toUpperCase()] ?? "UNKNOWN") as ErrorCategory;
    }
    return categoryForStatus(err.status, err);
  }
  if (err instanceof UpstreamHTTPError) {
    if (err.errorCode) {
      switch (err.errorCode) {
        case "ErrorUserBanned":
          return "USER_BANNED";
        case "ErrorUserThrottled":
          return "USER_THROTTLED";
        case "InsufficientTokens":
          return "INSUFFICIENT_TOKENS";
        case "ErrorDisallowedAADUser":
          return "DESIGNER_DISABLED";
      }
    }
    return categoryForStatus(err.status, err);
  }
  const e = err as { status?: number } | null;
  if (e && typeof e === "object" && typeof e.status === "number") {
    return categoryForStatus(e.status, err);
  }
  // Message heuristics (upstream final switch): transport categories.
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("socks")) return "SOCKS5";
  if (msg.includes("no such host") || msg.includes("name resolution") || (msg.includes("dns") && !msg.includes("limited"))) return "DNS";
  if (msg.includes("tls") || msg.includes("certificate") || msg.includes("x509")) return "TLS";
  if (msg.includes("handshake")) return "WS_HANDSHAKE";
  if (msg.includes("ws read") || (msg.includes("timeout") && msg.includes("read")) || msg.includes("deadline exceeded")) return "WS_READ_TIMEOUT";
  if (msg.includes("connection refused") || msg.includes("connection reset") || msg.includes("broken pipe") || msg.includes("network is unreachable")) return "TCP";
  if (msg.includes("client canceled") || msg.includes("context canceled")) return "CLIENT_CANCELED";
  if (msg.includes("empty completion") || msg.includes("offensive") || msg.includes("image limit")) return "UPSTREAM_STRUCTURED";
  return "UNKNOWN";
}

function categoryForStatus(status: number, err: unknown): ErrorCategory {
  switch (status) {
    case 429:
      return "QUOTA_429";
    case 503:
      return "OVERLOAD_503";
    case 401:
      return "AUTH_EXPIRED_401";
    case 403:
      return "FORBIDDEN_403";
    case 422:
      return "RETRYABLE_422";
  }
  const body = String((err as { body?: unknown } | null)?.body ?? "").toLowerCase();
  if (body.includes("limited") || body.includes("metererror")) return "QUOTA_429";
  return "UNKNOWN";
}

// Port of upstream CooldownForCategory (account_health.go:241-299).
// `attempt` is the 1-based consecutive quota-failure counter (exponential
// backoff only applies to QUOTA_429 without a Retry-After header).
export function cooldownMsForCategory(cat: ErrorCategory, retryAfter: number, attempt: number): number {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  switch (cat) {
    case "QUOTA_429":
      if (retryAfter > 0) return Math.min(retryAfter * 1000, 30 * 60_000);
      {
        const a = Math.min(Math.max(attempt < 1 ? 1 : attempt, 1), 7);
        const d = 30_000 * 2 ** (a - 1);
        return d > 30 * 60_000 || d <= 0 ? 30 * 60_000 : d;
      }
    case "OVERLOAD_503":
      return 15_000;
    case "AUTH_EXPIRED_401":
      return 2 * 60_000;
    case "FORBIDDEN_403":
      return DAY;
    case "USER_BANNED":
      return 365 * DAY;
    case "USER_THROTTLED":
      return HOUR;
    case "INSUFFICIENT_TOKENS":
      return DAY;
    case "DESIGNER_DISABLED":
      return 0;
    case "RETRYABLE_422":
      return 5_000;
    case "SOCKS5":
    case "DNS":
    case "TLS":
    case "WS_READ_TIMEOUT":
      return 30_000;
    case "TCP":
    case "WS_HANDSHAKE":
      return 15_000;
    case "UPSTREAM_STRUCTURED":
      return 10_000;
    case "CLIENT_CANCELED":
      return 0;
    case "GLOBAL_UNAVAILABLE":
      return 15_000;
    default:
      return 15_000;
  }
}

/** True when the category must not cool down (client cancelled). */
export function isClientCanceledCategory(cat: ErrorCategory): boolean {
  return cat === "CLIENT_CANCELED";
}

/**
 * 30s sliding-window global circuit breaker (port of upstream globalCircuit,
 * account_health.go:301-397). Open when >=10 calls in the window and the
 * failure rate is >=50%; while open every account is unavailable for 30s.
 * Stored per-process (isolate) on the KV fallback path; the Coordination DO
 * keeps the strongly-consistent copy when bound.
 */
export interface GlobalCircuitState {
  windowStart: number;
  total: number;
  failures: number;
  openUntil: number;
}

export function emptyCircuit(): GlobalCircuitState {
  return { windowStart: 0, total: 0, failures: 0, openUntil: 0 };
}

export function circuitIsOpen(c: GlobalCircuitState, t = Date.now()): boolean {
  if (!c || c.openUntil === 0) return false;
  if (t < c.openUntil) return true;
  c.openUntil = 0;
  return false;
}

/**
 * Records one outcome. Pass `null` for a success (port of
 * GlobalCircuitRecord(nil)); a failure category is skipped for
 * CLIENT_CANCELED / GLOBAL_UNAVAILABLE so a stuck-open circuit never
 * renews itself.
 */
export function circuitRecord(c: GlobalCircuitState, cat: ErrorCategory | null, t = Date.now()): void {
  const isFailure = cat !== null && !isClientCanceledCategory(cat) && cat !== "GLOBAL_UNAVAILABLE";
  if (c.windowStart === 0 || t - c.windowStart > 30_000) {
    c.windowStart = t;
    c.total = 0;
    c.failures = 0;
  }
  c.total++;
  if (isFailure) c.failures++;
  if (c.total >= 10 && c.failures * 2 >= c.total) {
    c.openUntil = t + 30_000;
  }
  if (c.total > 1000) {
    c.windowStart = t;
    c.total = 1;
    c.failures = isFailure ? 1 : 0;
  }
}
