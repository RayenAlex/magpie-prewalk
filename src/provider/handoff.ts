// Evidence-backed Provider handoff. This reads only client-visible history;
// neither model reasoning blocks nor the client's filesystem are inspected.
import { createHash } from "node:crypto";
import type { RawHistoryBlock, RawMessage } from "../history.ts";

export const HANDOFF_MAX_BYTES = 24 * 1024;
const MAX_ITEMS = 16;
const OBSERVATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);
const WRITING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "ApplyPatch"]);
const REF = /^tool:[A-Za-z0-9._:/#@-]{1,128}$/;
const PLAN_REF = /^[A-Za-z0-9._:#-]{1,128}$/;
const UNAVAILABLE_RESULT = "[The result of this tool call is unavailable: the turn was interrupted.]";

function successfulResult(result: string): boolean {
  const value = result.trim();
  return value.length > 0 && value !== UNAVAILABLE_RESULT && !/^(?:error|failed|isError)/i.test(value);
}

export interface Evidence { ref: string; quote: string; fact: string }
export interface HandoffStep { id: string; files: string[]; action: string; evidenceRefs: string[]; doneWhen: string }
export interface HandoffPackage {
  version: 1;
  scope: string;
  stateVersion: number;
  planRevision: number;
  planRef: string;
  goal: string;
  constraints: string[];
  evidence: Evidence[];
  decisions: { choice: string; reason: string; rejected: string }[];
  steps: HandoffStep[];
  checks: { command: string; expected: string; guardsAgainst: string }[];
  completedWork: string[];
  boundaries: string[];
  blockedBy: string[];
  nextStep: string;
}
export interface StoredHandoff {
  package: HandoffPackage;
  digest: string;
  writeId: string;
  path: string;
}
export interface HandoffExpected {
  scope: string;
  stateVersion: number;
  planRevision: number;
  previousPlanRef: string;
}
export interface Mismatch { stepId: string; reason: string }
export interface EvidenceIndexEntry { ref: string; tool: string; quote: string }
export interface PlannerHandoffContext {
  index: { entries: EvidenceIndexEntry[]; omitted: number };
  feedback: {
    status: "not_submitted" | "rejected" | "ready";
    reason: string;
    issues: string[];
    path: string;
    repair: string;
  };
}
export type HandoffResult = { ok: true; value: StoredHandoff } | { ok: false; reason: string };
interface Observation {
  use: RawHistoryBlock;
  index: number;
  result: string;
  ok: boolean;
  complete: boolean;
  successfulGroup: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function keys(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
function text(value: unknown, max = 2048): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
}
function integer(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}
function list(value: unknown, check: (item: unknown) => boolean, min = 1): value is unknown[] {
  return Array.isArray(value) && value.length >= min && value.length <= MAX_ITEMS && value.every(check);
}
function filePath(value: unknown): value is string {
  return text(value, 1024) && !/[\x00-\x1f]/.test(value)
    && !value.replaceAll("\\", "/").split("/").some((part) => part === ".." || part === ".");
}
function evidenceItem(value: unknown): value is Evidence {
  const e = object(value);
  return !!e && keys(e, ["ref", "quote", "fact"]) && typeof e.ref === "string" && REF.test(e.ref)
    && text(e.quote, 512) && text(e.fact);
}
function stepItem(value: unknown): value is HandoffStep {
  const s = object(value);
  return !!s && keys(s, ["id", "files", "action", "evidenceRefs", "doneWhen"])
    && text(s.id, 64) && /^[A-Za-z0-9._:-]+$/.test(s.id)
    && list(s.files, filePath) && text(s.action) && text(s.doneWhen)
    && list(s.evidenceRefs, (ref) => typeof ref === "string" && REF.test(ref));
}
function strings(value: unknown, min = 1): value is string[] {
  return list(value, (item) => text(item), min);
}

export function parseHandoff(value: unknown): HandoffPackage | undefined {
  const p = object(value);
  if (!p || !keys(p, ["version", "scope", "stateVersion", "planRevision", "planRef", "goal", "constraints", "evidence", "decisions", "steps", "checks", "completedWork", "boundaries", "blockedBy", "nextStep"])) return;
  if (p.version !== 1 || typeof p.scope !== "string" || !/^[a-f0-9]{64}$/.test(p.scope)
    || !integer(p.stateVersion) || !integer(p.planRevision, 1)
    || typeof p.planRef !== "string" || !PLAN_REF.test(p.planRef) || !text(p.goal)) return;
  if (!strings(p.constraints) || !strings(p.completedWork, 0) || !strings(p.boundaries)
    || !Array.isArray(p.blockedBy) || p.blockedBy.length !== 0) return;
  if (!list(p.evidence, evidenceItem) || !list(p.steps, stepItem)) return;
  if (!list(p.decisions, (item) => {
    const d = object(item);
    return !!d && keys(d, ["choice", "reason", "rejected"]) && text(d.choice) && text(d.reason) && text(d.rejected);
  })) return;
  if (!list(p.checks, (item) => {
    const c = object(item);
    return !!c && keys(c, ["command", "expected", "guardsAgainst"]) && text(c.command) && text(c.expected) && text(c.guardsAgainst);
  })) return;
  const evidence = p.evidence as unknown as Evidence[];
  const steps = p.steps as unknown as HandoffStep[];
  const refs = new Set(evidence.map((e) => e.ref));
  if (refs.size !== evidence.length || new Set(steps.map((s) => s.id)).size !== steps.length
    || !steps.every((s) => s.evidenceRefs.every((ref) => refs.has(ref)))
    || !steps.some((s) => s.id === p.nextStep)) return;
  if (Buffer.byteLength(JSON.stringify(p), "utf8") > HANDOFF_MAX_BYTES) return;
  return p as unknown as HandoffPackage;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = object(value);
  if (obj) return "{" + Object.keys(obj).sort().map((key) => JSON.stringify(key) + ":" + canonical(obj[key])).join(",") + "}";
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function handoffScope(session: string, options: { providerID: string; modelID: string; planner: string; executor: string }): string {
  return createHash("sha256").update(JSON.stringify([session, options.providerID, options.modelID, options.planner, options.executor])).digest("hex");
}
export function handoffPath(scope: string, revision: number): string {
  return `.prewalk/handoff-${scope.slice(0, 16)}-r${revision}.json`;
}
function toolPath(input: Record<string, unknown> | undefined): unknown {
  return input?.file_path ?? input?.path ?? input?.notebook_path;
}
function matchesPath(path: unknown, scope: string, revision: number): path is string {
  if (!filePath(path)) return false;
  const normalized = path.replaceAll("\\", "/");
  const suffix = handoffPath(scope, revision);
  return normalized === suffix || normalized.endsWith("/" + suffix);
}

function observations(raw: readonly RawMessage[]): Observation[] {
  const counts = new Map<string, number>();
  for (const message of raw) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const use of message.content.filter((b) => b.type === "tool_use")) {
      counts.set(use.id ?? "", (counts.get(use.id ?? "") ?? 0) + 1);
    }
  }
  const out: Observation[] = [];
  for (const [index, message] of raw.entries()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const uses = message.content.filter((b) => b.type === "tool_use");
    const next = raw[index + 1];
    const results = next?.role === "user" && Array.isArray(next.content)
      ? next.content.filter((b) => b.type === "tool_result") : [];
    const complete = uses.length > 0 && results.length === uses.length && uses.every((u) =>
      !!u.id && counts.get(u.id) === 1 && results.filter((r) => r.tool_use_id === u.id).length === 1);
    const successfulGroup = complete && results.every((r) => successfulResult(r.text ?? ""));
    for (const use of uses) {
      const found = results.find((r) => r.tool_use_id === use.id);
      const result = found?.text ?? "";
      out.push({ use, index, result, ok: !!found && successfulResult(result), complete, successfulGroup });
    }
  }
  return out;
}
function latestPlan(raw: readonly RawMessage[]): { ref: string; index: number } {
  let found = { ref: "", index: -1 };
  for (const [index, message] of raw.entries()) {
    if (message.role !== "assistant") continue;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type !== "text" || typeof block.text !== "string") continue;
      const matches = [...block.text.matchAll(/^prewalk plan:([A-Za-z0-9._:#-]{1,128})[ \t]*$/gm)];
      for (const match of matches) found = { ref: match[1], index };
    }
  }
  return found;
}
function evidenceMatches(evidence: readonly { ref: string; quote: string }[], seen: Observation[], before: number, after = -1): boolean {
  return evidence.every((e) => seen.some((o) => `tool:${o.use.id}` === e.ref && o.complete
    && o.index > after && o.index < before && OBSERVATION_TOOLS.has(o.use.name ?? "")
    && o.result.length > 0 && o.result.includes(e.quote)));
}

export function findHandoff(raw: readonly RawMessage[], expected: HandoffExpected): HandoffResult {
  const seen = observations(raw);
  const candidates = seen.filter((o) => o.use.name === "Write"
    && matchesPath(toolPath(o.use.input), expected.scope, expected.planRevision));
  const write = candidates.at(-1);
  if (!write) return { ok: false, reason: "handoff_missing" };
  if (!write.successfulGroup) return { ok: false, reason: "handoff_write_incomplete" };
  const content = write.use.input?.content;
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > HANDOFF_MAX_BYTES) return { ok: false, reason: "handoff_invalid" };
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return { ok: false, reason: "handoff_invalid" }; }
  const packet = parseHandoff(parsed);
  if (!packet || packet.scope !== expected.scope || packet.stateVersion !== expected.stateVersion
    || packet.planRevision !== expected.planRevision || packet.planRef === expected.previousPlanRef) return { ok: false, reason: "handoff_binding" };
  const plan = latestPlan(raw);
  if (plan.ref !== packet.planRef || plan.index > write.index) return { ok: false, reason: "handoff_plan_mismatch" };
  if (!evidenceMatches(packet.evidence, seen, write.index)
    || !packet.evidence.every((e) => seen.some((o) => `tool:${o.use.id}` === e.ref && o.ok))) return { ok: false, reason: "handoff_evidence" };
  const path = String(toolPath(write.use.input));
  if (seen.some((o) => o !== write && o.index >= write.index && WRITING_TOOLS.has(o.use.name ?? "")
    && matchesPath(toolPath(o.use.input), packet.scope, packet.planRevision))) return { ok: false, reason: "handoff_changed" };
  return { ok: true, value: { package: packet, digest: digest(packet), writeId: write.use.id!, path } };
}

const INDEX_MAX_BYTES = 12 * 1024;

function referenceOf(observation: Observation): string {
  return `tool:${observation.use.id ?? ""}`;
}

function eligibleObservation(observation: Observation): boolean {
  return observation.complete && observation.ok
    && OBSERVATION_TOOLS.has(observation.use.name ?? "") && REF.test(referenceOf(observation));
}

function evidenceIndex(seen: readonly Observation[]): PlannerHandoffContext["index"] {
  const eligible = seen.filter(eligibleObservation);
  const entries: EvidenceIndexEntry[] = [];
  for (const observation of eligible.toReversed()) {
    if (entries.length === MAX_ITEMS) break;
    // Trim only the selection window, not the observed text: the resulting
    // quote must remain an exact nonempty substring accepted by the gate.
    const quote = observation.result.trimStart().split(/[\r\n\0]/, 1)[0].slice(0, 512);
    if (!text(quote, 512)) continue;
    const entry = { ref: referenceOf(observation), tool: observation.use.name!, quote };
    const next = { entries: [...entries, entry], omitted: eligible.length - entries.length - 1 };
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > INDEX_MAX_BYTES) continue;
    entries.push(entry);
  }
  return { entries, omitted: eligible.length - entries.length };
}

function packageIssues(write: Observation | undefined, seen: readonly Observation[], expected: HandoffExpected): string[] {
  const content = write?.use.input?.content;
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > HANDOFF_MAX_BYTES) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return ["invalid_package_json"]; }
  const value = object(parsed);
  if (!value) return ["invalid_package_schema"];
  const issues = new Set<string>();
  if (!parseHandoff(value)) issues.add("invalid_package_schema");
  if (value.scope !== expected.scope) issues.add("scope_mismatch");
  if (value.stateVersion !== expected.stateVersion) issues.add("state_version_mismatch");
  if (value.planRevision !== expected.planRevision) issues.add("plan_revision_mismatch");
  if (value.planRef === expected.previousPlanRef) issues.add("plan_ref_reused");
  const evidence = Array.isArray(value.evidence) ? value.evidence.map(object).filter((e) => e !== undefined) : [];
  const refs = evidence.map((e) => e.ref);
  if (new Set(refs).size !== refs.length) issues.add("duplicate_evidence_refs");
  for (const item of evidence) {
    const observed = seen.find((o) => eligibleObservation(o) && referenceOf(o) === item.ref && o.index < write!.index);
    if (!observed) issues.add("unknown_evidence_refs");
    else if (typeof item.quote !== "string" || !observed.result.includes(item.quote)) issues.add("quote_mismatch");
  }
  return [...issues];
}

const REPAIRS: Record<string, string> = {
  handoff_missing: "Finish investigation, then Write the complete package at the supplied path. Do not make a business edit to trigger handoff.",
  handoff_write_incomplete: "The package Write or its parallel tool group lacks a successful complete result. Resolve that result before retrying; never invent success.",
  handoff_invalid: "Write valid JSON within the size limit and exact package schema; do not include extra fields.",
  handoff_binding: "Use the current binding and exact schema. Copy distinct real ref values and verbatim quotes from the evidence index, not tool names. Match each step evidenceRefs to package evidence.",
  handoff_plan_mismatch: "Use one matching planRef for the visible marker and package. Write it after the marker, and do not emit a new marker after that Write.",
  handoff_evidence: "Copy distinct real refs and exact quote substrings from successful observations before the package Write; tool names are not refs.",
  handoff_changed: "The package file was modified after or alongside its Write. Rewrite one complete stable package with current binding; do not edit it in parallel.",
};

// Both feedback and index come from the same history/validation as the gate.
// A diagnostic never authorizes handoff or rewrites an invalid package.
export function plannerHandoffContext(raw: readonly RawMessage[], expected: HandoffExpected): PlannerHandoffContext {
  const seen = observations(raw);
  const checked = findHandoff(raw, expected);
  const write = seen.filter((o) => o.use.name === "Write"
    && matchesPath(toolPath(o.use.input), expected.scope, expected.planRevision)).at(-1);
  const reason = checked.ok ? "handoff_ready" : checked.reason;
  return {
    index: evidenceIndex(seen),
    feedback: {
      status: checked.ok ? "ready" : write ? "rejected" : "not_submitted",
      reason,
      issues: checked.ok ? [] : packageIssues(write, seen, expected),
      path: handoffPath(expected.scope, expected.planRevision),
      repair: checked.ok ? "The package is accepted; continue only under the selected stage contract."
        : REPAIRS[reason] ?? "Keep planning under the current binding; do not invent evidence or bypass validation.",
    },
  };
}

export function isStoredHandoff(value: unknown): value is StoredHandoff {
  const stored = object(value);
  if (!stored || !keys(stored, ["package", "digest", "writeId", "path"])) return false;
  const packet = parseHandoff(stored.package);
  return !!packet && typeof stored.digest === "string" && stored.digest === digest(packet)
    && text(stored.writeId, 128) && matchesPath(stored.path, packet.scope, packet.planRevision);
}
export function handoffStatus(raw: readonly RawMessage[], stored: StoredHandoff): string {
  if (!isStoredHandoff(stored)) return "handoff_invalid";
  const p = stored.package;
  const checked = findHandoff(raw, { scope: p.scope, stateVersion: p.stateVersion, planRevision: p.planRevision, previousPlanRef: "" });
  if (!checked.ok) return checked.reason;
  return checked.value.digest === stored.digest && checked.value.writeId === stored.writeId
    ? "ok" : "handoff_changed";
}

export function findMismatch(raw: readonly RawMessage[], stored: StoredHandoff): Mismatch | undefined {
  const seen = observations(raw);
  const write = seen.find((o) => o.use.id === stored.writeId);
  if (!write) return;
  const p = stored.package;
  let found: Mismatch | undefined;
  for (const [index, message] of raw.entries()) {
    if (message.role !== "assistant" || index <= write.index) continue;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type !== "text" || typeof block.text !== "string" || block.text.length > 4096) continue;
      const prefix = `prewalk mismatch:${p.planRef}\n`;
      if (!block.text.startsWith(prefix)) continue;
      let value: unknown;
      try { value = JSON.parse(block.text.slice(prefix.length)); } catch { continue; }
      const signal = object(value);
      if (!signal || !keys(signal, ["version", "scope", "planRevision", "stepId", "reason", "evidence"])
        || signal.version !== 1 || signal.scope !== p.scope || signal.planRevision !== p.planRevision
        || !p.steps.some((step) => step.id === signal.stepId) || !text(signal.reason)
        || !list(signal.evidence, (e) => {
          const item = object(e);
          return !!item && keys(item, ["ref", "quote"]) && typeof item.ref === "string" && REF.test(item.ref) && text(item.quote, 512);
        })) continue;
      if (!evidenceMatches(signal.evidence as { ref: string; quote: string }[], seen, index, write.index)) continue;
      found = { stepId: String(signal.stepId), reason: signal.reason };
    }
  }
  return found;
}
