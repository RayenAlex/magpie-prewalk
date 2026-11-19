// One bounded task_route judgment per new session, sent to the planner under
// the same restricted service identity. Any failure keeps the strong model.

import { checkAnswer } from "../judgment.ts";
import { chatToRaw, type DefaultMode } from "./state.ts";

export interface ClassifyInput {
  address: string;
  credential: string;
  planner: string;
  body: unknown;
  signal?: AbortSignal | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_TASK = 4000;
const DEFAULT_CLASSIFY_TIMEOUT_MS = 120_000;
const MAX_CLASSIFY_TIMEOUT_MS = 300_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const MAX_HEALTH_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1000;

const SYSTEM_PROMPT = [
  "You classify a coding task for routing. Reply with JSON only, no prose:",
  '{"templateVersion":1,"verdict":"direct|plan_then_execute|strong_only|uncertain","evidence":["history:0"],"reason":"short"}',
  "direct: trivial, safe for a weak model. plan_then_execute: needs a strong plan first.",
  "strong_only: difficulty spans the whole task. uncertain: not enough evidence.",
].join("\n");

function taskText(body: unknown): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "";
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "";
  let text = "";
  for (const message of messages) {
    if (message !== null && typeof message === "object" && !Array.isArray(message)) {
      const item = message as { role?: unknown; content?: unknown };
      if (item.role === "user" && typeof item.content === "string") text = item.content;
    }
  }
  return text.slice(0, MAX_TASK);
}

function verdictOf(payload: unknown): DefaultMode {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "strong_only";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "strong_only";
  const first = choices[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) return "strong_only";
  const message = (first as { message?: unknown }).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return "strong_only";
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") return "strong_only";
  let answer: unknown;
  try {
    answer = JSON.parse(content);
  } catch {
    return "strong_only";
  }
  // The matrix requires every field; an absent evidence array is not a
  // silently empty one.
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return "strong_only";
  if (!Array.isArray((answer as { evidence?: unknown }).evidence)) return "strong_only";
  const checked = checkAnswer("task_route", content, ["history:0"]);
  if (!checked.ok) return "strong_only";
  const verdict = checked.answer.verdict;
  if (verdict === "direct" || verdict === "plan_then_execute" || verdict === "strong_only") return verdict;
  return "strong_only";
}

export interface HealthInput {
  address: string;
  credential: string;
  planner: string;
  body: unknown;
  evidence: string[];
  signal?: AbortSignal | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const HEALTH_SYSTEM_PROMPT = [
  "You judge whether a failed execution needs a new plan. Reply with JSON only:",
  '{"templateVersion":1,"verdict":"continue|replan|external_block|uncertain","evidence":["<supplied ref>"],"reason":"short"}',
  "continue: ordinary error, keep executing. replan: the plan failed; cite evidence.",
  "external_block: blocked by an external resource. uncertain: not enough evidence.",
].join("\n");

const REDACTIONS: [RegExp, string][] = [
  [/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[redacted]"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(?:ghp_|gho_|ghs_|ghu_|github_pat_)[A-Za-z0-9_]{8,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{12,}/g, "[redacted]"],
  [/\b(api[_-]?key|password|passwd|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]"],
];

// Best effort only: unknown credential shapes still pass through.
function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.slice(0, 512);
}

// Only failed tool results explicitly referenced by this judgment are included.
// Tool outputs can contain sensitive project data: they are sent to planner
// under the existing service identity, not logged by this plugin.
function failureSummaries(body: unknown, evidence: readonly string[]): { ref: string; text: string }[] {
  const raw = chatToRaw(body);
  if (!raw) return [];
  const wanted = new Set(evidence);
  const byRef = new Map<string, string>();
  for (let i = 0; i + 1 < raw.length; i++) {
    const message = raw[i];
    const next = raw[i + 1];
    if (message.role !== "assistant" || !Array.isArray(message.content) || next.role !== "user" || !Array.isArray(next.content)) continue;
    const uses = message.content.filter((item) => item.type === "tool_use");
    if (uses.length === 0) continue;
    const ref = `group:group:${uses[0].id ?? ""}`;
    if (!wanted.has(ref)) continue;
    const ids = new Set(uses.map((item) => item.id));
    const failed = next.content.filter((item) => item.type === "tool_result" && ids.has(item.tool_use_id) && typeof item.text === "string" && /^(?:error|failed|isError)/i.test(item.text.trim()));
    if (failed.length === 0) continue;
    // The same reference can repeat across plans; the newest failure wins.
    byRef.set(ref, redact(failed.map((item) => item.text).join("\n")));
  }
  return Array.from(byRef, ([ref, text]) => ({ ref, text })).slice(0, 8);
}

// judgeExecutionHealth returns the raw verdict; any failure conservatively
// returns "replan" so the caller keeps the strong model.
export async function judgeExecutionHealth(input: HealthInput): Promise<string> {
  if (input.signal?.aborted) return "replan";
  const failures = failureSummaries(input.body, input.evidence);
  if (failures.length !== input.evidence.length) return "replan";
  const requested = input.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const timeoutMs = Math.min(MAX_HEALTH_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, requested));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort);
  try {
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(input.address, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.credential}`,
        "x-magpie-page-port": "1",
        "x-magpie-response-model": "vendor",
      },
      body: JSON.stringify({
        model: input.planner,
        stream: false,
        max_tokens: 256,
        messages: [
          { role: "system", content: HEALTH_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              question: "execution_health",
              templateVersion: 1,
              evidence: input.evidence.slice(0, 8),
              failures,
            }),
          },
        ],
      }),
      signal: controller.signal,
      redirect: "error",
    });
    if (response.status !== 200) return "replan";
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      return "replan";
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "replan";
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return "replan";
    const first = choices[0];
    if (first === null || typeof first !== "object" || Array.isArray(first)) return "replan";
    const message = (first as { message?: unknown }).message;
    if (message === null || typeof message !== "object" || Array.isArray(message)) return "replan";
    const content = (message as { content?: unknown }).content;
    if (typeof content !== "string") return "replan";
    const checked = checkAnswer("execution_health", content, input.evidence);
    if (!checked.ok) return "replan";
    return checked.answer.verdict;
  } catch {
    return "replan";
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export async function classifyTask(input: ClassifyInput): Promise<DefaultMode> {
  if (input.signal?.aborted) return "strong_only";
  const requested = input.timeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS;
  const timeoutMs = Math.min(MAX_CLASSIFY_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, requested));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort);
  try {
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(input.address, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.credential}`,
        "x-magpie-page-port": "1",
        "x-magpie-response-model": "vendor",
      },
      body: JSON.stringify({
        model: input.planner,
        stream: false,
        max_tokens: 256,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              question: "task_route",
              templateVersion: 1,
              evidence: ["history:0"],
              task: taskText(input.body),
            }),
          },
        ],
      }),
      signal: controller.signal,
      redirect: "error",
    });
    if (response.status !== 200) return "strong_only";
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      return "strong_only";
    }
    return verdictOf(payload);
  } catch {
    return "strong_only";
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
