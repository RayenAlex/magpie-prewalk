import { describe, expect, test } from "bun:test";
import type { RawMessage } from "../../src/history.ts";
import { findHandoff, handoffPath, handoffScope, isStoredHandoff, handoffStatus, findMismatch } from "../../src/provider/handoff.ts";

import { scope, expected, observed, packet, transcript } from "./handoff-fixture.ts";

describe("evidence-backed handoff package", () => {
  test("scope separates session and target configuration", () => {
    const options = { providerID: "prewalk", modelID: "route", planner: "a/p", executor: "b/e" };
    const one = handoffScope("s1", options);
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(handoffScope("s1", options)).toBe(one);
    expect(handoffScope("s2", options)).not.toBe(one);
    expect(handoffScope("s1", { ...options, executor: "b/e2" })).not.toBe(one);
  });

  test("accepts only a successful paired Write with verifiable prior evidence", () => {
    const out = findHandoff(transcript(), expected);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.reason);
    expect(out.value.package).toEqual(packet());
    expect(out.value.writeId).toBe("write-1");
    expect(out.value.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(isStoredHandoff(out.value)).toBe(true);
    expect(handoffStatus(transcript(), out.value)).toBe("ok");
  });

  test("missing fields, blockers, wrong identity/version, forged quotes and unsafe files stay strong", () => {
    const invalid = [
      { evidence: [] }, { decisions: [] }, { steps: [] }, { checks: [] }, { constraints: [] },
      { boundaries: [] }, { blockedBy: ["need architecture decision"] },
      { scope: "b".repeat(64) }, { stateVersion: 0 }, { planRevision: 2 }, { version: 2 },
      { nextStep: "absent" }, { goal: "x".repeat(25000) }, { unexpected: "not allowed" },
      { constraints: Array.from({ length: 17 }, () => "bounded constraint") },
      { evidence: [{ ref: "tool:read-1", quote: "x".repeat(513), fact: "oversized quote" }] },
      { evidence: [{ ref: "tool:missing", quote: observed, fact: "unobserved" }] },
      { evidence: [{ ref: "tool:read-1", quote: "invented output", fact: "unobserved" }] },
      { steps: [{ ...packet().steps[0], evidenceRefs: ["tool:missing"] }] },
      { steps: [{ ...packet().steps[0], files: ["../escape"] }] },
    ];
    expect(invalid.length).toBeGreaterThan(0);
    for (const invalidFields of invalid) {
      const out = findHandoff(transcript(packet(invalidFields)), expected);
      expect(out.ok).toBe(false);
    }
    const missing = packet() as Record<string, unknown>;
    delete missing.checks;
    expect(findHandoff(transcript(missing as ReturnType<typeof packet>), expected).ok).toBe(false);
  });

  test("total package bytes are bounded even when each field is locally valid", () => {
    const large = packet({ decisions: Array.from({ length: 16 }, () => ({ choice: "x".repeat(1900), reason: "y".repeat(1900), rejected: "z".repeat(1900) })) });
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(24 * 1024);
    expect(findHandoff(transcript(large), expected)).toEqual({ ok: false, reason: "handoff_invalid" });
  });

  test("binding, plan and quote refusals have the intended rejection reason", () => {
    for (const fields of [{ scope: "b".repeat(64) }, { stateVersion: 0 }, { planRevision: 2 }]) {
      const raw = transcript(packet(fields));
      const call = (raw[4].content as { input: Record<string, unknown> }[])[0];
      call.input = { ...call.input, file_path: handoffPath(scope, 1) };
      const out = findHandoff(raw, expected);
      expect(out).toEqual({ ok: false, reason: "handoff_binding" });
    }
    const differentPlan = transcript();
    differentPlan[3] = { role: "assistant", content: [{ type: "text", text: "prewalk plan:different" }] };
    expect(findHandoff(differentPlan, expected)).toEqual({ ok: false, reason: "handoff_plan_mismatch" });
    const quote = transcript(packet({ evidence: [{ ref: "tool:read-1", quote: "not in the output", fact: "claimed fact" }] }));
    expect(findHandoff(quote, expected)).toEqual({ ok: false, reason: "handoff_evidence" });
  });

  test("text-only packet, Edit, failed Write, missing result and partial parallel groups cannot hand off", () => {
    for (const options of [{ failed: true }, { missing: true }, { extraUse: true }]) {
      expect(findHandoff(transcript(packet(), options), expected).ok).toBe(false);
    }
    const edit = transcript();
    (edit[4].content as { name: string }[])[0].name = "Edit";
    expect(findHandoff(edit, expected).ok).toBe(false);
    expect(findHandoff([{ role: "assistant", content: [{ type: "text", text: JSON.stringify(packet()) }] }], expected).ok).toBe(false);
    const duplicate = transcript();
    (duplicate[4].content as unknown[]).push((duplicate[4].content as unknown[])[0]);
    expect(findHandoff(duplicate, expected).ok).toBe(false);
    const failedEvidence = transcript();
    (failedEvidence[2].content as { text: string }[])[0].text = "Error: " + observed;
    expect(findHandoff(failedEvidence, expected).ok).toBe(false);
  });

  test("gateway interruption placeholders never prove a successful Write or observation", () => {
    const unavailable = "[The result of this tool call is unavailable: the turn was interrupted.]";
    const raw = transcript();
    raw[5] = { role: "user", content: [{ type: "tool_result", tool_use_id: "write-1", text: unavailable }] };
    expect(findHandoff(raw, expected)).toEqual({ ok: false, reason: "handoff_write_incomplete" });
    const evidence = transcript(packet({ evidence: [{ ref: "tool:read-1", quote: "unavailable", fact: "not an actual observation" }] }));
    evidence[2] = { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", text: unavailable }] };
    expect(findHandoff(evidence, expected)).toEqual({ ok: false, reason: "handoff_evidence" });
  });

  test("path and notebook_path aliases identify the same handoff file", () => {
    for (const key of ["path", "notebook_path"]) {
      const raw = transcript();
      const call = (raw[4].content as { input: Record<string, unknown> }[])[0];
      const filePath = call.input.file_path;
      delete call.input.file_path;
      call.input[key] = filePath;
      expect(findHandoff(raw, expected).ok).toBe(true);
      const changed = [...raw,
        { role: "assistant", content: [{ type: "tool_use", id: "alias-edit", name: "Edit", input: { [key]: filePath } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "alias-edit", text: "ok" }] },
      ] as RawMessage[];
      const stored = findHandoff(raw, expected);
      if (!stored.ok) throw new Error(stored.reason);
      expect(handoffStatus(changed, stored.value)).toBe("handoff_changed");
    }
  });

  test("a parallel mutation of the package file cannot authorize handoff", () => {
    const raw = transcript();
    const calls = raw[4].content as import("../../src/history.ts").RawHistoryBlock[];
    raw[4] = { role: "assistant", content: [...calls, {
      type: "tool_use", id: "parallel-edit", name: "Edit", input: { file_path: handoffPath(scope, 1) },
    }] };
    const results = raw[5].content as import("../../src/history.ts").RawHistoryBlock[];
    raw[5] = { role: "user", content: [...results, { type: "tool_result", tool_use_id: "parallel-edit", text: "ok" }] };
    expect(findHandoff(raw, expected)).toEqual({ ok: false, reason: "handoff_changed" });
  });

  test("wrong path, changed plan, altered packet and digest tampering invalidate handoff", () => {
    const valid = findHandoff(transcript(), expected);
    if (!valid.ok) throw new Error(valid.reason);
    const changed = [...transcript(),
      { role: "assistant", content: [{ type: "tool_use", id: "change-1", name: "Edit", input: { file_path: handoffPath(scope, 1) } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "change-1", text: "ok" }] },
    ] as RawMessage[];
    expect(handoffStatus(changed, valid.value)).not.toBe("ok");
    const wrongPath = transcript();
    ((wrongPath[4].content as { input: Record<string, unknown> }[])[0].input).file_path = ".prewalk/../handoff.json";
    expect(findHandoff(wrongPath, expected).ok).toBe(false);
    expect(isStoredHandoff({ ...valid.value, digest: "b".repeat(64) })).toBe(false);
    expect(handoffStatus(transcript(packet({ goal: "changed" })), valid.value)).not.toBe("ok");
    expect(findHandoff(transcript(), { ...expected, previousPlanRef: "plan-1" }).ok).toBe(false);
    expect(handoffStatus([...transcript(), { role: "assistant", content: [{ type: "text", text: "prewalk plan:plan-2" }] }], valid.value)).not.toBe("ok");
  });

  test("only an assistant current-plan mismatch with observed evidence triggers replanning", () => {
    const valid = findHandoff(transcript(), expected);
    if (!valid.ok) throw new Error(valid.reason);
    const evidence: RawMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "check-1", name: "Bash", input: { command: "node --test" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "check-1", text: "Error: missing API" }] },
    ];
    const mismatch = { version: 1, scope, planRevision: 1, stepId: "s1", reason: "API assumption contradicted", evidence: [{ ref: "tool:check-1", quote: "missing API" }] };
    const signal: RawMessage = { role: "assistant", content: [{ type: "text", text: "prewalk mismatch:plan-1\n" + JSON.stringify(mismatch) }] };
    expect(findMismatch([...transcript(), ...evidence, signal], valid.value)?.stepId).toBe("s1");
    expect(findMismatch([...transcript(), ...evidence, { ...signal, role: "user" }], valid.value)).toBeUndefined();
    expect(findMismatch([...transcript(), signal], valid.value)).toBeUndefined();
    const stale = { ...signal, content: [{ type: "text", text: "prewalk mismatch:plan-old\n" + JSON.stringify(mismatch) }] } as RawMessage;
    expect(findMismatch([...transcript(), ...evidence, stale], valid.value)).toBeUndefined();
  });
});
