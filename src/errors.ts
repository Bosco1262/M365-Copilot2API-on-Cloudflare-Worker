// Upstream error taxonomy (port of internal/web/account_health.go error helpers
// plus chathub DialError / ErrRateLimitNotice / ErrEmptyCompletion).

export class UpstreamHTTPError extends Error {
  status: number;
  retryAfter: number;
  body: string;
  constructor(status: number, retryAfter = 0, body = "") {
    super(`upstream http ${status}`);
    this.name = "UpstreamHTTPError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.body = body;
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
