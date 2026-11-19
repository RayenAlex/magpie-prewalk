import type { DefaultMode } from "./state.ts";
import { plannerHandoffContext, type HandoffExpected, type StoredHandoff } from "./handoff.ts";
import { chatToRaw } from "./state.ts";
import { EXECUTION_PROMPT_MARKER, executionContract, overlay, planningContract } from "./prompts.ts";

export interface ProviderOptions {
  providerID: string;
  modelID: string;
  planner: string;
  executor: string;
  defaultMode: DefaultMode;
  classifyTimeoutMs: number;
  healthTimeoutMs: number;
}

export interface ProviderCredential {
  type?: string;
  key?: string;
}

export interface FetchOptions {
  method?: string;
  headers?: Headers;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
}

export interface ProviderHooks {
  config: (config: { provider?: Record<string, unknown> }) => Promise<void>;
  auth: {
    provider: string;
    single: true;
    methods: { type: "api"; label: string }[];
    loader: (
      getAuth: () => Promise<ProviderCredential>,
      provider: unknown,
    ) => { apiKey: string; baseURL: string; fetch: (url: string | URL, init: FetchOptions) => Promise<Response> };
  };
}

export const GATEWAY_KEY_PREFIX = "sk-magpie-key-";
export const WRAPPER_PROTOCOL = "@ai-sdk/openai-compatible";
export const PLAN_PROMPT_MARKER = "Prewalk plan marker";
export type PlanningPhase = "planning" | "replanning";

export const DEFAULT_OPTIONS: ProviderOptions = {
  providerID: "prewalk",
  modelID: "route",
  planner: "real/planner",
  executor: "real/executor",
  defaultMode: "plan_then_execute",
  classifyTimeoutMs: 120000,
  healthTimeoutMs: 10000,
};

const DEFAULT_MODES = new Set(["direct", "plan_then_execute", "strong_only"]);

// Provider IDs contain no slash; model IDs may contain more (namespaced
// upstream ids such as openrouter/openai/gpt-5-image).
function isGroupReference(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("group/")) return false;
  const id = value.slice("group/".length);
  return /^[a-z0-9][a-z0-9.-]{0,62}$/.test(id) && !id.includes("..");
}

function isDirectReference(value: unknown, providerID: string): value is string {
  if (typeof value !== "string" || value.startsWith("group/") || value.startsWith(providerID + "/")) {
    return false;
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  return (
    /^[A-Za-z0-9._-]+$/.test(provider) &&
    !provider.includes("..") &&
    /^[A-Za-z0-9._:@/-]+$/.test(model) &&
    !model.includes("..") &&
    !model.startsWith("/") &&
    !model.endsWith("/")
  );
}

function isTargetReference(value: unknown, providerID: string): value is string {
  return isDirectReference(value, providerID) || isGroupReference(value);
}

export function targetLoops(target: string, providerID: string, modelID: string, inbound?: Headers): boolean {
  if (target === `${providerID}/${modelID}` || target.startsWith(`${providerID}/`)) return true;
  return Boolean(inbound?.get("x-prewalk-via"));
}

export function parseProviderOptions(input: Record<string, unknown>): ProviderOptions {
  const providerID = input.providerID;
  const modelID = input.modelID;
  if (
    typeof providerID !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,39}$/.test(providerID) ||
    typeof modelID !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(modelID)
  ) {
    throw new Error("invalid prewalk provider/model id");
  }
  if (!isTargetReference(input.planner, providerID) || !isTargetReference(input.executor, providerID)) {
    throw new Error("planner and executor must be direct provider/model references or routing groups");
  }
  if (input.planner === input.executor) {
    throw new Error("planner and executor must not be the same model");
  }
  const defaultMode = input.defaultMode ?? "plan_then_execute";
  if (typeof defaultMode !== "string" || !DEFAULT_MODES.has(defaultMode)) {
    throw new Error("defaultMode must be direct, plan_then_execute or strong_only");
  }
  const classifyTimeoutMs = input.classifyTimeoutMs ?? DEFAULT_OPTIONS.classifyTimeoutMs;
  if (typeof classifyTimeoutMs !== "number" || !Number.isSafeInteger(classifyTimeoutMs) || classifyTimeoutMs < 1000 || classifyTimeoutMs > 300000) {
    throw new Error("classifyTimeoutMs must be an integer between 1000 and 300000");
  }
  const healthTimeoutMs = input.healthTimeoutMs ?? DEFAULT_OPTIONS.healthTimeoutMs;
  if (typeof healthTimeoutMs !== "number" || !Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs < 1000 || healthTimeoutMs > 30000) {
    throw new Error("healthTimeoutMs must be an integer between 1000 and 30000");
  }
  return {
    providerID,
    modelID,
    planner: input.planner,
    executor: input.executor,
    defaultMode: defaultMode as DefaultMode,
    classifyTimeoutMs,
    healthTimeoutMs,
  };
}

export function resolveTarget(options: ProviderOptions, phase: "strong" | "weak"): string {
  if (phase === "strong") return options.planner;
  if (phase === "weak") return options.executor;
  throw new Error("unsupported prewalk phase");
}

export function isServiceCredential(value: ProviderCredential | undefined): value is { type: "api"; key: string } {
  return value?.type === "api" && typeof value.key === "string" && value.key.startsWith(GATEWAY_KEY_PREFIX);
}

export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { type: "auth_error", message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function innerAddress(): string {
  const address = process.env.MAGPIE_ADDR;
  return address ? "http://" + address + "/v1/chat/completions" : "";
}

export function forwardedBody(raw: string | null | undefined, target: string): string {
  let body: Record<string, unknown> = {};
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid provider request body");
    }
    body = { ...(parsed as Record<string, unknown>) };
  }
  body.model = target;
  return JSON.stringify(body);
}

export function withExecutionContract(raw: string, target: string, handoff: StoredHandoff): string {
  return overlay(raw, target, EXECUTION_PROMPT_MARKER, executionContract(handoff));
}

export function withPlannerPlanPrompt(raw: string, target: string, phase?: PlanningPhase, binding?: HandoffExpected): string {
  if (!phase) return forwardedBody(raw, target);
  if (!binding) throw new Error("handoff binding required");
  const history = chatToRaw(JSON.parse(raw));
  if (!history) throw new Error("invalid planner history");
  const context = plannerHandoffContext(history, binding);
  return overlay(raw, target, PLAN_PROMPT_MARKER, planningContract(PLAN_PROMPT_MARKER, binding, context));
}
