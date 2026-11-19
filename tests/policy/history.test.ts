import { describe, expect, test } from "bun:test";

import { buildHistory, type RawMessage } from "../../src/history";
import { onRoute } from "../../src/policy";

function user(id: string, text = ""): RawMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, text }],
  };
}

function use(id: string, name: string, input: Record<string, unknown> = {}): RawMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  };
}

function plan(ref: string): RawMessage {
  return { role: "assistant", content: [{ type: "text", text: `prewalk plan:${ref}\n1. do work` }] };
}

describe("structured history", () => {
  test("a public assistant plan is visible", () => {
    expect(buildHistory([plan("plan:7")]).planRef).toBe("plan:7");
  });

  test("TodoWrite success alone is not a plan", () => {
    const history = buildHistory([use("t1", "TodoWrite"), user("t1")]);
    expect(history.planRef).toBe("");
    expect(history.toolGroups).toHaveLength(0);
  });

  test("a successful Edit is a real write group", () => {
    const history = buildHistory([use("t1", "Edit", { file_path: "a.go" }), user("t1")]);
    expect(history.toolGroups).toEqual([
      { id: "group:t1", tools: ["Edit"], results: [{ id: "t1", ok: true }], complete: true, afterPlan: false },
    ]);
  });

  test("failed Edit is visible but does not authorize a handoff", () => {
    const history = buildHistory([use("t1", "Edit"), user("t1", "error: no such file")]);
    expect(history.toolGroups).toEqual([
      { id: "group:t1", tools: ["Edit"], results: [{ id: "t1", ok: false }], complete: true, afterPlan: false },
    ]);
  });

  test("a parallel group answered only in part is incomplete", () => {
    const messages: RawMessage[] = [
      { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "Edit", input: {} },
        { type: "tool_use", id: "t2", name: "Read", input: {} },
      ] },
      user("t1"),
    ];
    const history = buildHistory(messages);
    expect(history.status).toBe("incomplete");
    expect(history.reason).toBe("tool_group_incomplete");
  });

  test("an empty tool group cannot authorize a handoff", () => {
    const history = buildHistory([{ role: "assistant", content: [] }, { role: "user", content: [] }]);
    expect(history.toolGroups).toHaveLength(0);
  });

  test("readonly, MCP, virtual and Bash strings are not real writes", () => {
    const names = ["Read", "Grep", "Task", "mcp__write", "VirtualEdit", "Bash", "UnknownWrite"];
    for (const name of names) {
      const history = buildHistory([use("t1", name, { file_path: "a.go" }), user("t1")]);
      expect(history.toolGroups, name).toHaveLength(0);
    }
  });

  test("the latest public plan is the visible one", () => {
    expect(buildHistory([plan("plan:1"), plan("plan:2")]).planRef).toBe("plan:2");
  });
});

describe("failed write evidence", () => {
  test("an executing task sees the failed Edit and asks execution_health", () => {
    const history = buildHistory([use("t1", "Edit"), user("t1", "error: no such file")]);
    const decision = onRoute({
      contract: "route-v1",
      entry: "group/prewalk",
      state: { status: "ok", phase: "executing", mode: "plan_then_execute", stateVersion: "1" },
      history,
    });
    expect(decision).toMatchObject({ action: "judge", question: "execution_health" });
  });
});
