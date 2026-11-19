// Adapts a translated Chat request body to the existing history/policy
// modules. The policy stays the only place that decides phases; this file
// supplies observable history and deterministic judgments (no model call).

import { buildHistory, type RawHistoryBlock, type RawMessage } from "../history.ts";
import { MAX_REPLANS, onRoute, type Mode, type Phase, type Snapshot, type StateView } from "../policy.ts";
import { findHandoff, findMismatch, handoffStatus, type StoredHandoff } from "./handoff.ts";

export type DefaultMode = "direct" | "plan_then_execute" | "strong_only";

export interface StoredState {
  phase: Phase;
  mode: Mode;
  planRef: string;
  planRevision: number;
  replanCount: number;
  stateVersion: number;
  updatedAt: number;
  healthKey?: string;
  healthVerdict?: string;
  handoff?: StoredHandoff;
}

export interface AdvanceResult {
  target: "planner" | "executor";
  reason: string;
  state: StoredState;
  changed: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolContent(content: unknown, commandStatus = false): { text: string; failed: boolean } {
  if (typeof content === "string") {
    const trimmed = content.trim();
    // Messages-to-Chat conversion may omit is_error. Only recognize the
    // complete command-status header, not an arbitrary mention in output.
    const exit = /^Exit code ([+-]?\d+)[ \t]*(?:\r?\n|$)/.exec(trimmed);
    const commandFailed = commandStatus && exit !== null && !/^[+-]?0+$/.test(exit[1]);
    const toolError = /^<tool_use_error>[\s\S]*<\/tool_use_error>$/.test(trimmed);
    if (/^(?:error|failed|isError)/i.test(trimmed) || commandFailed || toolError) {
      return { text: content, failed: true };
    }
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const obj = record(parsed);
        if (obj && (obj.is_error === true || obj.ok === false || obj.error !== undefined)) {
          return { text: content, failed: true };
        }
      } catch { /* not JSON; fall through */ }
    }
    return { text: content, failed: false };
  }
  if (content === null || content === undefined) return { text: "", failed: false };
  if (Array.isArray(content)) {
    const parts = content.map((part) => toolContent(part, commandStatus));
    return { text: parts.map((part) => part.text).join("\n"), failed: parts.some((part) => part.failed) };
  }
  const value = record(content);
  if (value && (value.is_error === true || value.ok === false || value.error !== undefined)) {
    return { text: JSON.stringify(content), failed: true };
  }
  if (value?.type === "text" && typeof value.text === "string") {
    return toolContent(value.text, commandStatus);
  }
  return { text: JSON.stringify(content), failed: false };
}

// chatToRaw keeps only the blocks history.ts understands. Unknown shapes are
// rejected as a whole: a partial transcript could fake a completed tool group.
export function chatToRaw(input: unknown): RawMessage[] | null {
  const body = record(input);
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const out: RawMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const raw of messages) {
    const message = record(raw);
    if (!message) return null;
    // System/developer instructions are not tool history; skipping them keeps
    // ordinary Chat bodies parseable instead of failing closed every turn.
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "user") {
      if (typeof message.content !== "string") return null;
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: RawHistoryBlock[] = [];
      if (typeof message.content === "string" && message.content.length > 0) {
        blocks.push({ type: "text", text: message.content });
      }
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls)) return null;
        const ids = new Set<string>();
        for (const call of message.tool_calls) {
          const item = record(call);
          const fn = record(item?.function);
          if (!item || !fn || typeof fn.name !== "string") return null;
          const id = String(item.id ?? "");
          // A missing or repeated id lets one result prove two calls.
          if (!id || ids.has(id)) return null;
          ids.add(id);
          toolNames.set(id, fn.name);
          let args: unknown = {};
          try {
            args = JSON.parse(typeof fn.arguments === "string" ? fn.arguments : "{}");
          } catch {
            return null;
          }
          if (args === null || typeof args !== "object" || Array.isArray(args)) args = {};
          blocks.push({
            type: "tool_use",
            id,
            name: fn.name,
            input: args as Record<string, unknown>,
          });
        }
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (message.role === "tool") {
      const id = String(message.tool_call_id ?? "");
      if (!id) return null;
      // File/search output may legitimately quote an exit-status header.
      // Apply this fallback only to a known command tool, using its real ID.
      const content = toolContent(message.content, toolNames.get(id) === "Bash");
      const failed = message.is_error === true || content.failed;
      const block: RawHistoryBlock = {
        type: "tool_result",
        tool_use_id: id,
        text: failed ? `Error: ${content.text}` : content.text,
      };
      const last = out[out.length - 1];
      const results = last && last.role === "user" && Array.isArray(last.content)
        && last.content.every((part) => part.type === "tool_result");
      if (results) {
        (last.content as RawHistoryBlock[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    return null;
  }
  return out;
}

function fallback(prev: StoredState | undefined, mode: DefaultMode, reason: string): AdvanceResult {
  return {
    target: "planner",
    reason,
    state: prev ?? {
      phase: "planning",
      mode,
      planRef: "",
      planRevision: 0,
      replanCount: 0,
      stateVersion: 0,
      updatedAt: 0,
    },
    changed: false,
  };
}

function view(state: StoredState): StateView {
  return {
    status: "ok",
    phase: state.phase,
    mode: state.mode,
    stateVersion: String(state.stateVersion),
    planRef: state.planRef,
    planRevision: String(state.planRevision),
    replanCount: String(state.replanCount),
  };
}

export function failureEvidence(body: unknown): string[] {
  const raw = chatToRaw(body);
  if (!raw) return [];
  let history;
  try {
    history = buildHistory(raw);
  } catch {
    return [];
  }
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const group of history.toolGroups ?? []) {
    if (history.planRef && !group.afterPlan) continue;
    if (!group.results.some((result) => !result.ok)) continue;
    const ref = `group:${group.id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

export function healthCacheKey(
  session: string,
  stateVersion: number,
  planner: string,
  evidence: readonly string[],
  digest: string,
): string {
  return JSON.stringify([session, stateVersion, planner, evidence, digest]);
}

export function advance(
  prev: StoredState | undefined,
  body: unknown,
  defaultMode: DefaultMode,
  now: number = Date.now(),
  healthVerdict?: string,
  scope: string = "",
): AdvanceResult {
  const raw = chatToRaw(body);
  if (!raw) return fallback(prev, defaultMode, "policy_unavailable");
  let history;
  try {
    history = buildHistory(raw);
  } catch {
    return fallback(prev, defaultMode, "policy_unavailable");
  }
  let readyHandoff: StoredHandoff | undefined;
  if (prev && history.status === "ok" && prev.phase === "executing" && prev.mode === "plan_then_execute") {
    const stored = prev.handoff;
    if (!scope || !stored || stored.package.scope !== scope || stored.package.planRef !== prev.planRef
      || stored.package.planRevision !== prev.planRevision || history.planRef !== stored.package.planRef
      || handoffStatus(raw, stored) !== "ok") {
      // Old/incompatible execution records have no verified implementation
      // package. Return to planning without spending the replan budget.
      const { handoff: _handoff, healthKey: _key, healthVerdict: _verdict, ...safe } = prev;
      return { target: "planner", reason: "handoff_required", changed: true,
        state: { ...safe, phase: "planning", stateVersion: prev.stateVersion + 1, updatedAt: now } };
    }
    if (findMismatch(raw, stored)) {
      const blocked = prev.replanCount >= MAX_REPLANS;
      return { target: "planner", reason: blocked ? "replan_limit" : "plan_mismatch", changed: true,
        state: { phase: blocked ? "blocked" : "replanning", mode: "plan_then_execute", planRef: prev.planRef,
          planRevision: prev.planRevision, replanCount: prev.replanCount + (blocked ? 0 : 1),
          stateVersion: prev.stateVersion + 1, updatedAt: now } };
    }
  }
  if (prev && history.status === "ok" && (prev.phase === "planning" || prev.phase === "replanning")) {
    const candidate = findHandoff(raw, { scope, stateVersion: prev.stateVersion,
      planRevision: prev.planRevision + 1, previousPlanRef: prev.planRef });
    if (!scope || !candidate.ok) return fallback(prev, defaultMode, candidate.ok ? "handoff_scope_missing" : candidate.reason);
    if (candidate.value.package.planRef !== history.planRef) return fallback(prev, defaultMode, "handoff_plan_mismatch");
    readyHandoff = candidate.value;
  }
  const state: StateView = prev ? view(prev) : { status: "missing" };
  const snapshot: Snapshot = {
    contract: "route-v1",
    entry: "provider/prewalk",
    state,
    history,
  };
  if (!prev) {
    snapshot.judgment = { kind: "task_route", verdict: defaultMode, templateVersion: "1" };
  } else if (prev.phase === "executing") {
    // A supplied health verdict decides continue/replan/external_block; any
    // other value (including uncertain or a failed judgment) replans.
    const verdict = healthVerdict === "continue" || healthVerdict === "external_block" ? healthVerdict : "replan";
    snapshot.judgment = { kind: "execution_health", verdict, templateVersion: "1" };
  }

  const decision = onRoute(snapshot);
  if (decision.action === "propose") {
    if (prev && decision.expectedVersion !== prev.stateVersion) {
      return fallback(prev, defaultMode, "state_unavailable");
    }
    const next: StoredState = {
      phase: decision.nextState.phase,
      mode: decision.nextState.mode,
      planRef: decision.nextState.planRef,
      planRevision: decision.nextState.planRevision,
      replanCount: decision.nextState.replanCount,
      stateVersion: (prev?.stateVersion ?? 0) + 1,
      updatedAt: now,
      ...(readyHandoff && decision.targetRole === "executor" ? { handoff: readyHandoff } : {}),
    };
    return { target: decision.targetRole, reason: decision.reason, state: next, changed: true };
  }
  if (decision.action === "keep" && prev) {
    const target = decision.reason === "executing" && prev.phase === "executing" && prev.mode !== "strong_only"
      ? "executor"
      : "planner";
    return { target, reason: decision.reason, state: prev, changed: false };
  }
  return fallback(prev, defaultMode, decision.reason);
}
