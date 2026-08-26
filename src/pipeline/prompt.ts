// Prompt flattening (port of internal/web/prompt.go + multimodal.go).
// Image parts become real attachments (data URL / https URL); file and audio
// parts degrade to bracketed text placeholders.

import type { Attachment } from "../chathub/protocol";
import { estimateTokens } from "../util";

export interface OaiMsg {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Record<string, unknown>[];
  reasoning_content?: string;
}

interface ContentPart {
  text: string;
  attachments: Attachment[];
}

function stringValue(m: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = m[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

// Port of parseContent: extracts text plus image attachments.
function parseContent(c: unknown): ContentPart {
  if (typeof c === "string") return { text: c, attachments: [] };
  if (c === null || c === undefined) return { text: "", attachments: [] };
  if (!Array.isArray(c)) return { text: String(c), attachments: [] };
  let text = "";
  const attachments: Attachment[] = [];
  for (const raw of c) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const typ = typeof m["type"] === "string" ? m["type"] : "";
    if (typeof m["text"] === "string" && ["text", "input_text", "output_text", ""].includes(typ)) {
      text += m["text"];
    }
    let url = "";
    switch (typ) {
      case "text":
      case "input_text":
      case "output_text":
        break;
      case "image_url": {
        const iu = m["image_url"];
        if (typeof iu === "string") url = iu;
        else if (iu && typeof iu === "object") url = stringValue(iu as Record<string, unknown>, ["url"]);
        break;
      }
      case "input_image":
      case "image": {
        url = stringValue(m, ["image_url", "url"]);
        const src = m["source"];
        if (!url && src && typeof src === "object") url = stringValue(src as Record<string, unknown>, ["url", "data", "source"]);
        const raw2 = m["image_url"];
        if (!url && raw2 && typeof raw2 === "object") {
          url = stringValue(raw2 as Record<string, unknown>, ["url", "data", "image_url"]);
        }
        break;
      }
      case "input_file":
      case "file":
        // Non-image uploads are not supported by UploadFile; degrade to text.
        text += `[file:${stringValue(m, ["file_data", "file_url", "url", "source", "file_id"]) || "attachment"}]`;
        break;
      case "input_audio":
      case "audio":
        text += `[audio:${stringValue(m, ["data", "audio_url", "url", "source"]) || "attachment"}]`;
        break;
      default:
        break;
    }
    if (url !== "") {
      attachments.push({ type: "image", url, mimeType: "image/*" });
    }
  }
  return { text, attachments };
}

function compactToolResult(txt: string, maxLen: number): string {
  // Simplified port: truncate long tool results keeping head and tail.
  if (txt.length <= maxLen) return txt;
  const half = Math.floor(maxLen / 2);
  return `${txt.slice(0, half)}\n...[truncated ${txt.length - maxLen} chars]...\n${txt.slice(-half)}`;
}

// Port of flattenPromptMessages. Returns the flattened prompt plus collected
// image attachments (uploaded to M365 before the chat payload is sent).
export async function flattenPromptMessages(
  messages: OaiMsg[],
  attachments: Attachment[] = []
): Promise<{ prompt: string; attachments: Attachment[] }> {
  const systemParts: string[] = [];
  const rest: OaiMsg[] = [];
  for (const m of messages ?? []) {
    const role = (m.role ?? "").trim().toLowerCase();
    if (role === "system" || role === "developer") {
      const parsed = parseContent(m.content);
      attachments.push(...parsed.attachments);
      const txt = parsed.text.trim();
      if (txt !== "") systemParts.push(txt);
    } else {
      rest.push(m);
    }
  }
  let out = "";
  if (systemParts.length > 0) {
    out += `\n[system]\n${systemParts.join("\n")}\n`;
  }
  for (const m of rest) {
    let role = (m.role ?? "").trim().toLowerCase();
    if (role === "") role = "user";
    let content = m.content;
    if (role === "tool" && content != null && typeof content !== "string") {
      content = JSON.stringify(content);
    }
    const parsed = parseContent(content);
    attachments.push(...parsed.attachments);
    let txt = parsed.text.trim();
    if (m.tool_calls && m.tool_calls.length > 0) {
      if (txt !== "") out += `\n[${role}]\n${txt}\n`;
      out += `\n[${role} tool_calls]\n${JSON.stringify(m.tool_calls)}\n`;
      continue;
    }
    if (role === "tool") {
      txt = compactToolResult(txt, 4000);
      out += `\n[tool result id=${m.tool_call_id ?? ""}]\n${txt}\n`;
      continue;
    }
    if (txt === "" && parsed.attachments.length === 0) continue;
    out += `\n[${role}]\n${txt}\n`;
  }
  return { prompt: out.trim(), attachments };
}

// Port of contentToString (used for token estimation).
export function contentToString(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return c == null ? "" : String(c);
  let b = "";
  for (const part of c) {
    if (!part || typeof part !== "object") continue;
    const m = part as Record<string, unknown>;
    const t = typeof m["type"] === "string" ? m["type"] : "";
    if (["text", "input_text", "output_text"].includes(t)) {
      const s = m["text"];
      if (typeof s === "string" && s !== "") b += s;
    } else if (t === "image_url" || t === "input_image" || t === "image") {
      b += "[image]";
    } else if (t === "input_file" || t === "file") {
      b += "[file]";
    } else if (t === "input_audio" || t === "audio") {
      b += "[audio]";
    }
  }
  return b;
}

export function estimateMessagesTokens(messages: OaiMsg[]): number {
  let total = 0;
  for (let i = 0; i < messages.length - 1; i++) {
    total += estimateTokens(contentToString(messages[i].content));
  }
  return total;
}

// Port of normalizeJSONText.
export function normalizeJSONText(s: string): string {
  s = s.trim();
  if (s.startsWith("```")) {
    const i = s.indexOf("\n");
    if (i >= 0) s = s.slice(i + 1);
    if (s.endsWith("```")) s = s.slice(0, -3).trim();
  }
  return s;
}
