import { expect, test } from "bun:test";
import { classifyTask, judgeExecutionHealth } from "../../src/provider/classifier.ts";

interface PendingTimer {
  at: number;
  run: () => void;
}

// Keep fake global timers in their own process; other suites exercise real
// cancellation and disk I/O and must not inherit this virtual clock.
class DeadlineClock {
  now = 0;
  private nextID = 0;
  private readonly pending = new Map<number, PendingTimer>();
  private readonly originalSet = globalThis.setTimeout;
  private readonly originalClear = globalThis.clearTimeout;

  install(): void {
    globalThis.setTimeout = ((run: () => void, delay = 0) => {
      const id = ++this.nextID;
      this.pending.set(id, { at: this.now + delay, run });
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => this.pending.delete(id)) as unknown as typeof clearTimeout;
  }

  async advance(milliseconds: number): Promise<void> {
    const until = this.now + milliseconds;
    while (true) {
      const next = [...this.pending.entries()].filter(([, timer]) => timer.at <= until)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.pending.delete(next[0]);
      next[1].run();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
    this.now = until;
  }

  restore(): void {
    globalThis.setTimeout = this.originalSet;
    globalThis.clearTimeout = this.originalClear;
  }
}

function completion(verdict: string, evidence = ["history:0"]): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify({ templateVersion: 1, verdict, evidence }) } }] });
}

function delayedFetch(delay: number, verdict: string, evidence?: string[]): {
  fetch: typeof fetch;
  signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) throw new Error("missing deadline signal");
    signals.push(signal);
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(completion(verdict, evidence)), delay);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  }) as typeof globalThis.fetch;
  return { fetch, signals };
}

const input = {
  address: "http://127.0.0.1:3425/v1/chat/completions",
  credential: "synthetic-timeout-key",
  planner: "real/planner",
  body: { messages: [{ role: "user", content: "Refactor the event bus" }] },
};

async function isolated(run: () => Promise<void>): Promise<void> {
  if (process.env.PREWALK_ISOLATED_TIMEOUT_TEST !== "1") {
    const child = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      env: { ...process.env, PREWALK_ISOLATED_TIMEOUT_TEST: "1" }, stdout: "pipe", stderr: "pipe",
    });
    if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    expect(child.exitCode).toBe(0);
    return;
  }
  await run();
}

test("slow classification respects the configured deadline without extending health checks", async () => {
  await isolated(async () => {
    const clock = new DeadlineClock();
    clock.install();
    try {
      const slow = delayedFetch(45_000, "plan_then_execute");
      const result = classifyTask({ ...input, fetchImpl: slow.fetch });
      await clock.advance(10_000);
      expect(slow.signals).toHaveLength(1);
      expect(slow.signals[0].aborted).toBe(false);
      await clock.advance(35_000);
      expect(await result).toBe("plan_then_execute");

      const configured = delayedFetch(90_000, "direct");
      const configuredResult = classifyTask({ ...input, timeoutMs: 120_000, fetchImpl: configured.fetch });
      await clock.advance(30_000);
      expect(configured.signals[0].aborted).toBe(false);
      await clock.advance(60_000);
      expect(await configuredResult).toBe("direct");

      const timeout = delayedFetch(180_000, "direct");
      const timeoutResult = classifyTask({ ...input, fetchImpl: timeout.fetch });
      await clock.advance(119_999);
      expect(timeout.signals[0].aborted).toBe(false);
      await clock.advance(1);
      expect(await timeoutResult).toBe("strong_only");
      expect(timeout.signals[0].aborted).toBe(true);
      expect(timeout.signals).toHaveLength(1);

      const upper = delayedFetch(400_000, "direct");
      const upperResult = classifyTask({ ...input, timeoutMs: 900_000, fetchImpl: upper.fetch });
      await clock.advance(299_999);
      expect(upper.signals[0].aborted).toBe(false);
      await clock.advance(1);
      expect(await upperResult).toBe("strong_only");
      expect(upper.signals[0].aborted).toBe(true);

      // Headers alone do not finish classification: the deadline must also
      // cancel a response whose JSON body never completes.
      const bodySignals: AbortSignal[] = [];
      const stalledBody = (async (_url: unknown, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing response deadline signal");
        bodySignals.push(signal);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
          },
        });
        return new Response(stream, { headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const bodyResult = classifyTask({ ...input, fetchImpl: stalledBody });
      await clock.advance(119_999);
      expect(bodySignals[0].aborted).toBe(false);
      await clock.advance(1);
      expect(await bodyResult).toBe("strong_only");
      expect(bodySignals[0].aborted).toBe(true);

      const explicitOld = delayedFetch(45_000, "direct");
      const oldResult = classifyTask({ ...input, timeoutMs: 10_000, fetchImpl: explicitOld.fetch });
      await clock.advance(10_000);
      expect(await oldResult).toBe("strong_only");
      expect(explicitOld.signals[0].aborted).toBe(true);

      const cancelled = delayedFetch(90_000, "direct");
      const parent = new AbortController();
      const cancelledResult = classifyTask({ ...input, fetchImpl: cancelled.fetch, signal: parent.signal });
      await clock.advance(15_000);
      parent.abort();
      expect(await cancelledResult).toBe("strong_only");
      expect(cancelled.signals[0].aborted).toBe(true);
      expect(cancelled.signals).toHaveLength(1);

      const health = delayedFetch(45_000, "continue", ["group:group:t1"]);
      const healthResult = judgeExecutionHealth({
        ...input, fetchImpl: health.fetch, evidence: ["group:group:t1"],
        body: { messages: [
          { role: "user", content: "task" },
          { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "Edit", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "t1", content: "Error: failed" },
        ] },
      });
      await clock.advance(9_999);
      expect(health.signals[0].aborted).toBe(false);
      await clock.advance(1);
      expect(await healthResult).toBe("replan");
      expect(health.signals[0].aborted).toBe(true);
    } finally {
      clock.restore();
    }
  });
});
