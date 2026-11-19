// Fixed judgment questions and the strict answer schema they are read with.
// The host validates the same things on its side; this copy lets the policy
// and its tests agree on the exact contract without guessing.

export const JUDGMENT_TEMPLATE_VERSION = 1;
export const MAX_EVIDENCE = 8;

export type QuestionKind =
  | "task_route"
  | "handoff_readiness"
  | "execution_health"
  | "replan_readiness";

export const VERDICTS: Record<QuestionKind, readonly string[]> = {
  task_route: ["direct", "plan_then_execute", "strong_only", "uncertain"],
  handoff_readiness: ["ready", "not_ready", "strong_only", "uncertain"],
  execution_health: ["continue", "replan", "external_block", "uncertain"],
  replan_readiness: ["ready", "not_ready", "strong_only", "uncertain"],
};

export type JudgmentAnswer = {
  templateVersion: number;
  verdict: string;
  evidence: string[];
  reason?: string;
};

export type JudgmentCheck =
  | { ok: true; answer: JudgmentAnswer }
  | { ok: false; why: string };

const REF: RegExp = /^[A-Za-z0-9._:/#@-]{1,128}$/;

// checkAnswer mirrors the host's strict parse: a known question, the exact
// template version, an in-enum verdict, evidence only among the refs the
// policy supplied, and proof for ready/replan.
export function checkAnswer(
  kind: QuestionKind,
  text: string,
  refs: readonly string[],
  maxBytes = 8 << 10,
): JudgmentCheck {
  if (text.length > maxBytes) return { ok: false, why: "answer too large" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, why: "not JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, why: "not an object" };
  }
  const answer = value as Record<string, unknown>;
  const allowedKeys = new Set(["templateVersion", "verdict", "evidence", "reason"]);
  for (const key of Object.keys(answer)) {
    if (!allowedKeys.has(key)) return { ok: false, why: `unexpected field ${key}` };
  }
  if (answer.templateVersion !== JUDGMENT_TEMPLATE_VERSION) {
    return { ok: false, why: "template version" };
  }
  if (typeof answer.verdict !== "string" || !VERDICTS[kind].includes(answer.verdict)) {
    return { ok: false, why: "verdict" };
  }
  const evidence = answer.evidence === undefined ? [] : answer.evidence;
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) {
    return { ok: false, why: "evidence" };
  }
  const supplied = new Set(refs);
  for (const ref of evidence) {
    if (typeof ref !== "string" || !REF.test(ref) || !supplied.has(ref)) {
      return { ok: false, why: "evidence ref" };
    }
  }
  const reason = answer.reason === undefined ? "" : answer.reason;
  if (typeof reason !== "string" || reason.length > 512) {
    return { ok: false, why: "reason" };
  }
  if ((answer.verdict === "ready" || answer.verdict === "replan") && evidence.length === 0) {
    return { ok: false, why: "proof missing" };
  }
  return {
    ok: true,
    answer: {
      templateVersion: JUDGMENT_TEMPLATE_VERSION,
      verdict: answer.verdict,
      evidence: evidence as string[],
      reason,
    },
  };
}

export function judgmentRequest(
  kind: QuestionKind,
  evidence: readonly string[],
): { question: QuestionKind; templateVersion: number; evidence: string[] } {
  return {
    question: kind,
    templateVersion: JUDGMENT_TEMPLATE_VERSION,
    evidence: evidence.slice(0, MAX_EVIDENCE),
  };
}
