// Structured history view given to the policy. The host decides what is
// observable; the policy never reads the raw transcript itself.

export type WriteKind = "edit" | "write" | "todo" | "readonly" | "virtual" | "bash_string";

export interface ToolUse {
  id: string;
  name: string;
  writeKind?: WriteKind;
}

export interface ObservedResult {
  id: string;
  ok: boolean;
}

export interface RawHistoryBlock {
  type: string;
  id?: string;
  name?: string;
  text?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
}

export interface RawMessage {
  role: "user" | "assistant";
  content: string | RawHistoryBlock[];
}

export interface HistoryView {
  status: "ok" | "incomplete" | "unknown";
  reason?: string;
  planRef?: string;
  toolGroups?: Array<{
    id: string;
    tools: string[];
    results: Array<{ id: string; ok: boolean }>;
    complete: boolean;
  }>;
}

const PLAN_MARK = "prewalk plan:";
const REAL_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "ApplyPatch"]);
const READONLY_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "TodoWrite", "Task"]);

function planInfo(messages: readonly RawMessage[]): { ref: string; index: number } {
  let found = "";
  let index = -1;
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    // A plan is a public assistant text block carrying a stable ref; a
    // TodoWrite tool_use alone is never a plan.
    const blocks = typeof message.content === "string" ? [{ text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type !== "text" || typeof block.text !== "string") continue;
      const markAt = block.text.indexOf(PLAN_MARK);
      if (markAt < 0) continue;
      const ref = block.text.slice(markAt + PLAN_MARK.length).trim().split(/\s/, 1)[0];
      if (/^(?:plan:)?[A-Za-z0-9._:#-]{1,128}$/.test(ref)) {
        found = ref;
        index = messageIndex;
      }
    }
  }
  return { ref: found, index };
}

function writeKindOf(name: string, input: Record<string, unknown>): WriteKind {
  if (REAL_WRITE_TOOLS.has(name)) return name === "Write" ? "write" : "edit";
  if (name === "TodoWrite") return "todo";
  if (name === "Bash") return "bash_string";
  if (READONLY_TOOLS.has(name)) return "readonly";
  if (name.startsWith("mcp__") || name.includes("virtual")) return "virtual";
  // A tool we do not recognize may still write a file; never count it as
  // proof of a real edit merely because its input has a file path.
  return input.file_path !== undefined || input.path !== undefined ? "virtual" : "readonly";
}

// buildHistory turns paired tool_use/tool_result groups into the bounded view
// the policy sees. A group is complete only when every use has its own result;
// only a successful, recognized file action can make a group a real edit.
export function buildHistory(messages: readonly RawMessage[]): HistoryView {
  const groups: HistoryView["toolGroups"] = [];
  const plan = planInfo(messages);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    const uses = message.content.filter((block) => block.type === "tool_use");
    if (uses.length === 0) continue;
    if (i + 1 >= messages.length || messages[i + 1].role !== "user") {
      return { status: "incomplete", reason: "tool_group_incomplete" };
    }
    const next = messages[i + 1].content;
    const results = typeof next === "string"
      ? []
      : next.filter((block) => block.type === "tool_result").map((block) => ({
          id: block.tool_use_id ?? "",
          ok: block.text === undefined || !/^(?:error|failed|isError)/i.test(block.text.trim()),
        }));
    const byID = new Map(results.map((result) => [result.id, result]));
    const observed: ObservedResult[] = [];
    const tools: string[] = [];
    let complete = true;
    let realWrite = false;
    let failed = false;
    for (const use of uses) {
      const id = use.id ?? "";
      const result = byID.get(id);
      if (!result) {
        complete = false;
        continue;
      }
      observed.push(result);
      tools.push(use.name ?? "");
      const kind = writeKindOf(use.name ?? "", use.input ?? {});
      if (result.ok && (kind === "edit" || kind === "write")) realWrite = true;
      if (!result.ok) failed = true;
    }
    // An incomplete group is kept visible: the policy must see the missing
    // result. A fully answered readonly/unknown group proves no real write.
    if (!complete || realWrite || failed) {
      groups.push({
        id: `group:${uses[0].id ?? "0"}`,
        tools,
        results: observed,
        complete,
        afterPlan: plan.index >= 0 && i >= plan.index,
      });
    }
  }
  const incomplete = groups.some((group) => !group.complete);
  return {
    status: incomplete ? "incomplete" : "ok",
    reason: incomplete ? "tool_group_incomplete" : undefined,
    planRef: plan.ref,
    toolGroups: groups,
  };
}
