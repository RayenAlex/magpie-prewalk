import { describe, expect, test } from "bun:test";

import { onRoute, type Decision, type Snapshot, type StateView, type ToolGroup } from "../../src/policy";
import { JUDGMENT_TEMPLATE_VERSION, checkAnswer, judgmentRequest } from "../../src/judgment";

// The host's fixed reason set (contracts §3); a decision outside it is
// rejected as route_invalid.
const HOST_REASONS = new Set([
  "plan_pending",
  "handoff_ready",
  "executing",
  "replan",
  "strong_only",
  "task_uncertain",
  "history_unknown",
  "plan_missing",
  "tool_group_incomplete",
  "external_block",
  "replan_limit",
  "state_unavailable",
  "policy_unavailable",
]);

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    contract: "route-v1",
    entry: "group/prewalk",
    state: { status: "missing" },
    history: { status: "ok" },
    ...overrides,
  };
}

function okState(fields: Partial<StateView> = {}): StateView {
  return { status: "ok", phase: "planning", mode: "plan_then_execute", stateVersion: "1", ...fields };
}

function failedGroup(id = "g1", complete = true): ToolGroup {
  return { id, tools: ["Edit"], results: [{ id: "t1", ok: false }], complete, afterPlan: true };
}

function writeGroup(id = "g1", afterPlan = true): ToolGroup {
  return { id, tools: ["Edit"], results: [{ id: "t1", ok: true }], complete: true, afterPlan };
}

function expectReason(decision: Decision): string {
  expect(HOST_REASONS.has(decision.reason)).toBe(true);
  return decision.reason;
}

describe("prewalk policy", () => {
  test("unknown state keeps the strong model", () => {
    const decision = onRoute(snapshot({ state: { status: "unknown" } }));
    expect(decision.action).toBe("keep");
    expect(expectReason(decision)).toBe("state_unavailable");
  });

  test("unknown or incomplete history keeps the strong model", () => {
    for (const status of ["unknown", "incomplete"] as const) {
      const decision = onRoute(snapshot({ history: { status } }));
      expect(decision.action).toBe("keep");
      expect(expectReason(decision)).toBe("history_unknown");
    }
  });

  test("a new task asks for the task_route judgment", () => {
    const decision = onRoute(snapshot());
    expect(decision).toMatchObject({
      action: "judge",
      question: "task_route",
      templateVersion: JUDGMENT_TEMPLATE_VERSION,
    });
  });

  test("judged direct hands off to the executor without a plan", () => {
    const decision = onRoute(
      snapshot({ judgment: { kind: "task_route", verdict: "direct", templateVersion: "1" } }),
    );
    expect(decision).toMatchObject({
      action: "propose",
      targetRole: "executor",
      expectedVersion: 0,
      nextState: { phase: "executing", mode: "direct" },
    });
  });

  test("judged plan_then_execute commits planning", () => {
    const decision = onRoute(
      snapshot({ judgment: { kind: "task_route", verdict: "plan_then_execute", templateVersion: "1" } }),
    );
    expect(decision).toMatchObject({
      action: "propose",
      targetRole: "planner",
      reason: "plan_pending",
      expectedVersion: 0,
      nextState: { phase: "planning", mode: "plan_then_execute" },
    });
  });

  test("judged strong_only is recorded as a sticky mode", () => {
    const decision = onRoute(
      snapshot({ judgment: { kind: "task_route", verdict: "strong_only", templateVersion: "1" } }),
    );
    expect(decision).toMatchObject({
      action: "propose",
      targetRole: "planner",
      nextState: { phase: "strong_only", mode: "strong_only" },
    });
  });

  test("judged uncertain commits strong_only", () => {
    const decision = onRoute(
      snapshot({ judgment: { kind: "task_route", verdict: "uncertain", templateVersion: "1" } }),
    );
    expect(decision).toMatchObject({
      action: "propose",
      targetRole: "planner",
      reason: "task_uncertain",
      expectedVersion: 0,
      nextState: { phase: "strong_only", mode: "strong_only" },
    });
  });

  test("a strong_only task is not argued down again", () => {
    const decision = onRoute(snapshot({ state: okState({ phase: "strong_only", mode: "strong_only" }) }));
    expect(decision).toMatchObject({ action: "keep", reason: "strong_only" });
  });

  test("planning without a visible plan stays strong", () => {
    const decision = onRoute(snapshot({ state: okState({ phase: "planning" }) }));
    expect(decision.action).toBe("keep");
    expect(expectReason(decision)).toBe("plan_missing");
  });

  test("planning ignores a file action from before the plan", () => {
    const decision = onRoute(
      snapshot({ state: okState({ phase: "planning" }), history: { status: "ok", planRef: "plan:7", toolGroups: [writeGroup("g0", false)] } }),
    );
    expect(decision.action).toBe("keep");
    expect(expectReason(decision)).toBe("tool_group_incomplete");
  });

  test("planning with a plan but no successful file action stays strong", () => {
    const decision = onRoute(
      snapshot({ state: okState({ phase: "planning" }), history: { status: "ok", planRef: "plan:7" } }),
    );
    expect(decision.action).toBe("keep");
    expect(expectReason(decision)).toBe("tool_group_incomplete");
  });

  test("planning with a visible plan and a successful file action hands off", () => {
    const decision = onRoute(
      snapshot({ state: okState({ phase: "planning", planRevision: "3" }), history: { status: "ok", planRef: "plan:7", toolGroups: [writeGroup()] } }),
    );
    expect(decision).toMatchObject({
      action: "propose",
      targetRole: "executor",
      expectedVersion: 1,
      nextState: { phase: "executing", planRef: "plan:7", planRevision: 4 },
    });
  });

  test("executing with no failures stays on the executor", () => {
    const decision = onRoute(snapshot({ state: okState({ phase: "executing" }) }));
    expect(decision).toMatchObject({ action: "keep", reason: "executing" });
  });

  test("a partly answered parallel group stays strong", () => {
    const decision = onRoute(
      snapshot({ state: okState({ phase: "executing" }), history: { status: "ok", toolGroups: [failedGroup("g1", false)] } }),
    );
    expect(decision.action).toBe("keep");
    expect(expectReason(decision)).toBe("tool_group_incomplete");
  });

  test("a failed statement asks execution_health with group evidence", () => {
    const decision = onRoute(
      snapshot({ state: okState({ phase: "executing" }), history: { status: "ok", toolGroups: [failedGroup("g1")] } }),
    );
    expect(decision).toMatchObject({ action: "judge", question: "execution_health" });
    if (decision.action === "judge") expect(decision.evidence).toContain("group:g1");
  });

  test("judged continue stays executing", () => {
    const decision = onRoute(
      snapshot({
        state: okState({ phase: "executing" }),
        history: { status: "ok", toolGroups: [failedGroup()] },
        judgment: { kind: "execution_health", verdict: "continue", templateVersion: "1" },
      }),
    );
    expect(decision).toMatchObject({ action: "keep", reason: "executing" });
  });

  test("judged replan counts the first and second replan", () => {
    for (const [used, want] of [["0", 1], ["1", 2]] as const) {
      const decision = onRoute(
        snapshot({
          state: okState({ phase: "executing", replanCount: used }),
          history: { status: "ok", toolGroups: [failedGroup()] },
          judgment: { kind: "execution_health", verdict: "replan", templateVersion: "1" },
        }),
      );
      expect(decision).toMatchObject({
        action: "propose",
        targetRole: "planner",
        nextState: { phase: "replanning", replanCount: want },
      });
    }
  });

  test("a third replan is refused", () => {
    const decision = onRoute(
      snapshot({
        state: okState({ phase: "executing", replanCount: "2" }),
        history: { status: "ok", toolGroups: [failedGroup()] },
        judgment: { kind: "execution_health", verdict: "replan", templateVersion: "1" },
      }),
    );
    expect(decision).toMatchObject({
      action: "propose",
      reason: "replan_limit",
      nextState: { phase: "blocked" },
    });
  });

  test("judged external_block blocks rather than rehanding off", () => {
    const decision = onRoute(
      snapshot({
        state: okState({ phase: "executing" }),
        history: { status: "ok", toolGroups: [failedGroup()] },
        judgment: { kind: "execution_health", verdict: "external_block", templateVersion: "1" },
      }),
    );
    expect(decision).toMatchObject({ action: "propose", reason: "external_block", nextState: { phase: "blocked" } });
  });

  test("replanning ignores the old plan's file action", () => {
    const decision = onRoute(
      snapshot({
        state: okState({ phase: "replanning", planRef: "plan:old" }),
        history: { status: "ok", planRef: "plan:new", toolGroups: [writeGroup("g0", false)] },
      }),
    );
    expect(decision.action).toBe("keep");
    expect(expectReason(decision)).toBe("tool_group_incomplete");
  });

  test("replanning without a successful file action stays strong", () => {
    const decision = onRoute(
      snapshot({
        state: okState({ phase: "replanning", planRef: "plan:old" }),
        history: { status: "ok", planRef: "plan:new" },
      }),
    );
    expect(decision.action).toBe("keep");
    expect(expectReason(decision)).toBe("tool_group_incomplete");
  });

  test("replanning needs a plan that replaces the old one", () => {
    for (const planRef of ["", "plan:old"]) {
      const decision = onRoute(
        snapshot({
          state: okState({ phase: "replanning", planRef: "plan:old" }),
          history: { status: "ok", planRef },
        }),
      );
      expect(decision.action).toBe("keep");
      expect(expectReason(decision)).toBe("plan_missing");
    }
  });

  test("replanning with a new plan and a successful file action hands off", () => {
    const decision = onRoute(
      snapshot({
        state: okState({ phase: "replanning", planRef: "plan:old", planRevision: "2" }),
        history: { status: "ok", planRef: "plan:new", toolGroups: [writeGroup()] },
      }),
    );
    expect(decision).toMatchObject({
      action: "propose",
      targetRole: "executor",
      nextState: { phase: "executing", planRef: "plan:new", planRevision: 3 },
    });
  });

  test("a blocked task stays blocked", () => {
    const decision = onRoute(snapshot({ state: okState({ phase: "blocked" }) }));
    expect(decision.action).toBe("keep");
    expect(expectReason(decision)).toBe("external_block");
  });

  test("a wrong contract does not route", () => {
    const decision = onRoute(snapshot({ contract: "route-v0" }));
    expect(decision.action).toBe("keep");
    expect(expectReason(decision)).toBe("policy_unavailable");
  });
});

describe("judgment schema", () => {
  const refs = ["group:g1", "history:0"];

  test("a well-formed answer is accepted", () => {
    const checked = checkAnswer(
      "handoff_readiness",
      JSON.stringify({ templateVersion: 1, verdict: "ready", evidence: ["group:g1"], reason: "ok" }),
      refs,
    );
    expect(checked.ok).toBe(true);
  });

  test("out-of-enum, foreign evidence and missing proof are refused", () => {
    const cases = [
      JSON.stringify({ templateVersion: 1, verdict: "continue", evidence: [], reason: "x" }),
      JSON.stringify({ templateVersion: 1, verdict: "ready", evidence: ["history:9"], reason: "x" }),
      JSON.stringify({ templateVersion: 1, verdict: "ready", evidence: [], reason: "x" }),
      JSON.stringify({ templateVersion: 2, verdict: "ready", evidence: ["history:0"], reason: "x" }),
      JSON.stringify({ templateVersion: 1, verdict: "ready", evidence: ["history:0"], extra: true }),
      "not json",
    ];
    for (const text of cases) {
      expect(checkAnswer("handoff_readiness", text, refs).ok).toBe(false);
    }
  });

  test("judgmentRequest carries the fixed template version", () => {
    expect(judgmentRequest("task_route", refs)).toEqual({
      question: "task_route",
      templateVersion: JUDGMENT_TEMPLATE_VERSION,
      evidence: refs,
    });
  });
});
