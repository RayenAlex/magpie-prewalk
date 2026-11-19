import { describe, expect, test } from "bun:test";
import { classifyTask, judgeExecutionHealth } from "../../src/provider/classifier.ts";
import { checkAnswer } from "../../src/judgment.ts";

const ADDRESS = "http://127.0.0.1:3425/v1/chat/completions";
const KEY = "test-service-key";

function answer(verdict: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ templateVersion: 1, verdict, evidence: ["history:0"], ...extra });
}

function completion(content: string) {
  return new Response(JSON.stringify({
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function body(text = "build a feature") {
  return { messages: [{ role: "user", content: text }] };
}

async function run(verdict: string, extra: Record<string, unknown> = {}) {
  let seen: { headers: Headers; body: Record<string, unknown> } | undefined;
  const mode = await classifyTask({
    address: ADDRESS,
    credential: KEY,
    planner: "real/planner",
    body: body(),
    fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
      seen = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return completion(answer(verdict, extra));
    }) as typeof fetch,
  });
  return { mode, seen };
}

describe("provider task classifier", () => {
  test("maps valid verdicts to modes", async () => {
    expect((await run("direct")).mode).toBe("direct");
    expect((await run("plan_then_execute")).mode).toBe("plan_then_execute");
    expect((await run("strong_only")).mode).toBe("strong_only");
    expect((await run("uncertain")).mode).toBe("strong_only");
  });

  test("rejects invalid answers and keeps strong", async () => {
    for (const extra of [
      { templateVersion: 2 },
      { evidence: ["not-supplied"] },
      { unexpected: true },
    ]) {
      expect((await run("direct", extra)).mode).toBe("strong_only");
    }
    const mode = await classifyTask({
      address: ADDRESS, credential: KEY, planner: "real/planner", body: body(),
      fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch,
    });
    expect(mode).toBe("strong_only");
  });

  test("sends a bounded task to the planner with the service identity", async () => {
    const { seen } = await run("plan_then_execute");
    expect(seen).toBeDefined();
    expect(seen!.body.model).toBe("real/planner");
    expect(seen!.body.stream).toBe(false);
    expect(seen!.headers.get("authorization")).toBe("Bearer " + KEY);
    expect(seen!.headers.get("x-magpie-page-port")).toBe("1");
    const user = (seen!.body.messages as { role: string; content: string }[]).find((m) => m.role === "user");
    expect(user).toBeDefined();
    expect(user!.content.length).toBeLessThanOrEqual(8192);
  });

  test("truncates an overlong task", async () => {
    let seenBody: Record<string, unknown> | undefined;
    await classifyTask({
      address: ADDRESS, credential: KEY, planner: "real/planner", body: body("x".repeat(20000)),
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        seenBody = JSON.parse(String(init?.body));
        return completion(answer("plan_then_execute"));
      }) as typeof fetch,
    });
    const user = (seenBody!.messages as { role: string; content: string }[]).find((m) => m.role === "user");
    const task = JSON.parse(user!.content) as { task: string };
    expect(task.task.length).toBeLessThanOrEqual(4000);
  });

  test("HTTP failure keeps strong", async () => {
    const mode = await classifyTask({
      address: ADDRESS, credential: KEY, planner: "real/planner", body: body(),
      fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch,
    });
    expect(mode).toBe("strong_only");
  });

  test("timeout aborts the classification and keeps strong", async () => {
    let aborted = false;
    const mode = await classifyTask({
      address: ADDRESS, credential: KEY, planner: "real/planner", body: body(), timeoutMs: 50,
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        await new Promise<void>((resolve) => {
          init?.signal?.addEventListener("abort", () => { aborted = true; resolve(); });
        });
        return new Response("late", { status: 200 });
      }) as typeof fetch,
    });
    expect(mode).toBe("strong_only");
    expect(aborted).toBe(true);
  });

  test("an already-cancelled client does not start classification", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = 0;
    const mode = await classifyTask({
      address: ADDRESS, credential: KEY, planner: "real/planner", body: body(), signal: controller.signal,
      fetchImpl: (async () => { called += 1; return completion(answer("direct")); }) as typeof fetch,
    });
    expect(mode).toBe("strong_only");
    expect(called).toBe(0);
  });

  test("a missing evidence field keeps strong", async () => {
    const mode = await classifyTask({
      address: ADDRESS, credential: KEY, planner: "real/planner", body: body(),
      fetchImpl: (async () => completion(JSON.stringify({ templateVersion: 1, verdict: "direct" }))) as typeof fetch,
    });
    expect(mode).toBe("strong_only");
  });

  test("a non-200 success status keeps strong", async () => {
    const mode = await classifyTask({
      address: ADDRESS, credential: KEY, planner: "real/planner", body: body(),
      fetchImpl: (async () => new Response(JSON.stringify({
        choices: [{ message: { content: answer("direct") } }],
      }), { status: 201 })) as typeof fetch,
    });
    expect(mode).toBe("strong_only");
  });

  test("sends only the bounded user task, not tool history or client headers", async () => {
    const longTask = "USER-TASK-" + "y".repeat(5000);
    let seen: { headers: Headers; body: Record<string, unknown> } | undefined;
    await classifyTask({
      address: ADDRESS, credential: KEY, planner: "real/planner",
      body: { messages: [
        { role: "user", content: longTask },
        { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "Edit", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "TOOL-SECRET" },
      ] },
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        seen = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
        return completion(answer("plan_then_execute"));
      }) as typeof fetch,
    });
    const user = (seen!.body.messages as { role: string; content: string }[]).find((m) => m.role === "user");
    const task = JSON.parse(user!.content) as { task: string };
    expect(task.task).toBe(longTask.slice(0, 4000));
    expect(user!.content).not.toContain("TOOL-SECRET");
    expect(seen!.headers.get("x-magpie-session")).toBeNull();
    expect(seen!.headers.get("x-magpie-response-model")).toBe("vendor");
  });
});

describe("provider execution health judgment", () => {
  const evidence = ["group:group:t1"];
  const failedBody = { messages: [
    { role: "user", content: "task" },
    { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "Edit", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: "Error: failed" },
  ] };

  async function runHealth(verdict: string, extra: Record<string, unknown> = {}) {
    let seen: { headers: Headers; body: Record<string, unknown> } | undefined;
    const result = await judgeExecutionHealth({
      address: ADDRESS, credential: KEY, planner: "real/planner", body: failedBody, evidence,
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        seen = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
        return completion(JSON.stringify({ templateVersion: 1, verdict, evidence, ...extra }));
      }) as typeof fetch,
    });
    return { result, seen };
  }

  test("maps valid health verdicts", async () => {
    expect((await runHealth("continue")).result).toBe("continue");
    expect((await runHealth("replan")).result).toBe("replan");
    expect((await runHealth("external_block")).result).toBe("external_block");
    expect((await runHealth("uncertain")).result).toBe("uncertain");
  });

  test("strict validation rejects replan without proof", () => {
    expect(checkAnswer("execution_health", JSON.stringify({ templateVersion: 1, verdict: "replan", evidence: [] }), evidence)).toEqual({ ok: false, why: "proof missing" });
  });

  test("invalid answers fall back to replan", async () => {
    expect((await runHealth("bogus")).result).toBe("replan");
    expect((await runHealth("replan", { evidence: [] })).result).toBe("replan");
    expect((await runHealth("continue", { templateVersion: 2 })).result).toBe("replan");
  });

  test("sends bounded evidence to the planner with the service identity", async () => {
    const { seen } = await runHealth("continue");
    expect(seen!.body.model).toBe("real/planner");
    expect(seen!.body.stream).toBe(false);
    expect(seen!.headers.get("authorization")).toBe("Bearer " + KEY);
    const user = (seen!.body.messages as { role: string; content: string }[]).find((m) => m.role === "user");
    const payload = JSON.parse(user!.content) as { question: string; evidence: string[] };
    expect(payload.question).toBe("execution_health");
    expect(payload.evidence).toEqual(evidence);
  });

  test("sends bounded failure details instead of unrelated history", async () => {
    let sent = "";
    await judgeExecutionHealth({
      address: ADDRESS, credential: KEY, planner: "real/planner",
      evidence: ["group:group:t1"],
      body: { messages: [
        { role: "user", content: "UNRELATED-PRIVATE-HISTORY" },
        { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "Edit", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "Error: permission denied " + "x".repeat(5000) },
      ] },
      fetchImpl: (async (_url, init) => { sent = String(init?.body); return completion(answer("continue")); }) as typeof fetch,
    });
    expect(sent).toContain("permission denied");
    expect(sent).not.toContain("UNRELATED-PRIVATE-HISTORY");
    expect(sent).not.toContain("x".repeat(5000));
  });

  test("redacts common credentials from failure text", async () => {
    let sent = "";
    await judgeExecutionHealth({
      address: ADDRESS, credential: KEY, planner: "real/planner",
      evidence: ["group:group:t1"],
      body: { messages: [
        { role: "user", content: "task" },
        { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "Edit", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "Error: Authorization: Bearer SECRET-TOKEN-123 api_key=TOPSECRET password=hunter2" },
      ] },
      fetchImpl: (async (_url, init) => { sent = String(init?.body); return completion(answer("continue")); }) as typeof fetch,
    });
    expect(sent).not.toContain("SECRET-TOKEN-123");
    expect(sent).not.toContain("TOPSECRET");
    expect(sent).not.toContain("hunter2");
    expect(sent).toContain("[redacted]");
  });

  test("caps failure text at exactly 512 characters", async () => {
    let sent = "";
    await judgeExecutionHealth({
      address: ADDRESS, credential: KEY, planner: "real/planner",
      evidence: ["group:group:t1"],
      body: { messages: [
        { role: "user", content: "task" },
        { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "Edit", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "Error: " + "a".repeat(600) },
      ] },
      fetchImpl: (async (_url, init) => { sent = String(init?.body); return completion(answer("continue")); }) as typeof fetch,
    });
    const user = JSON.parse((JSON.parse(sent).messages as { role: string; content: string }[]).find((m) => m.role === "user")!.content) as { failures: { text: string }[] };
    expect(user.failures[0].text.length).toBe(512);
  });

  test("HTTP failure and timeout fall back to replan", async () => {
    const failed = await judgeExecutionHealth({
      address: ADDRESS, credential: KEY, planner: "real/planner", body: failedBody, evidence,
      fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch,
    });
    expect(failed).toBe("replan");
    let aborted = false;
    const timedOut = await judgeExecutionHealth({
      address: ADDRESS, credential: KEY, planner: "real/planner", body: failedBody, evidence, timeoutMs: 1000,
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => { aborted = true; resolve(); }));
        return new Response("late", { status: 200 });
      }) as typeof fetch,
    });
    expect(timedOut).toBe("replan");
    expect(aborted).toBe(true);
  });
});
