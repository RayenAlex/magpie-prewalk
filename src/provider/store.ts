// Per-session state on this machine. One file, atomic replacement, no
// symlinks, bounded sessions. Calls are serialized per session inside the
// process, which is the only writer the plugin host runs.

import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StoredState } from "./state.ts";
import { isStoredHandoff } from "./handoff.ts";

export interface StateStore {
  read(session: string): Promise<StoredState | undefined>;
  write(session: string, state: StoredState): Promise<void>;
}

const FILE = "sessions.json";
const MAX_SESSIONS = 512;
const MAX_PLAN_REF = 128;
const PHASES = new Set(["planning", "executing", "replanning", "strong_only", "blocked"]);
const MODES = new Set(["direct", "plan_then_execute", "strong_only"]);

const locks = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const guard = run.catch(() => undefined);
  locks.set(key, guard);
  try {
    return await run;
  } finally {
    if (locks.get(key) === guard) locks.delete(key);
  }
}

export function defaultStateDir(): string {
  if (process.env.PREWALK_STATE_DIR) return process.env.PREWALK_STATE_DIR;
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "magpie-prewalk");
}

function sessionKey(session: string): string {
  return Buffer.from(session, "utf8").toString("base64url");
}

function validState(value: unknown): value is StoredState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  return typeof s.phase === "string" && PHASES.has(s.phase)
    && typeof s.mode === "string" && MODES.has(s.mode)
    && typeof s.planRef === "string" && s.planRef.length <= MAX_PLAN_REF
    && num(s.planRevision) && num(s.replanCount) && num(s.stateVersion) && num(s.updatedAt)
    && (s.healthKey === undefined || (typeof s.healthKey === "string" && s.healthKey.length <= 512))
    && (s.healthVerdict === undefined || (typeof s.healthVerdict === "string" && s.healthVerdict.length <= 32))
    && (s.handoff === undefined || (isStoredHandoff(s.handoff)
      && s.handoff.package.planRef === s.planRef && s.handoff.package.planRevision === s.planRevision));
}

async function ensureDir(root: string): Promise<void> {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink()) throw new Error("state directory is a symlink");
    if (!info.isDirectory()) throw new Error("state path is not a directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  }
}

async function readAll(root: string): Promise<Record<string, StoredState>> {
  const file = join(root, FILE);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error("state file is a symlink");
  if (!info.isFile()) throw new Error("state path is not a regular file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("corrupt state file");
  }
  const document = parsed as { version?: unknown; sessions?: unknown };
  if (document?.version !== 1) throw new Error("corrupt state file");
  const sessions = document.sessions;
  if (sessions === null || typeof sessions !== "object" || Array.isArray(sessions)) {
    throw new Error("corrupt state file");
  }
  const out: Record<string, StoredState> = {};
  for (const [key, value] of Object.entries(sessions)) {
    if (!validState(value)) throw new Error("corrupt state file");
    out[key] = value;
  }
  return out;
}

async function writeAll(root: string, sessions: Record<string, StoredState>): Promise<void> {
  const file = join(root, FILE);
  const temp = join(root, `.${FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(temp, JSON.stringify({ version: 1, sessions }), { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function bounded(sessions: Record<string, StoredState>): Record<string, StoredState> {
  const entries = Object.entries(sessions);
  if (entries.length <= MAX_SESSIONS) return sessions;
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_SESSIONS));
}

export function createFileStore(root: string = defaultStateDir()): StateStore {
  return {
    async read(session: string): Promise<StoredState | undefined> {
      await ensureDir(root);
      const all = await readAll(root);
      return all[sessionKey(session)];
    },
    async write(session: string, state: StoredState): Promise<void> {
      await ensureDir(root);
      await withSessionLock("store-write", async () => {
        const all = await readAll(root);
        all[sessionKey(session)] = state;
        await writeAll(root, bounded(all));
      });
    },
  };
}
