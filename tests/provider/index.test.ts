import { describe, expect, test } from "bun:test";
import { expected } from "./handoff-fixture.ts";
import createProviderPlugin from "../../src/provider/index.ts";
import { GATEWAY_KEY_PREFIX, PLAN_PROMPT_MARKER, parseProviderOptions, resolveTarget, targetLoops, withPlannerPlanPrompt } from "../../src/provider/internals.ts";

const base = {
  providerID: "prewalk",
  modelID: "route",
  planner: "real/planner",
  executor: "real/executor",
  defaultMode: "plan_then_execute" as const,
  classifyTimeoutMs: 10000,
  healthTimeoutMs: 10000,
};

// Synthetic value built from the public key prefix; never a real key.
const SERVICE_KEY = GATEWAY_KEY_PREFIX + "test-only-not-a-real-key";

describe("provider authorization and billing boundary", () => {
  test("parses only explicit direct model references", () => {
    expect(parseProviderOptions(base)).toEqual(base);
    const namespaced = { ...base, planner: "openrouter/openai/gpt-5-image" };
    expect(parseProviderOptions(namespaced).planner).toBe("openrouter/openai/gpt-5-image");
    expect(parseProviderOptions({ ...base, planner: "group/example-plan" }).planner).toBe("group/example-plan");
    for (const bad of [
      { ...base, planner: "group/Example-plan" },
      { ...base, planner: "group/a/b" },
      { ...base, executor: "prewalk/route" },
      { ...base, planner: "../escape" },
      { ...base, executor: "" },
      { ...base, defaultMode: "sometimes" },
    ]) {
      expect(() => parseProviderOptions(bad)).toThrow();
    }
  });

  test("supports a bounded slow-planner deadline independently from health checks", () => {
    const { classifyTimeoutMs: _classification, healthTimeoutMs: _health, ...legacy } = base;
    const defaults = parseProviderOptions(legacy);
    expect(defaults.classifyTimeoutMs).toBe(120000);
    expect(defaults.healthTimeoutMs).toBe(10000);
    expect(parseProviderOptions({ ...base, classifyTimeoutMs: 180000 }).classifyTimeoutMs).toBe(180000);
    expect(parseProviderOptions({ ...base, classifyTimeoutMs: 300000 }).classifyTimeoutMs).toBe(300000);
    expect(parseProviderOptions({ ...legacy, classifyTimeoutMs: 10000 }).classifyTimeoutMs).toBe(10000);
    expect(parseProviderOptions({ ...legacy, classifyTimeoutMs: 120000 }).healthTimeoutMs).toBe(10000);
    expect(parseProviderOptions({ ...base, healthTimeoutMs: 1000 }).healthTimeoutMs).toBe(1000);
    for (const bad of [999, 300001, 1.5, Infinity, "120000"]) {
      expect(() => parseProviderOptions({ ...base, classifyTimeoutMs: bad })).toThrow("classifyTimeoutMs");
    }
    for (const bad of [999, 30001, 1.5, Infinity, "10000"]) {
      expect(() => parseProviderOptions({ ...base, healthTimeoutMs: bad })).toThrow("healthTimeoutMs");
    }
  });

  test("refuses a group hop that returns to prewalk", () => {
    expect(targetLoops("prewalk/route", "prewalk", "route")).toBe(true);
    expect(targetLoops("group/example-plan", "prewalk", "route", new Headers({ "x-prewalk-via": "1" }))).toBe(true);
    expect(targetLoops("group/example-plan", "prewalk", "route")).toBe(false);
  });

  test("selects only configured direct targets", () => {
    const options = parseProviderOptions(base);
    expect(resolveTarget(options, "strong")).toBe("real/planner");
    expect(resolveTarget(options, "weak")).toBe("real/executor");
    expect(() => resolveTarget(options, "other")).toThrow();
  });

  test("uses default options when host loads before saved options", async () => {
    const hooks = (await createProviderPlugin({}, undefined)) as any;
    expect(hooks.auth.provider).toBe("prewalk");
    expect(hooks.auth.single).toBe(true);
  });

  test("rejects a missing or malformed service credential", async () => {
    const hooks = (await createProviderPlugin({}, base)) as any;
    const loader = hooks.auth.loader(async () => ({ type: "oauth", access: "not-a-service-key" }));
    const response = (await loader.fetch("http://127.0.0.1:1/v1/chat/completions", {
      method: "POST",
      headers: new Headers(),
      body: JSON.stringify({ model: "prewalk/route", messages: [] }),
    })) as Response;
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("not-a-service-key");
  });

  test("forces authentication and does not forward the marker to vendor", async () => {
    const requests: { headers: Headers; body: unknown }[] = [];
    const originalFetch = globalThis.fetch;
    const originalAddress = process.env.MAGPIE_ADDR;
    process.env.MAGPIE_ADDR = "127.0.0.1:3425";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({ headers, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const hooks = (await createProviderPlugin({}, base)) as any;
      const loader = hooks.auth.loader(async () => ({ type: "api", key: SERVICE_KEY }));
      const response = (await loader.fetch("http://127.0.0.1:1/v1/chat/completions", {
        method: "POST",
        headers: new Headers({ "x-magpie-session": "session-a" }),
        body: JSON.stringify({ model: "prewalk/route", messages: [{ role: "user", content: "synthetic" }] }),
      })) as Response;
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0].headers.get("authorization")).toBe("Bearer " + SERVICE_KEY);
      expect(requests[0].headers.get("x-magpie-page-port")).toBe("1");
      expect(requests[0].headers.get("x-prewalk-via")).toBe("1");
      expect(requests[0].headers.get("x-magpie-session")).toBeNull();
      expect((requests[0].body as { model: string }).model).toBe("real/planner");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAddress === undefined) delete process.env.MAGPIE_ADDR;
      else process.env.MAGPIE_ADDR = originalAddress;
    }
  });

  test("rejects a missing or non-string request body locally", async () => {
    const originalFetch = globalThis.fetch;
    const originalAddress = process.env.MAGPIE_ADDR;
    process.env.MAGPIE_ADDR = "127.0.0.1:3425";
    let reached = 0;
    globalThis.fetch = (async () => {
      reached += 1;
      return new Response("unexpected", { status: 200 });
    }) as typeof fetch;
    try {
      const hooks = (await createProviderPlugin({}, base)) as any;
      const loader = hooks.auth.loader(async () => ({ type: "api", key: SERVICE_KEY }));
      for (const body of [undefined, new Uint8Array([123, 125])]) {
        const response = (await loader.fetch("http://127.0.0.1:1/v1/chat/completions", {
          method: "POST",
          headers: new Headers(),
          body,
        })) as Response;
        expect(response.status).toBe(400);
      }
      expect(reached).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAddress === undefined) delete process.env.MAGPIE_ADDR;
      else process.env.MAGPIE_ADDR = originalAddress;
    }
  });

  test("adds a bounded plan prompt only to planner business requests", () => {
    const raw = JSON.stringify({
      model: "prewalk/route",
      messages: [
        { role: "system", content: "existing system" },
        { role: "user", content: "task" },
      ],
      tools: [{ type: "function", function: { name: "Edit" } }],
    });
    const planned = JSON.parse(withPlannerPlanPrompt(raw, "real/planner", "planning", expected));
    expect(planned.model).toBe("real/planner");
    expect(planned.messages).toHaveLength(3);
    expect(planned.messages[0]).toEqual({ role: "system", content: "existing system" });
    expect(planned.messages[1]).toEqual({ role: "user", content: "task" });
    expect(planned.messages[2].content).toContain("prewalk plan:<ref>");
    expect(planned.messages[2].content.length).toBeLessThan(6000);
    expect(planned.messages[2]).toEqual({ role: "system", content: expect.stringContaining(PLAN_PROMPT_MARKER) });
    expect(planned.tools).toEqual([{ type: "function", function: { name: "Edit" } }]);
    expect(withPlannerPlanPrompt(raw, "real/executor").includes(PLAN_PROMPT_MARKER)).toBe(false);
    expect(withPlannerPlanPrompt(raw, "real/planner").includes(PLAN_PROMPT_MARKER)).toBe(false);
    expect(withPlannerPlanPrompt(raw, "real/planner", "planning", expected).includes(PLAN_PROMPT_MARKER)).toBe(true);
    expect(withPlannerPlanPrompt(raw, "real/planner", "replanning", expected)).toContain("new plan ref");
    expect(raw).not.toContain(PLAN_PROMPT_MARKER);
    const once = withPlannerPlanPrompt(raw, "real/planner", "planning", expected);
    const twice = JSON.parse(withPlannerPlanPrompt(once, "real/planner", "planning", expected));
    expect(twice.messages.filter((message: { role: string; content: string }) => message.role === "system" && message.content.includes(PLAN_PROMPT_MARKER))).toHaveLength(1);
    expect(withPlannerPlanPrompt(raw, "real/planner", "planning", expected)).not.toContain("existing system" + PLAN_PROMPT_MARKER);
    expect(withPlannerPlanPrompt(raw, "real/planner", "planning", expected).length).toBeGreaterThan(0);
    expect(() => withPlannerPlanPrompt("{bad json", "real/planner", "planning", expected)).toThrow();
    expect(() => withPlannerPlanPrompt('{"messages":"bad"}', "real/planner", "planning", expected)).toThrow();
  });

  test("keeps a real provider 401 from marking the wrapper sign-in stale", async () => {
    const originalFetch = globalThis.fetch;
    const originalAddress = process.env.MAGPIE_ADDR;
    process.env.MAGPIE_ADDR = "127.0.0.1:3425";
    globalThis.fetch = (async () => new Response("real provider refused", { status: 401 })) as typeof fetch;
    try {
      const hooks = (await createProviderPlugin({}, base)) as any;
      const loader = hooks.auth.loader(async () => ({ type: "api", key: SERVICE_KEY }));
      const response = (await loader.fetch("http://127.0.0.1:1/v1/chat/completions", {
        method: "POST",
        headers: new Headers(),
        body: JSON.stringify({ model: "prewalk/route", messages: [] }),
      })) as Response;
      expect(response.status).toBe(401);
      expect(response.headers.get("x-magpie-sign-in")).toBe("kept");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAddress === undefined) delete process.env.MAGPIE_ADDR;
      else process.env.MAGPIE_ADDR = originalAddress;
    }
  });
});
