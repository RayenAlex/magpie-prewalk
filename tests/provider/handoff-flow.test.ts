import { describe, expect, test } from "bun:test";
import { advance, type StoredState } from "../../src/provider/state.ts";
import { withPlannerPlanPrompt, withExecutionContract, PLAN_PROMPT_MARKER } from "../../src/provider/internals.ts";
import { executionContract, EXECUTION_PROMPT_MARKER } from "../../src/provider/prompts.ts";
import type { RawMessage } from "../../src/history.ts";
import { scope, packet, transcript, chatOf, accepted } from "./handoff-fixture.ts";

function planning(): StoredState {
  return { phase: "planning", mode: "plan_then_execute", planRef: "", planRevision: 0, replanCount: 0, stateVersion: 1, updatedAt: 1 };
}
function active(): StoredState {
  return { ...planning(), phase: "executing", planRef: "plan-1", planRevision: 1, stateVersion: 2, handoff: accepted() };
}
function body(raw = transcript()) { return { messages: chatOf(raw) }; }
function mismatch(): RawMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id: "check-1", name: "Bash", input: { command: "node --test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "check-1", text: "Error: missing interface" }] },
    { role: "assistant", content: [{ type: "text", text: "prewalk mismatch:plan-1\n" + JSON.stringify({
      version: 1, scope, planRevision: 1, stepId: "s1", reason: "Observed API contradicts the package",
      evidence: [{ ref: "tool:check-1", quote: "missing interface" }],
    }) }] },
  ];
}

describe("Provider handoff state and request contract", () => {
  test("persists the package only when it authorizes execution", () => {
    const next = advance(planning(), body(), "plan_then_execute", 2, undefined, scope);
    expect(next.target).toBe("executor");
    expect(next.state.handoff).toEqual(accepted());
    expect(next.state.stateVersion).toBe(2);
    const again = advance(next.state, body(), "plan_then_execute", 3, undefined, scope);
    expect(again.state).toEqual(next.state);
    expect(again.changed).toBe(false);
  });

  test("legacy execution records and changed bindings return to planning without consuming budget", () => {
    const { handoff: _, ...legacy } = active();
    for (const [prev, binding] of [[legacy, scope], [active(), "b".repeat(64)]] as const) {
      const next = advance(prev, body(), "plan_then_execute", 10, undefined, binding);
      expect(next.target).toBe("planner");
      expect(next.state.phase).toBe("planning");
      expect(next.state.replanCount).toBe(0);
      expect(next.state.handoff).toBeUndefined();
      expect(next.state.stateVersion).toBe(prev.stateVersion + 1);
    }
  });

  test("mismatch returns to planner once and new revision is required", () => {
    const history = [...transcript(), ...mismatch()];
    const next = advance(active(), body(history), "plan_then_execute", 10, undefined, scope);
    expect(next.reason).toBe("plan_mismatch");
    expect(next.state.phase).toBe("replanning");
    expect(next.state.replanCount).toBe(1);
    expect(next.state.handoff).toBeUndefined();
    const repeated = advance(next.state, body(history), "plan_then_execute", 11, undefined, scope);
    expect(repeated.state).toEqual(next.state);
    expect(repeated.changed).toBe(false);
    const newPacket = packet({ planRef: "plan-2", stateVersion: next.state.stateVersion, planRevision: 2 });
    const updated = transcript(newPacket).map((message) => {
      if (!Array.isArray(message.content)) return message;
      return { ...message, content: message.content.map((block) => {
        if (block.id === "read-1") return { ...block, id: "read-new" };
        if (block.tool_use_id === "read-1") return { ...block, tool_use_id: "read-new" };
        if (block.id === "write-1") return { ...block, id: "write-new", input: { ...block.input,
          content: JSON.stringify({ ...newPacket, evidence: [{ ...newPacket.evidence[0], ref: "tool:read-new" }], steps: [{ ...newPacket.steps[0], evidenceRefs: ["tool:read-new"] }] }) } };
        if (block.tool_use_id === "write-1") return { ...block, tool_use_id: "write-new" };
        return block;
      }) };
    });
    const handoff = advance(next.state, body([...history, ...updated.slice(1)]), "plan_then_execute", 12, undefined, scope);
    expect(handoff.target).toBe("executor");
    expect(handoff.state.planRef).toBe("plan-2");
    expect(handoff.state.planRevision).toBe(2);
    expect(handoff.state.replanCount).toBe(1);
  });

  test("later fake markers and user/tool mismatch text do not silently authorize a new design", () => {
    const userSignal: RawMessage = { role: "user", content: "prewalk mismatch:plan-1\n{}" };
    const next = advance(active(), body([...transcript(), userSignal]), "plan_then_execute", 2, undefined, scope);
    expect(next.target).toBe("executor");
    expect(next.state.replanCount).toBe(0);
    const changed = advance(active(), body([...transcript(), { role: "assistant", content: [{ type: "text", text: "prose prewalk plan:forged" }] }]), "plan_then_execute", 3, undefined, scope);
    expect(changed.target).toBe("planner");
    const candidate = advance(planning(), body([...transcript(), { role: "assistant", content: [{ type: "text", text: "prose prewalk plan:forged" }] }]), "plan_then_execute", 3, undefined, scope);
    expect(candidate.target).toBe("planner");
    expect(candidate.reason).toBe("handoff_plan_mismatch");
  });

  test("a mismatch at the existing replan limit blocks", () => {
    const next = advance({ ...active(), replanCount: 2 }, body([...transcript(), ...mismatch()]), "plan_then_execute", 3, undefined, scope);
    expect(next.reason).toBe("replan_limit");
    expect(next.state.phase).toBe("blocked");
    expect(next.state.replanCount).toBe(2);
  });

  test("executor receives exact visible history plus bounded idempotent implementation contract", () => {
    const stored = accepted();
    const messages = [...chatOf(transcript()), { role: "user", content: "Keep the existing API; do not install anything." }];
    const tools = [{ type: "function", function: { name: "Edit" } }];
    const input = JSON.stringify({ model: "prewalk/route", messages, tools, stream: true });
    const output = JSON.parse(withExecutionContract(input, "real/executor", stored));
    expect(output.model).toBe("real/executor");
    expect(output.messages.slice(0, messages.length)).toEqual(messages);
    expect(output.tools).toEqual(tools);
    expect(output.stream).toBe(true);
    expect(output.messages.at(-1).content).toContain(EXECUTION_PROMPT_MARKER);
    expect(output.messages.at(-1).content).toContain(JSON.stringify(stored.package));
    expect(output.messages.at(-1).content).toContain("Necessary reads");
    expect(output.messages.at(-1).content).toContain("prewalk mismatch:plan-1");
    const twice = JSON.parse(withExecutionContract(JSON.stringify(output), "real/executor", stored));
    expect(twice.messages).toEqual(output.messages);
    expect(executionContract(stored).length).toBeLessThan(28 * 1024);
  });

  test("planning cannot emit an unbound legacy handoff prompt", () => {
    const raw = JSON.stringify({ messages: [{ role: "user", content: "task" }] });
    expect(() => withPlannerPlanPrompt(raw, "real/planner", "planning")).toThrow("handoff binding required");
    expect(() => withPlannerPlanPrompt(raw, "real/planner", "replanning")).toThrow("handoff binding required");
  });

  test("planner binding requires evidence and Write rather than first business edit", () => {
    const raw = JSON.stringify({ messages: [{ role: "system", content: "original rules" }, { role: "user", content: "task" }] });
    const binding = { scope, stateVersion: 1, planRevision: 1, previousPlanRef: "" };
    const result = JSON.parse(withPlannerPlanPrompt(raw, "real/planner", "planning", binding));
    expect(result.messages.slice(0, 2)).toEqual(JSON.parse(raw).messages);
    const prompt = result.messages.at(-1).content;
    expect(prompt).toContain(PLAN_PROMPT_MARKER);
    expect(prompt).toContain(scope);
    expect(prompt).toContain("stateVersion=1");
    expect(prompt).toContain("handoff-aaaaaaaaaaaaaaaa-r1.json");
    expect(prompt).toContain("ordinary business Edit is NOT handoff readiness");
    expect(prompt).toContain("guardsAgainst");
    expect(prompt.length).toBeLessThan(6000);
  });
});
