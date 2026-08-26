import { describe, it, expect } from "vitest";
import { createTextHoldback } from "../src/api/holdback";

describe("createTextHoldback", () => {
  it("passes text through when no tools declared, holding the last ~8 runes", () => {
    const h = createTextHoldback(false);
    const out: string[] = [];
    h.push("Hello ", (t) => out.push(t)); // 6 runes <= 8 -> fully held
    expect(out).toEqual([]);
    h.push("brave world", (t) => out.push(t));
    const flushed = out.join("");
    // Everything except the trailing 8 runes was released.
    expect(flushed.length).toBeGreaterThan(0);
    expect("Hello brave world".startsWith(flushed)).toBe(true);
    h.flush((t) => out.push(t));
    expect(out.join("")).toBe("Hello brave world");
  });

  it("withholds everything once a bash fence opener appears", () => {
    const h = createTextHoldback(true);
    const out: string[] = [];
    h.push('Running ```bash\n{"command"', (t) => out.push(t));
    // fence prefix may have been emitted up to the ``` boundary
    const joined = out.join("");
    expect(joined.includes("```bash")).toBe(false);
    h.push(':"ls"}\n```', (t) => out.push(t));
    expect(out.join("").includes('"ls"')).toBe(false);
    // buffered() still holds the withheld tail until flush().
    expect(h.buffered().includes('"ls"')).toBe(true);
    h.flush(() => {}); // detection phase decides; flush empties the buffer
    expect(h.buffered()).toBe("");
    expect(h.totalText()).toContain("ls");
  });

  it("emits prefix before a non-bash fence and keeps the rest pending", () => {
    const h = createTextHoldback(true);
    const out: string[] = [];
    h.push("answer```json\n{}", (t) => out.push(t));
    expect(out.join("")).toBe("answer");
    expect(h.buffered()).toBe("```json\n{}");
  });

  it("totalText accumulates across pushes regardless of emission", () => {
    const h = createTextHoldback(true);
    h.push("abc", () => {});
    h.push("def", () => {});
    expect(h.totalText()).toBe("abcdef");
  });

  it("never splits surrogate pairs at the holdback boundary", () => {
    const h = createTextHoldback(false);
    const out: string[] = [];
    const emoji = "😀".repeat(10); // 20 UTF-16 units, 10 runes
    h.push(emoji, (t) => out.push(t));
    for (const chunk of out) {
      // every emitted chunk must be valid unicode (no lone surrogates)
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
      expect([...chunk].length).toBeGreaterThan(0);
    }
    h.flush((t) => out.push(t));
    expect(out.join("")).toBe(emoji);
  });
});
