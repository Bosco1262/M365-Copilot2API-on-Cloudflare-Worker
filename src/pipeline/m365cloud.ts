// M365 cloud conversation management (port of internal/web/m365cloud.go).

import type { Env } from "../env";
import { oauthConfig } from "../env";

export class M365CloudClient {
  private clientId: string;
  private tenantID: string;
  private refreshToken: string;
  private accessToken = "";
  private expiresAtMs = 0;

  constructor(clientId: string, tenantID: string, refreshToken: string) {
    this.clientId = clientId;
    this.tenantID = tenantID;
    this.refreshToken = refreshToken;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAtMs - 2 * 60_000) {
      return this.accessToken;
    }
    const form = new URLSearchParams();
    form.set("client_id", this.clientId);
    form.set("refresh_token", this.refreshToken);
    form.set("grant_type", "refresh_token");
    form.set("scope", "https://m365.cloud.microsoft/v2/.default");
    const resp = await fetch(
      `https://login.microsoftonline.com/${this.tenantID}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }
    );
    const bodyText = await resp.text();
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(bodyText);
    } catch {
      throw new Error("parse token response: invalid json");
    }
    if (result["error"]) {
      throw new Error(`token error: ${result["error"]} - ${result["error_description"] ?? ""}`);
    }
    const token = result["access_token"] as string | undefined;
    if (!token) throw new Error("token error: empty access token");
    this.accessToken = token;
    this.expiresAtMs = Date.now() + ((result["expires_in"] as number) ?? 3600) * 1000;
    if (typeof result["refresh_token"] === "string" && result["refresh_token"] !== "") {
      this.refreshToken = result["refresh_token"];
    }
    return token;
  }

  private async doAPI(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();
    const reqBody: Record<string, unknown> = { action, state: payload };
    for (const [k, v] of Object.entries(payload)) {
      if (k !== "state") reqBody[k] = v;
    }
    const resp = await fetch("https://m365.cloud.microsoft/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0",
        Origin: "https://m365.cloud.microsoft",
        Referer: "https://m365.cloud.microsoft/",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify(reqBody),
    });
    if (resp.status < 200 || resp.status >= 300) {
      const retryAfter = Number(resp.headers.get("Retry-After") ?? 0) || 0;
      let snippet = "";
      try {
        snippet = (await resp.text()).slice(0, 512);
      } catch {
        /* ignore */
      }
      const err = new Error(`upstream http ${resp.status}`) as Error & {
        name: string;
        status: number;
        retryAfter: number;
        body: string;
      };
      err.name = "UpstreamHTTPError";
      err.status = resp.status;
      err.retryAfter = retryAfter;
      err.body = snippet;
      throw err;
    }
    const ct = resp.headers.get("Content-Type") ?? "";
    if (ct !== "" && !ct.startsWith("application/json")) {
      throw new Error(`unexpected content type from m365 endpoint: ${ct}`);
    }
    return (await resp.json()) as Record<string, unknown>;
  }

  async deleteConversation(conversationID: string): Promise<void> {
    await this.doAPI("DeleteConversation", {
      conversationId: conversationID,
      state: { conversationPageHistoryList: { chats: [] } },
    });
  }

  async listConversations(): Promise<Record<string, unknown>[]> {
    const result = await this.doAPI("RefreshNavPane", {});
    const store = result["store"];
    if (!store || typeof store !== "object") {
      throw new Error("unexpected response format");
    }
    const historyList = (store as Record<string, unknown>)["conversationPageHistoryList"];
    if (!historyList || typeof historyList !== "object") {
      return [];
    }
    const chatsRaw = (historyList as Record<string, unknown>)["chats"];
    if (!Array.isArray(chatsRaw)) {
      throw new Error("no chats");
    }
    const chats: Record<string, unknown>[] = [];
    for (const raw of chatsRaw) {
      if (typeof raw === "string") {
        try {
          chats.push(JSON.parse(raw));
        } catch {
          continue;
        }
      } else if (raw && typeof raw === "object") {
        chats.push(raw as Record<string, unknown>);
      }
    }
    return chats;
  }
}

// Build a client bound to the first account (port of InitM365CloudClient).
export async function firstAccountCloudClient(env: Env): Promise<M365CloudClient | null> {
  const { listAccounts } = await import("../store/accounts");
  const accounts = await listAccounts(env);
  if (accounts.length === 0) return null;
  const acc = accounts[0];
  const clientId = env.M365_CLIENT_ID?.trim() || acc.clientId || oauthConfig(env).clientId;
  if (!acc.tid || !acc.refreshToken) return null;
  return new M365CloudClient(clientId, acc.tid, acc.refreshToken);
}
