// Shared helpers: hashing, random tokens, JWT claims, token estimation and
// OpenAI-style JSON responses (ports of small utilities scattered across the
// Go codebase).

export function firstNonEmpty(...vals: (string | undefined | null)[]): string {
  for (const v of vals) {
    if (v && v.trim() !== "") return v.trim();
  }
  return "";
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256B64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToB64Url(new Uint8Array(digest));
}

export function bytesToB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomHex(nBytes: number): string {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomB64Url(nBytes: number): string {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return bytesToB64Url(b);
}

export function uuid(): string {
  return crypto.randomUUID();
}

export interface JwtClaims {
  [key: string]: string;
}

export function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const raw = atob(padded);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const m = JSON.parse(json) as Record<string, unknown>;
    const out: JwtClaims = {};
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export function extractOIDTID(accessToken: string): { oid: string; tid: string } {
  const claims = decodeJwtClaims(accessToken);
  if (!claims) return { oid: "", tid: "" };
  return { oid: claims["oid"] ?? "", tid: claims["tid"] ?? "" };
}

// Port of EstimateTokens: runeCount * 2 / 3.
export function estimateTokens(text: string): number {
  let runes = 0;
  for (const _ of text) runes++; // iterates by code point
  return Math.floor((runes * 2) / 3);
}

export async function hashOf(s: string): Promise<string> {
  return sha256Hex(s);
}

export function jsonOut(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data) + "\n", {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function writeOpenAIError(status: number, typ: string, msg: string): Response {
  return jsonOut({ error: { message: msg, type: typ } }, status);
}

export function envTrue(v: string | undefined): boolean {
  switch ((v ?? "").trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
  }
  return false;
}

export function nowIso(): string {
  return new Date().toISOString();
}
