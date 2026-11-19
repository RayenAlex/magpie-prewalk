(function (root) {
  const MODES = ["plan_then_execute", "direct", "strong_only"];

  const MODE_LABELS = {
    plan_then_execute: "自动规划后交接",
    direct: "直接由实施模型开始",
    strong_only: "始终使用规划模型",
  };

  const PROVIDER = /^[A-Za-z0-9._-]+$/;
  const MODEL = /^[A-Za-z0-9._:@/-]+$/;

  /**
   * @param {Record<string, unknown>} options
   * @returns {{planner: string, executor: string, defaultMode: string, classifyTimeoutMs: string, healthTimeoutMs: string}}
   */
  function formOf(options) {
    return {
      planner: String(options.planner ?? ""),
      executor: String(options.executor ?? ""),
      defaultMode: String(options.defaultMode ?? "plan_then_execute"),
      classifyTimeoutMs: String(options.classifyTimeoutMs ?? 120000),
      healthTimeoutMs: String(options.healthTimeoutMs ?? 10000),
    };
  }

  /**
   * @param {unknown} value
   * @param {string} providerID
   * @returns {boolean}
   */
  function isGroupReference(value) {
    if (typeof value !== "string" || !value.startsWith("group/")) return false;
    const id = value.slice("group/".length);
    return /^[a-z0-9][a-z0-9.-]{0,62}$/.test(id) && !id.includes("..");
  }

  function isTargetReference(value, providerID) {
    return isDirectReference(value, providerID) || isGroupReference(value);
  }

  function isDirectReference(value, providerID) {
    if (typeof value !== "string" || value === "") return false;
    if (value.startsWith("group/") || value.startsWith(providerID + "/")) return false;
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1) return false;
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1);
    return (
      PROVIDER.test(provider) &&
      !provider.includes("..") &&
      MODEL.test(model) &&
      !model.includes("..") &&
      !model.startsWith("/") &&
      !model.endsWith("/")
    );
  }

  /**
   * @param {Record<string, unknown>} current
   * @param {Record<string, unknown>} form
   * @returns {{ok: true, options: Record<string, unknown>} | {ok: false, errors: Record<string, string>}}
   */
  function buildOptions(current, form) {
    const providerID = String(current.providerID ?? "prewalk");
    const planner = String(form.planner ?? "").trim();
    const executor = String(form.executor ?? "").trim();
    const defaultMode = String(form.defaultMode ?? "");
    const timeoutText = String(form.classifyTimeoutMs ?? "").trim();
    const timeout = Number(timeoutText);
    const healthTimeout = Number(String(form.healthTimeoutMs ?? current.healthTimeoutMs ?? 10000).trim());
    /** @type {Record<string, string>} */
    const errors = {};

    if (!isTargetReference(planner, providerID)) {
      errors.planner = "选择直接模型或路由组，例如 example/planner、group/example-planner；不能使用本插件入口。";
    }
    if (!isTargetReference(executor, providerID)) {
      errors.executor = "选择直接模型或路由组，例如 example/executor、group/example-executor；不能使用本插件入口。";
    }
    if (!errors.planner && !errors.executor && planner === executor) {
      errors.executor = "实施模型不能与规划模型相同。";
    }
    if (!MODES.includes(defaultMode)) {
      errors.defaultMode = "选择一种已支持的阶段模式。";
    }
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 300000) {
      errors.classifyTimeoutMs = "分类超时必须是 1000 到 300000 之间的整数毫秒。";
    }
    if (!Number.isSafeInteger(healthTimeout) || healthTimeout < 1000 || healthTimeout > 30000) {
      errors.healthTimeoutMs = "健康判断超时必须是 1000 到 30000 之间的整数毫秒。";
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };

    return {
      ok: true,
      options: {
        ...current,
        planner,
        executor,
        defaultMode,
        classifyTimeoutMs: timeout,
        healthTimeoutMs: healthTimeout,
      },
    };
  }

  /**
   * @param {unknown} day
   * @param {string} currentPlanner
   * @param {string} currentExecutor
   * @param {string} selfRef
   * @returns {string[]}
   */
  function modelsFromDay(day, currentPlanner, currentExecutor, selfRef = "") {
    const refs = new Set([currentPlanner, currentExecutor].filter((value) => typeof value === "string" && value !== "" && value !== selfRef));
    const agents = day && typeof day === "object" && Array.isArray(day.agents) ? day.agents : [];
    for (const agent of agents) {
      if (!agent || typeof agent !== "object" || !Array.isArray(agent.models)) continue;
      for (const model of agent.models) {
        if (!model || typeof model !== "object") continue;
        if (typeof model.provider !== "string" || typeof model.model !== "string") continue;
        const ref = `${model.provider}/${model.model}`;
        if (model.provider && model.model && ref !== selfRef) refs.add(ref);
      }
    }
    return [...refs].sort();
  }

  /**
   * @param {unknown} value
   * @returns {{id: string, name: string, ref: string}[]}
   */
  function groupsFromList(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.ref !== "string") continue;
      if (!item.id || !item.ref.startsWith("group/")) continue;
      out.push({ id: item.id, name: item.name, ref: item.ref });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * @param {string[]} models
   * @param {{ref?: string}[] | null | undefined} groups
   * @returns {string[]}
   */
  function targetChoices(models, groups) {
    const refs = new Set(Array.isArray(models) ? models : []);
    for (const group of groups ?? []) {
      if (group && typeof group.ref === "string" && group.ref.startsWith("group/")) refs.add(group.ref);
    }
    return [...refs].sort();
  }

  root.PrewalkPageModel = { MODES, MODE_LABELS, formOf, isDirectReference, buildOptions, modelsFromDay, groupsFromList, targetChoices };
})(typeof globalThis !== "undefined" ? globalThis : this);
