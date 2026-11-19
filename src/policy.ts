// The prewalk policy: one pure `onRoute(snapshot)` step, no I/O. The host
// reads the state and history, asks the judgment model at most once, and
// validates every proposal before it becomes routing. Everything here is a
// decision over the snapshot only; unknown or incomplete input keeps the
// strong model.

import { judgmentRequest, type QuestionKind } from "./judgment";

export type Phase = "planning" | "executing" | "replanning" | "strong_only" | "blocked";
export type Mode = "direct" | "plan_then_execute" | "strong_only";

export type Reason =
  | "plan_pending"
  | "handoff_ready"
  | "executing"
  | "replan"
  | "strong_only"
  | "task_uncertain"
  | "history_unknown"
  | "plan_missing"
  | "tool_group_incomplete"
  | "external_block"
  | "replan_limit"
  | "state_unavailable"
  | "policy_unavailable";

export interface StateView {
  status: "ok" | "missing" | "unknown";
  phase?: Phase;
  mode?: Mode;
  stateVersion?: string;
  planRef?: string;
  planRevision?: string;
  replanCount?: string;
}

export interface ToolResult {
  id: string;
  ok: boolean;
}

export interface ToolGroup {
  id: string;
  tools: string[];
  results: ToolResult[];
  complete: boolean;
}

export interface HistoryView {
  status: "ok" | "incomplete" | "unknown";
  reason?: string;
  planRef?: string;
  toolGroups?: ToolGroup[];
}

export interface JudgmentView {
  kind: string;
  verdict: string;
  templateVersion: string;
  evidence?: string;
  reason?: string;
}

export interface Snapshot {
  contract: string;
  entry: string;
  state: StateView;
  history: HistoryView;
  judgment?: JudgmentView;
}

// The host fills versions, timestamps and process identity; the policy only
// names the fields it decides.
export interface StatePatch {
  phase: Phase;
  mode: Mode;
  planRef: string;
  planRevision: number;
  replanCount: number;
  reasonCode: string;
}

export type Decision =
  | { action: "keep"; reason: Reason }
  | { action: "judge"; reason: Reason; question: QuestionKind; templateVersion: number; evidence: string[] }
  | { action: "propose"; targetRole: "planner" | "executor"; reason: Reason; nextState: StatePatch; expectedVersion: number }
  | { action: "block"; reason: Reason };

export const MAX_REPLANS = 2;

function count(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function keep(reason: Reason): Decision {
  return { action: "keep", reason };
}

function judge(kind: QuestionKind, evidence: readonly string[], reason: Reason): Decision {
  return { action: "judge", reason, ...judgmentRequest(kind, evidence) };
}

function propose(
  targetRole: "planner" | "executor",
  reason: Reason,
  nextState: StatePatch,
  expectedVersion: number,
): Decision {
  return { action: "propose", targetRole, reason, nextState, expectedVersion };
}

function patch(phase: Phase, mode: Mode, reasonCode: string, fields: Partial<StatePatch> = {}): StatePatch {
  return {
    phase,
    mode,
    planRef: "",
    planRevision: 0,
    replanCount: 0,
    reasonCode,
    ...fields,
  };
}

// evidenceRefs names the failed groups a judgment may cite; bounded so the
// host's reference check and the judgment view stay small.
function hasRealWrite(groups: readonly ToolGroup[]): boolean {
  return groups.some((group) => group.afterPlan && group.complete && group.results.length > 0 && group.results.every((result) => result.ok));
}

function evidenceRefs(groups: readonly ToolGroup[]): string[] {
  const refs: string[] = [];
  for (const group of groups) {
    if (group.complete && group.results.every((r) => r.ok)) continue;
    refs.push(`group:${group.id}`);
    if (refs.length === 8) break;
  }
  return refs.length > 0 ? refs : ["history:0"];
}

export function onRoute(snapshot: Snapshot): Decision {
  if (snapshot.contract !== "route-v1") return keep("policy_unavailable");
  const state = snapshot.state ?? { status: "unknown" };
  if (state.status === "unknown") return keep("state_unavailable");
  if (snapshot.history.status !== "ok") return keep("history_unknown");

  // A task already judged continuously complex is not argued down each turn.
  if (state.status === "ok" && (state.phase === "strong_only" || state.mode === "strong_only")) {
    return keep("strong_only");
  }
  const judged = snapshot.judgment;

  if (state.status === "missing") {
    if (!judged || judged.kind !== "task_route") return judge("task_route", ["history:0"], "task_uncertain");
    switch (judged.verdict) {
      case "direct":
        return propose("executor", "handoff_ready", patch("executing", "direct", "handoff_ready"), 0);
      case "plan_then_execute":
        return propose("planner", "plan_pending", patch("planning", "plan_then_execute", "plan_pending"), 0);
      case "strong_only":
        return propose("planner", "strong_only", patch("strong_only", "strong_only", "strong_only"), 0);
      default:
        return propose("planner", "task_uncertain", patch("strong_only", "strong_only", "strong_only"), 0);
    }
  }

  const version = count(state.stateVersion);
  switch (state.phase) {
    case "planning": {
      const planRef = snapshot.history.planRef ?? "";
      if (!planRef) return keep("plan_missing");
      if (!hasRealWrite(snapshot.history.toolGroups ?? [])) return keep("tool_group_incomplete");
      return propose(
        "executor",
        "handoff_ready",
        patch("executing", "plan_then_execute", "handoff_ready", {
          planRef,
          planRevision: count(state.planRevision) + 1,
          replanCount: count(state.replanCount),
        }),
        version,
      );
    }
    case "executing": {
      const groups = snapshot.history.toolGroups ?? [];
      // Only failures after the current plan are new evidence; an old failure
      // already handled by a replan must not spend the budget again. Without
      // a plan marker (direct mode) every group is current.
      const relevant = (snapshot.history.planRef ?? "") ? groups.filter((group) => group.afterPlan) : groups;
      // A parallel group answered only in part proves nothing: keep strong
      // rather than read the missing half as success.
      if (relevant.some((g) => !g.complete)) return keep("tool_group_incomplete");
      const failed = relevant.some((g) => g.results.some((r) => !r.ok));
      if (!failed) return keep("executing");
      if (!judged || judged.kind !== "execution_health") {
        return judge("execution_health", evidenceRefs(groups), "replan");
      }
      switch (judged.verdict) {
        case "continue":
          return keep("executing");
        case "external_block":
          return propose("planner", "external_block", patch("blocked", state.mode ?? "plan_then_execute", "external_block", { planRef: state.planRef ?? "", planRevision: count(state.planRevision), replanCount: count(state.replanCount) }), version);
        case "replan": {
          const used = count(state.replanCount);
          if (used >= MAX_REPLANS) {
            return propose("planner", "replan_limit", patch("blocked", state.mode ?? "plan_then_execute", "replan_limit", { planRef: state.planRef ?? "", planRevision: count(state.planRevision), replanCount: used }), version);
          }
          return propose(
            "planner",
            "replan",
            patch("replanning", "plan_then_execute", "replan", {
              planRef: state.planRef ?? "",
              planRevision: count(state.planRevision),
              replanCount: used + 1,
            }),
            version,
          );
        }
        default:
          return keep("task_uncertain");
      }
    }
    case "replanning": {
      const planRef = snapshot.history.planRef ?? "";
      // A new plan must replace the old one; the old plan and its tool
      // results never authorize the next handoff.
      if (!planRef || planRef === (state.planRef ?? "")) return keep("plan_missing");
      if (!hasRealWrite(snapshot.history.toolGroups ?? [])) return keep("tool_group_incomplete");
      return propose(
        "executor",
        "handoff_ready",
        patch("executing", "plan_then_execute", "handoff_ready", {
          planRef,
          planRevision: count(state.planRevision) + 1,
          replanCount: count(state.replanCount),
        }),
        version,
      );
    }
    case "blocked":
      return keep("external_block");
    default:
      return keep("policy_unavailable");
  }
}
