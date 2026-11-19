import { describe, expect, test } from "bun:test";
import { advance as productionAdvance, failureEvidence, healthCacheKey, type StoredState } from "../../src/provider/state.ts";

import { scope, packet, transcript, chatOf, accepted } from "./handoff-fixture.ts";

function advance(prev: StoredState | undefined, body: unknown, mode: "direct" | "plan_then_execute" | "strong_only", now?: number, health?: string) {
  return productionAdvance(prev, body, mode, now, health, scope);
}
function handoffBody(ref = "plan-1", version = 1, revision = 1, ...extra: unknown[]) {
  return { messages: [...chatOf(transcript(packet({ planRef: ref, stateVersion: version, planRevision: revision }))), ...extra] };
}
function active(overrides: Partial<StoredState> = {}): StoredState {
  return state({ handoff: accepted(), ...overrides });
}

function user(text: string) {
  return { role: "user", content: text };
}

function plan(ref: string) {
  return { role: "assistant", content: `prewalk plan:${ref}\n1. do it` };
}

let seq = 0;
function write(name = "Edit", ok = true) {
  const id = `t${++seq}`;
  return [
    { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, content: ok ? "ok" : "Error: failed" },
  ];
}

function writeContent(content: unknown, name = "Edit") {
  const id = `t${++seq}`;
  return [
    { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, content },
  ];
}

function body(...messages: unknown[]) {
  return { messages: [user("task"), ...messages] };
}

function state(overrides: Partial<StoredState>): StoredState {
  return {
    phase: "executing",
    mode: "plan_then_execute",
    planRef: "plan-1",
    planRevision: 1,
    replanCount: 0,
    stateVersion: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("provider phase state machine", () => {
  test("new plan_then_execute session starts on the planner", () => {
    const out = advance(undefined, body(), "plan_then_execute");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("planning");
    expect(out.state.mode).toBe("plan_then_execute");
    expect(out.reason).toBe("plan_pending");
    expect(out.changed).toBe(true);
  });

  test("a business Edit and short plan cannot authorize provider handoff", () => {
    const previous = state({ phase: "planning", planRef: "", planRevision: 0 });
    const out = advance(previous, body(plan("plan-2"), ...write()), "plan_then_execute");
    expect(out.target).toBe("planner");
    expect(out.state).toEqual(previous);
    expect(out.changed).toBe(false);
  });

  test("an evidence-backed successful package Write hands off to the executor", () => {
    const out = advance(state({ phase: "planning", planRef: "", planRevision: 0 }), handoffBody("plan-2"), "plan_then_execute");
    expect(out.target).toBe("executor");
    expect(out.state.phase).toBe("executing");
    expect(out.state.planRef).toBe("plan-2");
    expect(out.state.planRevision).toBe(1);
  });

  test("a plan without a real write keeps the planner", () => {
    const out = advance(state({ phase: "planning", planRef: "", planRevision: 0 }), body(plan("plan-2")), "plan_then_execute");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("planning");
    expect(out.changed).toBe(false);
  });

  test("executing without failures stays on the executor", () => {
    const out = advance(active(), handoffBody("plan-1", 1, 1, ...write()), "plan_then_execute");
    expect(out.target).toBe("executor");
    expect(out.state.phase).toBe("executing");
  });

  test("a failed tool group replans and spends one budget", () => {
    const out = advance(active(), handoffBody("plan-1", 1, 1, ...write("Edit", false)), "plan_then_execute");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("replanning");
    expect(out.state.replanCount).toBe(1);
    expect(out.reason).toBe("replan");
  });

  test("the third failure blocks at the replan limit", () => {
    const out = advance(active({ replanCount: 2, stateVersion: 3 }), handoffBody("plan-1", 1, 1, ...write("Edit", false)), "plan_then_execute");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("blocked");
    expect(out.state.replanCount).toBe(2);
    expect(out.reason).toBe("replan_limit");
  });

  test("replanning requires a different new plan and a real write", () => {
    const same = advance(state({ phase: "replanning", replanCount: 1 }), body(plan("plan-1"), ...write()), "plan_then_execute");
    expect(same.target).toBe("planner");
    expect(same.state.phase).toBe("replanning");

    const out = advance(state({ phase: "replanning", replanCount: 1 }), handoffBody("plan-3", 1, 2), "plan_then_execute");
    expect(out.target).toBe("executor");
    expect(out.state.phase).toBe("executing");
    expect(out.state.planRevision).toBe(2);
    expect(out.state.replanCount).toBe(1);
  });

  test("direct mode starts and stays on the executor", () => {
    const first = advance(undefined, body(), "direct");
    expect(first.target).toBe("executor");
    expect(first.state.mode).toBe("direct");
    const next = advance(first.state, body(...write()), "direct");
    expect(next.target).toBe("executor");
  });

  test("strong_only is sticky on the planner even after a real write", () => {
    const first = advance(undefined, body(), "strong_only");
    expect(first.target).toBe("planner");
    expect(first.state.phase).toBe("strong_only");
    const next = advance(first.state, body(plan("plan-9"), ...write()), "strong_only");
    expect(next.target).toBe("planner");
    expect(next.state.phase).toBe("strong_only");
  });

  test("blocked never hands back to the executor", () => {
    const out = advance(state({ phase: "blocked" }), body(plan("plan-9"), ...write()), "plan_then_execute");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("blocked");
  });

  test("an incomplete tool group keeps the planner", () => {
    const messages = [
      plan("plan-2"),
      { role: "assistant", tool_calls: [{ id: "t-missing", type: "function", function: { name: "Edit", arguments: "{}" } }] },
    ];
    const out = advance(state({ phase: "planning", planRef: "", planRevision: 0 }), body(...messages), "plan_then_execute");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("planning");
    expect(out.reason).toBe("history_unknown");
  });

  test("malformed bodies fail closed to the planner", () => {
    for (const bad of [null, {}, { messages: "no" }, { messages: [42] }]) {
      const out = advance(undefined, bad, "plan_then_execute");
      expect(out.target).toBe("planner");
      expect(out.reason).toBe("policy_unavailable");
      expect(out.changed).toBe(false);
    }
  });

  test("a write before the plan cannot authorize handoff", () => {
    const out = advance(state({ phase: "planning", planRef: "", planRevision: 0 }), body(...write(), plan("plan-2")), "plan_then_execute");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("planning");
  });

  test("a noncanonical marker plus a business edit cannot prove a package", () => {
    const longPlan = { role: "assistant", content: "x".repeat(40) + " prewalk plan:plan-2\n1. do it" };
    const out = advance(state({ phase: "planning", planRef: "", planRevision: 0 }), body(longPlan, ...write()), "plan_then_execute");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("planning");
  });

  test("duplicate or missing tool ids cannot fake a complete group", () => {
    const duplicate = body(plan("plan-2"),
      { role: "assistant", tool_calls: [
        { id: "same", type: "function", function: { name: "Edit", arguments: "{}" } },
        { id: "same", type: "function", function: { name: "Edit", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "same", content: "ok" });
    const missing = body(plan("plan-2"),
      { role: "assistant", tool_calls: [{ type: "function", function: { name: "Edit", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "", content: "ok" });
    for (const bad of [duplicate, missing]) {
      const out = advance(state({ phase: "planning", planRef: "", planRevision: 0 }), bad, "plan_then_execute");
      expect(out.target).toBe("planner");
      expect(out.state.phase).toBe("planning");
    }
  });

  test("structured error content replans instead of authorizing handoff", () => {
    const failed = advance(active(), handoffBody("plan-1", 1, 1, ...writeContent({ error: "permission denied" })), "plan_then_execute");
    expect(failed.target).toBe("planner");
    expect(failed.state.phase).toBe("replanning");
    const planning = advance(state({ phase: "planning", planRef: "", planRevision: 0 }), body(plan("plan-2"), ...writeContent({ is_error: true })), "plan_then_execute");
    expect(planning.target).toBe("planner");
    expect(planning.state.phase).toBe("planning");
  });

  test("an old failure does not spend the budget again after a new plan", () => {
    const out = advance(active({ planRef: "plan-2", replanCount: 1, handoff: accepted(packet({ planRef: "plan-2" })) }), { messages: [user("task"), plan("plan-1"), ...write("Edit", false), ...chatOf(transcript(packet({ planRef: "plan-2" }))).slice(1)] }, "plan_then_execute");
    expect(out.target).toBe("executor");
    expect(out.state.phase).toBe("executing");
    expect(out.state.replanCount).toBe(1);
  });

  test("direct mode failures still replan", () => {
    const out = advance(state({ mode: "direct", planRef: "" }), body(...write("Edit", false)), "direct");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("replanning");
  });

  test("system messages do not block a new session", () => {
    const out = advance(undefined, { messages: [{ role: "system", content: "rules" }, { role: "user", content: "task" }] }, "plan_then_execute");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("planning");
    expect(out.changed).toBe(true);
  });

  test("failureEvidence excludes failures before the latest plan", () => {
    const oldFailure = write("Edit", false);
    expect(failureEvidence(body(plan("plan-1"), ...oldFailure, plan("plan-2"), ...write()))).toEqual([]);
  });

  test("failureEvidence does not silently discard the ninth failure", () => {
    const failures = Array.from({ length: 9 }, () => write("Edit", false)).flat();
    expect(failureEvidence(body(plan("plan-1"), ...failures)).length).toBe(9);
  });

  test("health cache key separates session, state version, planner, evidence and body", () => {
    const base = healthCacheKey("s1", 2, "real/planner", ["group:g"], "d1");
    expect(healthCacheKey("s1", 2, "real/planner", ["group:g"], "d1")).toBe(base);
    expect(healthCacheKey("s2", 2, "real/planner", ["group:g"], "d1")).not.toBe(base);
    expect(healthCacheKey("s1", 3, "real/planner", ["group:g"], "d1")).not.toBe(base);
    expect(healthCacheKey("s1", 2, "real/other", ["group:g"], "d1")).not.toBe(base);
    expect(healthCacheKey("s1", 2, "real/planner", ["group:h"], "d1")).not.toBe(base);
    expect(healthCacheKey("s1", 2, "real/planner", ["group:g"], "d2")).not.toBe(base);
  });

  test("failureEvidence names only failed or incomplete groups", () => {
    const refs = failureEvidence(body(plan("plan-1"), ...write("Edit", false)));
    expect(refs.length).toBe(1);
    expect(refs[0]).toMatch(/^group:group:t/);
    expect(failureEvidence(body(plan("plan-1"), ...write()))).toEqual([]);
  });

  test("JSON string tool errors are not treated as successful observations", () => {
    const previous = active();
    const raw = handoffBody("plan-1", 1, 1,
      ...writeContent('{"error":"permission denied"}'));
    const out = advance(previous, raw, "plan_then_execute");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("replanning");
  });

  test("translated command failures and tool error envelopes remain failures without is_error", () => {
    for (const content of ["Exit code 1\nassertion failed", "Exit code 137\nkilled", "Exit code -1\nterminated", "  Exit code 2\r\nfailed test", "<tool_use_error>No changes to make</tool_use_error>"]) {
      const tool = content.startsWith("<tool_use_error>") ? "Edit" : "Bash";
      const transcript = handoffBody("plan-1", 1, 1, ...writeContent(content, tool));
      const refs = failureEvidence(transcript);
      expect(refs.length).toBe(1);
      expect(refs[0]).toMatch(/^group:group:t/);
      const next = advance(active(), transcript, "plan_then_execute", 2, "replan");
      expect(next.target).toBe("planner");
      expect(next.state.phase).toBe("replanning");
      expect(next.state.replanCount).toBe(1);
    }
  });

  test("successful file and search results are not interpreted as command exit status", () => {
    for (const name of ["Read", "Grep", "Glob"]) {
      const transcript = handoffBody("plan-1", 1, 1, ...writeContent("Exit code 1\n表示命令失败", name));
      expect(failureEvidence(transcript)).toEqual([]);
      const next = advance(active(), transcript, "plan_then_execute", 2);
      expect(next.target).toBe("executor");
      expect(next.state.replanCount).toBe(0);
    }
  });

  test("zero command status and ordinary mentions do not invent a failure", () => {
    for (const content of ["Exit code 0\nall tests passed", "Exit code 00\nall tests passed", "The docs mention Exit code 1 as an example", "Exit code 1 is an example, not a command status", "Exit code 10 files scanned", "exit code 1\nquoted ordinary output", "<tool_use_errorish>not an envelope</tool_use_errorish>"]) {
      const transcript = handoffBody("plan-1", 1, 1, ...writeContent(content, "Bash"));
      expect(failureEvidence(transcript)).toEqual([]);
      const next = advance(active(), transcript, "plan_then_execute", 2);
      expect(next.target).toBe("executor");
      expect(next.state.replanCount).toBe(0);
    }
  });

  test("a continue verdict keeps the executor", () => {
    const out = advance(active(), handoffBody("plan-1", 1, 1, ...write("Edit", false)), "plan_then_execute", Date.now(), "continue");
    expect(out.target).toBe("executor");
    expect(out.state.phase).toBe("executing");
    expect(out.state.replanCount).toBe(0);
  });

  test("an external_block verdict blocks the session", () => {
    const out = advance(active(), handoffBody("plan-1", 1, 1, ...write("Edit", false)), "plan_then_execute", Date.now(), "external_block");
    expect(out.target).toBe("planner");
    expect(out.state.phase).toBe("blocked");
  });

  test("replan and uncertain verdicts replan", () => {
    for (const verdict of ["replan", "uncertain"]) {
      const out = advance(active(), handoffBody("plan-1", 1, 1, ...write("Edit", false)), "plan_then_execute", Date.now(), verdict);
      expect(out.target).toBe("planner");
      expect(out.state.phase).toBe("replanning");
      expect(out.state.replanCount).toBe(1);
    }
  });
});
