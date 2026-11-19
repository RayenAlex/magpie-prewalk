import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../../src/provider/page/model.js";
import { parseProviderOptions } from "../../src/provider/internals.ts";

const pageModel = (globalThis as unknown as {
  PrewalkPageModel: {
    buildOptions: (
      current: Record<string, unknown>,
      form: Record<string, unknown>,
    ) => { ok: true; options: Record<string, unknown> } | { ok: false; errors: Record<string, string> };
    formOf: (options: Record<string, unknown>) => Record<string, string>;
    modelsFromDay: (day: unknown, currentPlanner: string, currentExecutor: string) => string[];
    groupsFromList: (value: unknown) => { id: string; name: string; ref: string }[];
    targetChoices: (models: string[], groups: { ref: string }[] | null) => string[];
    MODES: string[];
  };
}).PrewalkPageModel;
const { buildOptions, formOf, MODES, modelsFromDay, groupsFromList, targetChoices } = pageModel;

const root = join(import.meta.dir, "..", "..", "src", "provider");
const current = {
  providerID: "prewalk",
  modelID: "route",
  planner: "real/planner",
  executor: "real/executor",
  defaultMode: "plan_then_execute",
  classifyTimeoutMs: 10000,
  healthTimeoutMs: 10000,
  future: "kept",
};

describe("Prewalk 配置页", () => {
  test("清单声明页面与只读入口", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.magpie.page.file).toBe("page/index.html");
    expect(pkg.magpie.page.icon).toBe("page/icon.svg");
    expect(pkg.magpie.page.titles.zh).toBe("Prewalk 配置");
    expect(pkg.magpie.permissions).toEqual(["usage:day", "groups:list"]);
    expect(pkg.magpie.options.providerID).toBe("prewalk");
    expect(pkg.magpie.options.modelID).toBe("route");
  });

  test("页面通过 bridge 读写自己的 options", () => {
    const html = readFileSync(join(root, "page", "index.html"), "utf8");
    const app = readFileSync(join(root, "page", "app.js"), "utf8");
    expect(html).toContain("_magpie/bridge.js");
    expect(html).toContain('<select id="planner"');
    expect(html).toContain('<select id="executor"');
    expect(html).toContain('id="defaultMode"');
    expect(html).toContain('id="classifyTimeoutMs"');
    expect(app).toContain("magpie.options.get()");
    expect(app).toContain("magpie.options.set(");
    expect(app).toContain('magpie.read("usage:day"');
    expect(app).toContain('magpie.read("groups:list"');
    expect(html).toContain('id="groups"');
    expect(app).toContain("保存会重启插件宿主");
  });

  test("保存有冷却并在宿主重启后重新读取真实配置", () => {
    const app = readFileSync(join(root, "page", "app.js"), "utf8");
    expect(app).toContain("SAVE_COOLDOWN_MS");
    expect(app).toContain("reloadQuietly");
    expect(app).toContain("once a second");
    expect(app).toContain("await magpie.options.get()");
  });

  test("保存按钮不依赖沙箱里被阻止的表单提交", () => {
    const html = readFileSync(join(root, "page", "index.html"), "utf8");
    const app = readFileSync(join(root, "page", "app.js"), "utf8");
    // sandbox="allow-scripts" blocks a submit button's default action, so the
    // page must save from an explicit click and never rely on submit.
    expect(html).toContain('type="button" id="save"');
    expect(html).not.toContain('type="submit" id="save"');
    expect(app).toContain('$("save").addEventListener("click"');
    expect(app).not.toContain('$("form").addEventListener("submit"');
  });

  test("页面脚本不用 ES module，避免沙箱 iframe 的 CORS 拦截", () => {
    const html = readFileSync(join(root, "page", "index.html"), "utf8");
    const app = readFileSync(join(root, "page", "app.js"), "utf8");
    expect(html).not.toContain('type="module"');
    expect(html).toContain('src="model.js"');
    expect(html).toContain('src="app.js"');
    expect(app).not.toContain("import ");
    expect(app).toContain("PrewalkPageModel");
  });

  test("分类与健康期限独立读取、保存并通过宿主校验", () => {
    const legacy = { providerID: "prewalk", modelID: "route", planner: "real/planner", executor: "real/executor" };
    expect(formOf(legacy).classifyTimeoutMs).toBe("120000");
    expect(formOf(legacy).healthTimeoutMs).toBe("10000");
    expect(formOf(current).classifyTimeoutMs).toBe("10000");
    for (const timeout of [1000, 120000, 300000]) {
      const built = buildOptions(current, { ...formOf(current), classifyTimeoutMs: String(timeout), healthTimeoutMs: "1000" });
      expect(built.ok).toBe(true);
      if (built.ok) {
        const options = parseProviderOptions(built.options);
        expect(options.classifyTimeoutMs).toBe(timeout);
        expect(options.healthTimeoutMs).toBe(1000);
      }
    }
    for (const health of ["999", "30001", "1.5"]) {
      const result = buildOptions(current, { ...formOf(current), healthTimeoutMs: health });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.healthTimeoutMs).toBeTruthy();
    }
    const html = readFileSync(join(root, "page", "index.html"), "utf8");
    expect(html).toMatch(/id="classifyTimeoutMs"[^>]*max="300000"/);
    expect(html).toMatch(/id="healthTimeoutMs"[^>]*max="30000"/);
  });

  test("表单从 options 读取五项可编辑配置", () => {
    expect(formOf(current)).toEqual({
      planner: "real/planner",
      executor: "real/executor",
      defaultMode: "plan_then_execute",
      classifyTimeoutMs: "10000",
      healthTimeoutMs: "10000",
    });
    expect(MODES).toEqual(["plan_then_execute", "direct", "strong_only"]);
  });

  test("下拉候选来自当前配置和今日实际使用", () => {
    const day = {
      agents: [
        { models: [{ provider: "example-plan", model: "planner" }] },
        { models: [{ provider: "example-exec", model: "executor" }] },
        { models: [{ provider: "example-plan", model: "planner" }] },
      ],
    };
    expect(modelsFromDay(day, "example-plan/planner", "example-exec/executor")).toEqual([
      "example-exec/executor",
      "example-plan/planner",
    ]);
    expect(modelsFromDay({}, "example-plan/planner", "example-exec/executor")).toEqual([
      "example-exec/executor",
      "example-plan/planner",
    ]);
    const withSelf = {
      agents: [{ models: [{ provider: "prewalk", model: "route" }, { provider: "example-exec", model: "executor" }] }],
    };
    expect(modelsFromDay(withSelf, "example-plan/planner", "example-exec/executor", "prewalk/route")).toEqual([
      "example-exec/executor",
      "example-plan/planner",
    ]);
  });

  test("路由组列表只读渲染", () => {
    expect(groupsFromList([
      { id: "prewalk", name: "Prewalk", ref: "group/prewalk" },
      { id: "bad", name: "Bad", ref: "not-a-group" },
    ])).toEqual([{ id: "prewalk", name: "Prewalk", ref: "group/prewalk" }]);
  });

  test("保存保留未知 options 与只读入口", () => {
    const built = buildOptions(current, {
      planner: " example-plan/planner ",
      executor: "example-exec/executor",
      defaultMode: "strong_only",
      classifyTimeoutMs: "15000",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.options).toEqual({
      ...current,
      planner: "example-plan/planner",
      executor: "example-exec/executor",
      defaultMode: "strong_only",
      classifyTimeoutMs: 15000,
    });
  });

  test("拒绝无效配置", () => {
    const bad = [
      [{ planner: "", executor: "real/executor", defaultMode: "direct", classifyTimeoutMs: "10000" }, "planner"],
      [{ planner: "group/Planner", executor: "real/executor", defaultMode: "direct", classifyTimeoutMs: "10000" }, "planner"],
      [{ planner: "group/a/b", executor: "real/executor", defaultMode: "direct", classifyTimeoutMs: "10000" }, "planner"],
      [{ planner: "prewalk/route", executor: "real/executor", defaultMode: "direct", classifyTimeoutMs: "10000" }, "planner"],
      [{ planner: "real/planner", executor: "real/planner", defaultMode: "direct", classifyTimeoutMs: "10000" }, "executor"],
      [{ planner: "real/planner", executor: "real/executor", defaultMode: "sometimes", classifyTimeoutMs: "10000" }, "defaultMode"],
      [{ planner: "real/planner", executor: "real/executor", defaultMode: "direct", classifyTimeoutMs: "999" }, "classifyTimeoutMs"],
      [{ planner: "real/planner", executor: "real/executor", defaultMode: "direct", classifyTimeoutMs: "300001" }, "classifyTimeoutMs"],
      [{ planner: "real/planner", executor: "real/executor", defaultMode: "direct", classifyTimeoutMs: "1.5" }, "classifyTimeoutMs"],
      [{ planner: "real/../planner", executor: "real/executor", defaultMode: "direct", classifyTimeoutMs: "10000" }, "planner"],
    ] as const;
    for (const [form, field] of bad) {
      const built = buildOptions(current, form);
      expect(built.ok).toBe(false);
      if (built.ok) continue;
      expect(built.errors[field]).toBeTruthy();
    }
  });

  test("下拉包含路由组，保存接受组引用", () => {
    expect(targetChoices(["example-exec/executor"], [{ ref: "group/example-plan" }])).toEqual([
      "example-exec/executor",
      "group/example-plan",
    ]);
    const built = buildOptions(current, {
      planner: "group/example-plan",
      executor: "example-exec/executor",
      defaultMode: "plan_then_execute",
      classifyTimeoutMs: "10000",
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.options.planner).toBe("group/example-plan");
  });

  test("允许模型 ID 含斜杠", () => {
    const built = buildOptions(current, {
      planner: "openrouter/openai/gpt-5-image",
      executor: "real/executor",
      defaultMode: "plan_then_execute",
      classifyTimeoutMs: "10000",
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.options.planner).toBe("openrouter/openai/gpt-5-image");
  });

  test("页面保存结果通过宿主 options 合同", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(() => parseProviderOptions(pkg.magpie.options)).not.toThrow();
    const built = buildOptions(current, {
      planner: "example-plan/planner",
      executor: "example-exec/executor",
      defaultMode: "plan_then_execute",
      classifyTimeoutMs: "10000",
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(() => parseProviderOptions(built.options)).not.toThrow();
  });
});
