// magpie's provider host treats every exported function of a plugin module as
// a plugin entry (servers()). This module therefore exports only the default
// plugin function; pure helpers live in ./internals.ts, which tests import.

import {
  DEFAULT_OPTIONS,
  WRAPPER_PROTOCOL,
  forwardedBody,
  innerAddress,
  isServiceCredential,
  jsonError,
  parseProviderOptions,
  targetLoops,
  withPlannerPlanPrompt,
  withExecutionContract,
  type FetchOptions,
  type ProviderCredential,
  type ProviderOptions,
} from "./internals";
import { advance, chatToRaw, failureEvidence, healthCacheKey } from "./state.ts";
import { classifyTask, judgeExecutionHealth } from "./classifier.ts";
import { MAX_REPLANS } from "../policy.ts";
import { createHash } from "node:crypto";
import { createFileStore, withSessionLock, type StateStore } from "./store.ts";
import { findMismatch, handoffScope, handoffStatus, type HandoffExpected, type StoredHandoff } from "./handoff.ts";

const SESSION_HEADER = "x-magpie-session";
const GROUP_VIA_SESSION = "prewalk-via";
const SESSION_SHAPE = /^[\x20-\x7E]{1,128}$/;

let sharedStore: StateStore | undefined;

function stateStore(): StateStore {
  sharedStore ??= createFileStore();
  return sharedStore;
}

function sessionOf(headers: unknown): string {
  const value = new Headers(headers as HeadersInit | undefined).get(SESSION_HEADER) ?? "";
  return SESSION_SHAPE.test(value) ? value : "";
}

interface ClassifyContext {
  address: string;
  credential: string;
  signal?: AbortSignal | null;
}

interface HealthJudgment {
  verdict: string;
  key: string;
}

interface TargetSelection {
  target: "planner" | "executor";
  phase?: "planning" | "replanning";
  binding?: HandoffExpected;
  handoff?: StoredHandoff;
}

async function healthVerdictFor(
  session: string,
  previous: import("./state.ts").StoredState | undefined,
  body: unknown,
  options: ProviderOptions,
  context: ClassifyContext,
): Promise<HealthJudgment | undefined> {
  if (!previous || previous.phase !== "executing" || previous.replanCount >= MAX_REPLANS) return undefined;
  if (previous.mode === "plan_then_execute") {
    const raw = chatToRaw(body);
    if (!raw || !previous.handoff || previous.handoff.package.scope !== handoffScope(session, options)
      || handoffStatus(raw, previous.handoff) !== "ok" || findMismatch(raw, previous.handoff)) return undefined;
  }
  const evidence = failureEvidence(body);
  if (evidence.length === 0) return undefined;
  // Excess or unrepresentable evidence cannot safely authorize executor.
  if (evidence.length > 8 || evidence.some((ref) => !/^[A-Za-z0-9._:/#@-]{1,128}$/.test(ref))) {
    return { verdict: "replan", key: "" };
  }
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const key = healthCacheKey(session, previous.stateVersion, options.planner, evidence, digest);
  // The verdict is stored with the session, so a restart reuses it; a new
  // state version or request changes the key and forces a fresh judgment.
  if (previous.healthKey === key && typeof previous.healthVerdict === "string") {
    return { verdict: previous.healthVerdict, key };
  }
  const verdict = await judgeExecutionHealth({
    address: context.address,
    credential: context.credential,
    planner: options.planner,
    body,
    evidence,
    signal: context.signal,
    timeoutMs: options.healthTimeoutMs,
  });
  if (context.signal?.aborted) return undefined;
  return { verdict, key };
}

async function selectTarget(session: string, body: unknown, options: ProviderOptions, context: ClassifyContext): Promise<TargetSelection> {
  if (!session) return { target: "planner" };
  try {
    return await withSessionLock(`session:${session}`, async () => {
      const store = stateStore();
      const previous = await store.read(session);
      let mode = options.defaultMode;
      // Explicit direct/strong_only are administrator overrides; the default
      // plan_then_execute enables one bounded classification per new session.
      // A body the history adapter cannot parse never classifies or persists.
      if (!previous && options.defaultMode === "plan_then_execute" && chatToRaw(body) !== null) {
        mode = await classifyTask({
          address: context.address,
          credential: context.credential,
          planner: options.planner,
          body,
          signal: context.signal,
          timeoutMs: options.classifyTimeoutMs,
        });
        // A cancelled request must not advance or persist session state.
        if (context.signal?.aborted) return { target: "planner" };
      }
      const health = await healthVerdictFor(session, previous, body, options, context);
      if (context.signal?.aborted) return { target: "planner" };
      const scope = handoffScope(session, options);
      const next = advance(previous, body, mode, Date.now(), health?.verdict, scope);
      let stored = next.state;
      let dirty = next.changed;
      if (health && health.key) {
        if (stored.healthKey !== health.key || stored.healthVerdict !== health.verdict) {
          stored = { ...stored, healthKey: health.key, healthVerdict: health.verdict, updatedAt: Date.now() };
          dirty = true;
        }
      }
      if (context.signal?.aborted) return { target: "planner" };
      if (dirty) await store.write(session, stored);
      const phase = next.target === "planner" && (stored.phase === "planning" || stored.phase === "replanning") ? stored.phase : undefined;
      const binding = phase ? { scope, stateVersion: stored.stateVersion, planRevision: stored.planRevision + 1, previousPlanRef: stored.planRef } : undefined;
      return { target: next.target, phase, binding,
        ...(next.target === "executor" && stored.handoff ? { handoff: stored.handoff } : {}) };
    });
  } catch {
    // Unreadable or corrupt state keeps the strong model and writes nothing.
    return { target: "planner" };
  }
}

export default async function createProviderPlugin(
  _input: unknown,
  raw: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  // host.js calls fn(input, p.options): the second argument is the saved
  // options object itself, not the plugins.json entry. A freshly added
  // package may be loaded before any options are saved.
  const options = raw !== undefined && raw !== null && Object.keys(raw).length > 0
    ? parseProviderOptions(raw)
    : parseProviderOptions(DEFAULT_OPTIONS);
  return {
    config: async (config: { provider?: Record<string, unknown> }) => {
      const providers = { ...(config.provider ?? {}) };
      providers[options.providerID] = {
        name: "Prewalk provider",
        npm: WRAPPER_PROTOCOL,
        api: "http://127.0.0.1:1/v1",
        models: {
          [options.modelID]: { name: "Prewalk route" },
        },
      };
      config.provider = providers;
    },
    auth: {
      provider: options.providerID,
      single: true,
      methods: [{ type: "api", label: "Prewalk service key" }],
      loader: (getAuth: () => Promise<ProviderCredential>) => ({
        apiKey: "unused",
        baseURL: "http://127.0.0.1:1/v1",
        fetch: async (_url: string | URL, init: FetchOptions) => {
          const credential = await getAuth();
          if (!isServiceCredential(credential)) {
            return jsonError(403, "prewalk needs an explicit gateway service key");
          }
          const address = innerAddress();
          if (!address) return jsonError(503, "prewalk gateway address is unavailable");
          if (typeof init.body !== "string" || init.body.length === 0) {
            return jsonError(400, "prewalk received an invalid request body");
          }
          if (sessionOf(init.headers) === GROUP_VIA_SESSION) {
            return jsonError(403, "prewalk cannot target itself");
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(init.body);
          } catch {
            return jsonError(400, "prewalk received an invalid request body");
          }
          const selected = await selectTarget(sessionOf(init.headers), parsed, options, {
            address,
            credential: credential.key,
            signal: init.signal,
          });
          const target = selected.target === "executor" ? options.executor : options.planner;
          if (targetLoops(target, options.providerID, options.modelID, init.headers)) {
            return jsonError(403, "prewalk cannot target itself");
          }
          let body: string;
          try {
            body = selected.target === "planner"
              ? withPlannerPlanPrompt(init.body as string, target, selected.phase, selected.binding)
              : selected.handoff ? withExecutionContract(init.body as string, target, selected.handoff)
              : forwardedBody(init.body as string, target);
          } catch {
            return jsonError(400, "prewalk received an invalid request body");
          }
          const headers = new Headers({
            "content-type": "application/json",
            authorization: `Bearer ${credential.key}`,
            "x-magpie-page-port": "1",
            "x-magpie-response-model": "vendor",
            "x-prewalk-via": "1",
            ...(target.startsWith("group/") ? { "x-session-id": GROUP_VIA_SESSION } : {}),
          });
          let response = await globalThis.fetch(address, {
            method: "POST",
            headers,
            body,
            signal: init.signal ?? undefined,
            redirect: "error",
          });
          if (response.status === 401) {
            const kept = new Headers(response.headers);
            kept.set("x-magpie-sign-in", "kept");
            response = new Response(response.body, { status: response.status, headers: kept });
          }
          return response;
        },
      }),
    },
  };
}
