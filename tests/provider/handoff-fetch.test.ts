import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_KEY_PREFIX, type ProviderHooks } from "../../src/provider/internals.ts";
import { handoffScope } from "../../src/provider/handoff.ts";
import { chatOf, packet, transcript } from "./handoff-fixture.ts";

const options = { providerID: "prewalk", modelID: "route", planner: "real/planner", executor: "real/executor", defaultMode: "plan_then_execute", classifyTimeoutMs: 1000 };

test("real Provider fetch forwards verified implementation contract and skips judgment on evidenced mismatch", async () => {
  if (process.env.PREWALK_ISOLATED_HANDOFF_TEST !== "1") {
    // Match production's single plugin-host lifetime, independent from other
    // tests that initialized the module's StateStore before setting this root.
    const child = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      env: { ...process.env, PREWALK_ISOLATED_HANDOFF_TEST: "1" }, stdout: "pipe", stderr: "pipe",
    });
    if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    expect(child.exitCode).toBe(0);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "prewalk-handoff-fetch-"));
  const original = { fetch: globalThis.fetch, address: process.env.MAGPIE_ADDR, state: process.env.PREWALK_STATE_DIR };
  process.env.MAGPIE_ADDR = "127.0.0.1:3425";
  process.env.PREWALK_STATE_DIR = root;
  const requests: { body: Record<string, unknown>; headers: Headers; signal?: AbortSignal | null }[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const body = JSON.parse(String(init?.body));
    requests.push({ body, headers: new Headers(init?.headers), signal: init?.signal });
    if (String((body.messages?.[0] ?? {}).content).includes("classify a coding task")) {
      return Response.json({ choices: [{ message: { content: JSON.stringify({ templateVersion: 1, verdict: "plan_then_execute", evidence: ["history:0"] }) } }] });
    }
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const { default: createProviderPlugin } = await import("../../src/provider/index.ts");
    const hooks = await createProviderPlugin({}, options) as unknown as ProviderHooks;
    const loader = hooks.auth.loader(async () => ({ type: "api", key: GATEWAY_KEY_PREFIX + "synthetic-handoff-only" }), {});
    const session = "fetch-handoff";
    const binding = handoffScope(session, options);
    const send = (messages: unknown[], signal?: AbortSignal) => loader.fetch("http://127.0.0.1:1", {
      method: "POST", headers: new Headers({ "x-magpie-session": session }), signal,
      body: JSON.stringify({ model: "prewalk/route", stream: true, messages, tools: [{ type: "function", function: { name: "Write" } }] }),
    });
    expect((await send([{ role: "user", content: "task" }])).status).toBe(200);
    expect(requests).toHaveLength(2);
    const planning = requests.at(-1)!;
    expect(JSON.stringify(planning.body)).toContain(binding);
    const raw = transcript(packet({ scope: binding }));
    const messages = chatOf(raw);
    const controller = new AbortController();
    expect((await send(messages, controller.signal)).status).toBe(200);
    expect(requests).toHaveLength(3);
    const execution = requests.at(-1)!;
    expect(execution.body.model).toBe("real/executor");
    expect((execution.body.messages as unknown[]).slice(0, messages.length)).toEqual(messages);
    expect(JSON.stringify(execution.body)).toContain("Prewalk execution contract");
    expect(JSON.stringify(execution.body)).toContain("guardsAgainst");
    expect(execution.headers.get("authorization")).toBe("Bearer " + GATEWAY_KEY_PREFIX + "synthetic-handoff-only");
    expect(execution.signal).toBe(controller.signal);
    const saved = JSON.parse(await readFile(join(root, "sessions.json"), "utf8"));
    const state = saved.sessions[Buffer.from(session).toString("base64url")];
    expect(state.handoff.package.scope).toBe(binding);
    expect(state.phase).toBe("executing");
    const mismatch = [
      ...messages,
      { role: "assistant", tool_calls: [{ id: "observe-current", type: "function", function: { name: "Bash", arguments: '{"command":"node --test"}' } }] },
      { role: "tool", tool_call_id: "observe-current", content: "Error: the assumed interface is missing" },
      { role: "assistant", content: "prewalk mismatch:plan-1\n" + JSON.stringify({ version: 1, scope: binding, planRevision: 1, stepId: "s1", reason: "The interface assumption is false", evidence: [{ ref: "tool:observe-current", quote: "interface is missing" }] }) },
    ];
    expect((await send(mismatch)).status).toBe(200);
    expect(requests).toHaveLength(4);
    expect(requests.at(-1)!.body.model).toBe("real/planner");
    expect(JSON.stringify(requests.at(-1)!.body)).toContain("planRevision=2");
    expect(JSON.stringify(requests.at(-1)!.body)).not.toContain("Prewalk execution contract");
    const after = JSON.parse(await readFile(join(root, "sessions.json"), "utf8"));
    expect(after.sessions[Buffer.from(session).toString("base64url")].replanCount).toBe(1);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(send(messages, cancelled.signal)).rejects.toThrow();
    expect(requests).toHaveLength(4);
    const unchanged = await readFile(join(root, "sessions.json"), "utf8");
    expect(JSON.parse(unchanged)).toEqual(after);
  } finally {
    globalThis.fetch = original.fetch;
    if (original.address === undefined) delete process.env.MAGPIE_ADDR; else process.env.MAGPIE_ADDR = original.address;
    if (original.state === undefined) delete process.env.PREWALK_STATE_DIR; else process.env.PREWALK_STATE_DIR = original.state;
  }
});
