import type { RawMessage } from "../../src/history.ts";
import { findHandoff, handoffPath } from "../../src/provider/handoff.ts";

export const scope = "a".repeat(64);
export const expected = { scope, stateVersion: 1, planRevision: 1, previousPlanRef: "" };
export const observed = "src/orders.mjs:4 directly calls notifyOrder and auditOrder";
export function packet(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, scope, stateVersion: 1, planRevision: 1, planRef: "plan-1",
    goal: "Decouple orders while preserving public effects",
    constraints: ["Keep createOrder(id,total) compatible"],
    evidence: [{ ref: "tool:read-1", quote: observed, fact: "orders directly owns side effects" }],
    decisions: [{ choice: "Create one default wiring module", reason: "Register only once", rejected: "Register on each order duplicates listeners" }],
    steps: [{ id: "s1", files: ["src/orders.mjs"], action: "Import defaultBus and emit order:created", evidenceRefs: ["tool:read-1"], doneWhen: "No direct notification/audit imports remain" }],
    checks: [{ command: "node --test", expected: "Existing effects occur once", guardsAgainst: "Repeated subscription per order" }],
    completedWork: [], boundaries: ["Necessary editor reads and result checks remain required"], blockedBy: [], nextStep: "s1",
    ...overrides,
  };
}
export function transcript(value = packet(), options: { failed?: boolean; missing?: boolean; extraUse?: boolean } = {}): RawMessage[] {
  return [
    { role: "user", content: "Refactor orders" },
    { role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/orders.mjs" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", text: observed }] },
    { role: "assistant", content: [{ type: "text", text: `prewalk plan:${value.planRef}\nInvestigation complete.` }] },
    { role: "assistant", content: [
      { type: "tool_use", id: "write-1", name: "Write", input: { file_path: handoffPath(String(value.scope), Number(value.planRevision)), content: JSON.stringify(value) } },
      ...(options.extraUse ? [{ type: "tool_use", id: "pending-1", name: "Read", input: { file_path: "src/a.mjs" } }] : []),
    ] },
    { role: "user", content: options.missing ? [] : [{ type: "tool_result", tool_use_id: "write-1", text: options.failed ? "Error: denied" : "File written successfully" }] },
  ];
}

export function chatOf(raw: RawMessage[]): Record<string, unknown>[] {
  return raw.flatMap((message): Record<string, unknown>[] => {
    if (typeof message.content === "string") return [{ ...message }];
    if (message.role === "user") return message.content.map((block) => ({ role: "tool", tool_call_id: block.tool_use_id, content: block.text }));
    const content = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const uses = message.content.filter((block) => block.type === "tool_use");
    return [{ role: "assistant", content, ...(uses.length ? { tool_calls: uses.map((block) => ({
      id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) },
    })) } : {}) }];
  });
}
export function accepted(value = packet()) {
  const out = findHandoff(transcript(value), { scope: String(value.scope), stateVersion: Number(value.stateVersion),
    planRevision: Number(value.planRevision), previousPlanRef: "" });
  if (!out.ok) throw new Error(out.reason);
  return out.value;
}
