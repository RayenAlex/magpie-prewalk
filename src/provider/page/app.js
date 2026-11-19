(function () {
  const { buildOptions, formOf, modelsFromDay, groupsFromList, targetChoices } = globalThis.PrewalkPageModel;
  const $ = (id) => document.getElementById(id);
  let current = {};
  let models = [];

  function setStatus(message, kind = "") {
    const status = $("status");
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function clearErrors() {
    for (const field of ["planner", "executor", "defaultMode", "classifyTimeoutMs", "healthTimeoutMs"]) {
      const input = $(field);
      input.removeAttribute("aria-invalid");
      const error = document.querySelector(`[data-error="${field}"]`);
      if (error) error.textContent = "";
    }
  }

  function showErrors(errors) {
    for (const [field, message] of Object.entries(errors)) {
      const input = $(field);
      if (input) input.setAttribute("aria-invalid", "true");
      const error = document.querySelector(`[data-error="${field}"]`);
      if (error) error.textContent = message;
    }
  }

  function fillSelect(id, value, refs) {
    const select = $(id);
    const values = [...new Set([value, ...refs].filter((ref) => typeof ref === "string" && ref !== ""))].sort();
    select.replaceChildren(...values.map((ref) => {
      const option = document.createElement("option");
      option.value = ref;
      option.textContent = ref;
      return option;
    }));
    select.value = value;
  }

  function fill(options, refs) {
    current = options;
    const form = formOf(options);
    $("entry").textContent = `${options.providerID}/${options.modelID}`;
    fillSelect("planner", form.planner, refs);
    fillSelect("executor", form.executor, refs);
    $("defaultMode").value = form.defaultMode;
    $("classifyTimeoutMs").value = form.classifyTimeoutMs;
    $("healthTimeoutMs").value = form.healthTimeoutMs;
    const selected = $("defaultMode").selectedOptions[0];
    $("modeBadge").textContent = selected ? selected.textContent : form.defaultMode;
    clearErrors();
  }

  async function loadModels(options) {
    const fallback = [options.planner, options.executor].filter((ref) => typeof ref === "string" && ref !== "");
    try {
      const day = await magpie.read("usage:day", {});
      return modelsFromDay(day, options.planner, options.executor, `${options.providerID}/${options.modelID}`);
    } catch {
      return [...new Set(fallback)].sort();
    }
  }

  async function loadGroups() {
    try {
      return groupsFromList(await magpie.read("groups:list", {}));
    } catch {
      return null;
    }
  }

  function renderGroups(groups) {
    const card = $("groupsCard");
    const list = $("groups");
    list.replaceChildren();
    card.hidden = false;
    if (groups === null) {
      const item = document.createElement("li");
      item.textContent = "宿主未提供 groups:list；更新到带组列表读取的版本后显示。";
      list.append(item);
      return;
    }
    if (groups.length === 0) {
      const item = document.createElement("li");
      item.textContent = "没有可读取的路由组。";
      list.append(item);
      return;
    }
    for (const group of groups) {
      const item = document.createElement("li");
      item.textContent = `${group.name} (${group.ref})`;
      list.append(item);
    }
  }

  function readForm() {
    return {
      planner: $("planner").value,
      executor: $("executor").value,
      defaultMode: $("defaultMode").value,
      classifyTimeoutMs: $("classifyTimeoutMs").value,
      healthTimeoutMs: $("healthTimeoutMs").value,
    };
  }

  function setBusy(busy) {
    $("save").disabled = busy;
    $("reload").disabled = busy;
    $("form").setAttribute("aria-busy", String(busy));
  }

  async function load() {
    setBusy(true);
    setStatus("");
    try {
      await magpie.ready;
      const options = await magpie.options.get();
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new Error("没有收到插件配置；请在 magpie 窗口的 Plugins 分组中打开此页");
      }
      const [modelList, groups] = await Promise.all([loadModels(options), loadGroups()]);
      models = targetChoices(modelList, groups);
      fill(options, models);
      renderGroups(groups);
      $("loading").hidden = true;
      $("form").hidden = false;
    } catch (error) {
      $("loading").textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
      setStatus("读取失败。请在 magpie 窗口的 Plugins 分组中打开此页。", "error");
    } finally {
      setBusy(false);
    }
  }

  const SAVE_COOLDOWN_MS = 1500;
  let lastSavedAt = 0;

  function cooldownLeft() {
    return Math.max(0, SAVE_COOLDOWN_MS - (Date.now() - lastSavedAt));
  }

  async function save() {
    clearErrors();
    const built = buildOptions(current, readForm());
    if (!built.ok) {
      showErrors(built.errors);
      setStatus("配置有误，未保存。", "error");
      return;
    }
    if (cooldownLeft() > 0) {
      setStatus(`刚刚保存过，请等 ${Math.ceil(cooldownLeft() / 1000)} 秒再保存。`, "error");
      return;
    }
    lastSavedAt = Date.now();
    setBusy(true);
    setStatus("正在保存…");
    try {
      const options = await magpie.options.set(built.options);
      fill(options, models);
      // The host restarts on save, so the iframe's bridge may be gone for a
      // moment. Ask again once it is back — but only while the form still
      // matches what was saved, so an edit made in the meantime is not
      // silently replaced by the older server value.
      const savedSnapshot = readForm();
      setTimeout(() => {
        if (JSON.stringify(savedSnapshot) !== JSON.stringify(readForm())) return;
        void reloadQuietly();
      }, SAVE_COOLDOWN_MS);
      setStatus("已保存。保存会重启插件宿主；进行中的请求可能短暂失败。", "ok");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/once a second|429/.test(text)) {
        setStatus("保存过快。原版页面每秒最多保存一次，请稍后再试。", "error");
      } else {
        setStatus(`保存失败：${text}`, "error");
      }
    } finally {
      setBusy(false);
    }
  }

  async function reloadQuietly() {
    try {
      await magpie.ready;
      const options = await magpie.options.get();
      if (!options || typeof options !== "object" || Array.isArray(options)) return;
      const [modelList, groups] = await Promise.all([loadModels(options), loadGroups()]);
      models = targetChoices(modelList, groups);
      fill(options, models);
      renderGroups(groups);
    } catch {
      // the host is still restarting; the next explicit reload picks it up
    }
  }

  // magpie serves pages in sandbox="allow-scripts": a submit button's default
  // action is blocked there, so saving is bound to the button itself.
  // magpie serves pages in sandbox="allow-scripts", where a form submit
  // (button default action or Enter) is blocked before it can fire. Saving
  // therefore hangs off the button's own click, never the form's submit.
  $("save").addEventListener("click", () => void save());
  $("reload").addEventListener("click", () => void load());
  $("defaultMode").addEventListener("change", () => {
    const selected = $("defaultMode").selectedOptions[0];
    $("modeBadge").textContent = selected ? selected.textContent : "";
  });
  void load();
})();
