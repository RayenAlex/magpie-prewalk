import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore, withSessionLock } from "../../src/provider/store.ts";
import { accepted } from "./handoff-fixture.ts";

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "prewalk-store-"));
}

const sample = {
  phase: "executing" as const,
  mode: "plan_then_execute" as const,
  planRef: "plan-1",
  planRevision: 1,
  replanCount: 0,
  stateVersion: 1,
  updatedAt: 1,
};

describe("provider state store", () => {
  test("round-trips one session with strict permissions", async () => {
    const root = await dir();
    const store = createFileStore(root);
    expect(await store.read("s1")).toBeUndefined();
    await store.write("s1", sample);
    expect(await store.read("s1")).toEqual(sample);
    await store.write("s2", { ...sample, healthKey: "key-1", healthVerdict: "continue" });
    expect(await store.read("s2")).toEqual({ ...sample, healthKey: "key-1", healthVerdict: "continue" });
    const mode = (await stat(join(root, "sessions.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    const dirMode = (await stat(root)).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  test("persists a verified handoff across new store instances and rejects a tampered package", async () => {
    const root = await dir();
    const handoff = accepted();
    const state = { ...sample, handoff };
    await createFileStore(root).write("handoff", state);
    expect(await createFileStore(root).read("handoff")).toEqual(state);
    const key = Buffer.from("handoff", "utf8").toString("base64url");
    for (const broken of [
      { ...handoff, digest: "0".repeat(64) },
      { ...handoff, package: { ...handoff.package, goal: "tampered" } },
      { ...handoff, package: { ...handoff.package, planRevision: 4 } },
    ]) {
      await writeFile(join(root, "sessions.json"), JSON.stringify({ version: 1, sessions: { [key]: { ...sample, handoff: broken } } }));
      await expect(createFileStore(root).read("handoff")).rejects.toThrow("corrupt state");
    }
  });

  test("serializes concurrent updates per process", async () => {
    const root = await dir();
    let value = 0;
    await Promise.all(Array.from({ length: 32 }, () => withSessionLock("s1", async () => {
      const seen = value;
      await Promise.resolve();
      value = seen + 1;
    })));
    expect(value).toBe(32);
  });

  test("rejects a symlinked state file", async () => {
    const root = await dir();
    const target = join(root, "elsewhere.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, join(root, "sessions.json"));
    const store = createFileStore(root);
    await expect(store.read("s1")).rejects.toThrow(/symlink/);
  });

  test("rejects a corrupt state file instead of guessing", async () => {
    const root = await dir();
    await writeFile(join(root, "sessions.json"), "{not json", { mode: 0o600 });
    const store = createFileStore(root);
    await expect(store.read("s1")).rejects.toThrow(/corrupt/);
  });

  test("keeps at most 512 sessions and prunes the oldest", async () => {
    const root = await dir();
    const store = createFileStore(root);
    for (let i = 0; i < 513; i++) {
      await store.write(`s${i}`, { ...sample, updatedAt: i + 1 });
    }
    expect(await store.read("s0")).toBeUndefined();
    expect(await store.read("s512")).toEqual({ ...sample, updatedAt: 513 });
    const raw = JSON.parse(await readFile(join(root, "sessions.json"), "utf8")) as { sessions: Record<string, unknown> };
    expect(Object.keys(raw.sessions)).toHaveLength(512);
  });

  test("a session named store cannot deadlock its own write", async () => {
    const root = await dir();
    const store = createFileStore(root);
    const done = await Promise.race([
      withSessionLock("store", async () => {
        await store.write("store", sample);
        return "done";
      }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1500)),
    ]);
    expect(done).toBe("done");
  });

  test("concurrent writes for distinct sessions keep every record", async () => {
    const root = await dir();
    const store = createFileStore(root);
    await Promise.all(Array.from({ length: 32 }, (_, i) => store.write(`s${i}`, { ...sample, updatedAt: i + 1 })));
    for (let i = 0; i < 32; i++) {
      expect(await store.read(`s${i}`)).toEqual({ ...sample, updatedAt: i + 1 });
    }
  });

  test("read-advance-write transactions for one session serialize", async () => {
    const root = await dir();
    const store = createFileStore(root);
    await store.write("s1", { ...sample, stateVersion: 0 });
    await Promise.all(Array.from({ length: 16 }, () => withSessionLock("s1", async () => {
      const previous = (await store.read("s1")) ?? { ...sample, stateVersion: 0 };
      await store.write("s1", { ...previous, stateVersion: previous.stateVersion + 1 });
    })));
    const final = await store.read("s1");
    expect(final?.stateVersion).toBe(16);
  });

  test("readers never observe a partial state file while writes overlap", async () => {
    const root = await dir();
    const store = createFileStore(root);
    const readers = Array.from({ length: 40 }, async () => {
      for (let i = 0; i < 40; i++) await store.read("s0");
    });
    const writers = Array.from({ length: 20 }, (_, i) => store.write(`s${i}`, { ...sample, updatedAt: i + 1 }));
    await Promise.all([...readers, ...writers]);
    for (let i = 0; i < 20; i++) expect(await store.read(`s${i}`)).toBeDefined();
  });

  test("rejects a symlinked state directory on read and write", async () => {
    const base = await dir();
    const target = join(base, "target");
    await writeFile(join(base, "marker"), "keep", { mode: 0o600 });
    const link = join(base, "link");
    await symlink(base, link);
    const store = createFileStore(link);
    await expect(store.read("s1")).rejects.toThrow(/symlink/);
    await expect(store.write("s1", sample)).rejects.toThrow(/symlink/);
    expect(await readFile(join(base, "marker"), "utf8")).toBe("keep");
    void target;
  });

  test("rejects a symlinked state file on write without touching the target", async () => {
    const root = await dir();
    const target = join(root, "elsewhere.json");
    await writeFile(target, '{"version":1,"sessions":{}}', { mode: 0o600 });
    await symlink(target, join(root, "sessions.json"));
    const store = createFileStore(root);
    await expect(store.write("s1", sample)).rejects.toThrow(/symlink/);
    expect(await readFile(target, "utf8")).toBe('{"version":1,"sessions":{}}');
  });

  test("rejects fractional counters and missing or wrong versions", async () => {
    const root = await dir();
    const file = join(root, "sessions.json");
    const key = Buffer.from("s1", "utf8").toString("base64url");
    const bad = [
      { version: 1, sessions: { [key]: { ...sample, stateVersion: 1.5 } } },
      { sessions: { [key]: sample } },
      { version: 2, sessions: { [key]: sample } },
    ];
    for (const doc of bad) {
      await writeFile(file, JSON.stringify(doc), { mode: 0o600 });
      await expect(createFileStore(root).read("s1")).rejects.toThrow(/corrupt/);
    }
  });
});
