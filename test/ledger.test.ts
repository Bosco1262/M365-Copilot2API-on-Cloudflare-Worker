import { describe, it, expect } from "vitest";
import {
  buildAgentLedger,
  compactResult,
  completionEvidenceAllows,
  ledgerCanContinue,
  ledgerRouterContext,
  COMPLETION_DISCLAIMER,
  type EvidenceLedger,
} from "../src/pipeline/ledger";
import type { OaiMsg } from "../src/pipeline/prompt";

function toolTurn(id: string, name: string, args: Record<string, unknown>): OaiMsg[] {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    { role: "tool", tool_call_id: id, content: `done: ${name} ok` },
  ];
}

const EMPTY: EvidenceLedger = { completed: [], pending: [], repeated: [], rounds: 0 };

describe("buildAgentLedger", () => {
  it("rebuilds completed calls by backfilling role=tool results", () => {
    const msgs: OaiMsg[] = [
      { role: "user", content: "run ls" },
      ...toolTurn("t1", "bash", { command: "ls" }),
    ];
    const l = buildAgentLedger(msgs);
    expect(l.rounds).toBe(1);
    expect(l.completed).toHaveLength(1);
    expect(l.completed[0].name).toBe("bash");
    expect(JSON.parse(l.completed[0].args)).toEqual({ command: "ls" });
    expect(l.completed[0].result).toContain("ok");
    expect(l.pending).toHaveLength(0);
    expect(ledgerCanContinue(l, 512).ok).toBe(true);
  });

  it("marks unmatched tool_calls as pending", () => {
    const msgs: OaiMsg[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "p1", type: "function", function: { name: "bash", arguments: '{"command":"x"}' } }],
      },
    ];
    const l = buildAgentLedger(msgs);
    expect(l.pending).toHaveLength(1);
    expect(l.pending[0].name).toBe("bash");
    expect(completionEvidenceAllows("all done", l)).toBe(false);
  });

  it("compacts long results to head limit/3 + tail limit-head-80", () => {
    // Failure marker inside the retained tail; the middle is genuinely cut.
    const long = "a".repeat(5000) + "b".repeat(5000) + "\nError: exit code 1\n" + "z".repeat(2400);
    const compact = compactResult(long);
    expect(compact.length).toBeLessThanOrEqual(4000);
    expect(compact.startsWith("a")).toBe(true);
    expect(compact.endsWith("z")).toBe(true);
    expect(compact).toContain("[truncated");

    const msgs: OaiMsg[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c", content: long },
    ];
    const l = buildAgentLedger(msgs);
    expect(l.completed[0].failed).toBe(true); // failure regex sees the tail
  });
});

describe("signature counting", () => {
  it("flags RepeatedCall at >=2 and StuckLoop at >=3 identical calls", () => {
    const two: OaiMsg[] = [
      ...toolTurn("a", "read_file", { path: "/x" }),
      ...toolTurn("b", "read_file", { path: "/x" }),
    ];
    const l2 = buildAgentLedger(two);
    expect(l2.repeated).toHaveLength(1);
    expect(l2.repeated[0].status).toBe("RepeatedCall");
    expect(ledgerCanContinue(l2, 512).ok).toBe(true);

    const three: OaiMsg[] = [...two, ...toolTurn("c", "read_file", { path: "/x" })];
    const l3 = buildAgentLedger(three);
    expect(l3.repeated[0].status).toBe("StuckLoop");
    const cont = ledgerCanContinue(l3, 512);
    expect(cont.ok).toBe(false);
    expect(cont.reason).toContain("stuck loop");
  });

  it("normalises whitespace/key order in arguments before counting", () => {
    const msgs: OaiMsg[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "1", type: "function", function: { name: "j", arguments: ' { "b":1, "a":2 }' } }],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "2", type: "function", function: { name: "j", arguments: '{"a":2,"b":1}' } }],
      },
    ];
    const l = buildAgentLedger(msgs);
    expect(l.repeated).toHaveLength(1);
    expect(l.repeated[0].count).toBe(2);
  });

  it("flags RepeatedFailure at >=2 and StuckLoop at >=3 identical failures", () => {
    const failTurn = (id: string): OaiMsg[] => [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "bash", arguments: '{"command":"bad 42"}' } }],
      },
      { role: "tool", tool_call_id: id, content: "Error: permission denied on attempt 7" },
    ];
    const l2 = buildAgentLedger([...failTurn("f1"), ...failTurn("f2")]);
    expect(l2.repeated[0].failureStatus).toBe("RepeatedFailure");
    const cont2 = ledgerCanContinue(l2, 512);
    expect(cont2.ok).toBe(false);
    expect(cont2.reason).toContain("repeated failure");

    const l3 = buildAgentLedger([...failTurn("g1"), ...failTurn("g2"), ...failTurn("g3")]);
    const cont3 = ledgerCanContinue(l3, 512);
    expect(cont3.ok).toBe(false);
    expect(cont3.reason).toContain("stuck loop");
  });
});

describe("ledgerCanContinue ordering", () => {
  it("reports round exhaustion first", () => {
    const l: EvidenceLedger = {
      ...EMPTY,
      rounds: 8,
      repeated: [{ name: "x", args: "{}", count: 5, status: "StuckLoop", failures: 4, failureStatus: "StuckLoop" }],
      pending: [{ name: "y", args: "{}" }],
    };
    expect(ledgerCanContinue(l, 8).reason).toContain("round limit");
  });

  it("reports stuck loop before repeated failure before pending", () => {
    const mixed: EvidenceLedger = {
      ...EMPTY,
      repeated: [{ name: "x", args: "{}", count: 2, status: "RepeatedCall", failures: 2, failureStatus: "RepeatedFailure" }],
      pending: [{ name: "y", args: "{}" }],
    };
    expect(ledgerCanContinue(mixed, 512).reason).toContain("repeated failure");

    const onlyPending: EvidenceLedger = { ...mixed, repeated: [] };
    const r = ledgerCanContinue(onlyPending, 512);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("pending tool call(s)");
  });
});

describe("ledgerRouterContext", () => {
  it("injects the evidence rules and ledger JSON when history exists", () => {
    const msgs: OaiMsg[] = [...toolTurn("t1", "bash", { command: "ls" })];
    const ctxBlock = ledgerRouterContext(buildAgentLedger(msgs));
    expect(ctxBlock).toContain("A completed call is final evidence");
    expect(ctxBlock).toContain("EVIDENCE_LEDGER:");
    expect(ctxBlock).toContain('"completed"');
    expect(ctxBlock).toContain('"pending"');
    expect(ctxBlock).toContain('"repeated"');
    expect(ctxBlock).toContain("FINAL ANSWER RULE:");
  });

  it("is empty for conversations without tool history", () => {
    expect(ledgerRouterContext(EMPTY)).toBe("");
    expect(ledgerRouterContext(buildAgentLedger([{ role: "user", content: "hi" }]))).toBe("");
  });
});

describe("completionEvidenceAllows", () => {
  it("rejects success verbs with no tool records at all", () => {
    const noTools = buildAgentLedger([{ role: "user", content: "install it" }]);
    expect(noTools.completed).toHaveLength(0);
    expect(completionEvidenceAllows("I have installed everything successfully.", noTools)).toBe(false);
    expect(completionEvidenceAllows("Here is a poem about autumn rain.", noTools)).toBe(true);
  });

  it("rejects disclaiming answers when completed evidence exists", () => {
    const l = buildAgentLedger([...toolTurn("t1", "bash", { command: "ls" })]);
    expect(completionEvidenceAllows("I cannot confirm whether that worked.", l)).toBe(false);
    expect(completionEvidenceAllows("The file lists three items.", l)).toBe(true);
  });
});

describe("COMPLETION_DISCLAIMER", () => {
  it("is a non-empty fixed replacement body", () => {
    expect(COMPLETION_DISCLAIMER.length).toBeGreaterThan(40);
    expect(COMPLETION_DISCLAIMER).toContain("could not be verified");
  });
});

describe("ledgerRouterContext size budget", () => {
  it("returns empty for ledgers without history", () => {
    expect(ledgerRouterContext(EMPTY)).toBe("");
  });

  it("caps the serialized ledger on long agent sessions", () => {
    const big = "x".repeat(4000);
    const msgs: OaiMsg[] = [{ role: "user", content: "go" }];
    for (let i = 0; i < 40; i++) {
      msgs.push(...toolTurn(`t${i}`, "bash", { command: `cmd ${i}` }));
      // Backfill with a huge result to inflate the ledger.
      msgs[msgs.length - 1] = { role: "tool", tool_call_id: `t${i}`, content: big };
    }
    const l = buildAgentLedger(msgs);
    const ctx = ledgerRouterContext(l);
    expect(ctx).toContain("EVIDENCE_LEDGER:");
    expect(ctx.length).toBeLessThan(20_000); // budget 16k + rules text
    // Oldest completed entries are dropped first until under budget.
    expect(ctx).toContain("cmd 39");
    expect(ctx).not.toContain("cmd 0");
  });
});
