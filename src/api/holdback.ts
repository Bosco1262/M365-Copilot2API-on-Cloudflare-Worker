// Shared streaming text-holdback used by the OpenAI and Anthropic stream
// adapters: text that looks like the start of a fenced tool call is withheld
// from emission until the stream completes and tool detection runs. Mirrors
// the pending-buffer behaviour of server.go's streaming branch.

export interface TextHoldback {
  /** Feed one upstream delta; emits the safe-to-send prefix via callback. */
  push(part: string, emit: (text: string) => void): void;
  /** Emit whatever is still withheld (when no tool call materialised). */
  flush(emit: (text: string) => void): void;
  /** Full accumulated text (emitted + withheld). */
  totalText(): string;
  /** Currently withheld tail. */
  buffered(): string;
}

// Mirrors upstream: server.go's streaming branch replaced the old 8-rune
// threshold with a 3-rune buffer (enough to detect "```") to cut tail latency.
const RUNE_HOLDBACK = 3;

export function createTextHoldback(hasTools: boolean): TextHoldback {
  let total = "";
  let pending = "";

  return {
    push(part, emit) {
      if (part === "") return;
      total += part;
      pending += part;
      const v = pending;
      if (hasTools && (v.includes("```bash") || v.includes('"command"'))) {
        return; // likely a tool call — withhold entirely
      }
      const fenceIdx = hasTools ? v.indexOf("```") : -1;
      if (fenceIdx >= 0) {
        emit(v.slice(0, fenceIdx));
        pending = v.slice(fenceIdx);
        return;
      }
      // Hold back the last few runes: a fence opener split across deltas
      // must not leak into the visible stream.
      const runes = [...v];
      if (runes.length > RUNE_HOLDBACK) {
        const cut = runes.slice(0, runes.length - RUNE_HOLDBACK).join("").length;
        emit(v.slice(0, cut));
        pending = v.slice(cut);
      }
    },
    flush(emit) {
      if (pending !== "") {
        emit(pending);
        pending = "";
      }
    },
    totalText() {
      return total;
    },
    buffered() {
      return pending;
    },
  };
}
