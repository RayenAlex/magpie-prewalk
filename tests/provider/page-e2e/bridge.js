// The page's side of the bridge, reduced to what the Prewalk page calls. It
// posts to the fixture window, which answers with the plugin's options.
(() => {
  const waiting = new Map();
  let next = 0;
  function call(method, params) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      parent.postMessage({ magpie: 1, id, method, params }, "*");
    });
  }
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.magpie !== 1) return;
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
  });
  const api = {
    theme: null,
    context: {},
    service: "",
    visible: true,
    onTheme() {},
    onVisibility() {},
    onAction() {},
    options: {
      get: () => call("options.get"),
      set: (options) => call("options.set", { options })
    },
    read: (name, params) => call("read", { name, params })
  };
  api.ready = call("hello").then(() => api);
  window.magpie = api;
})();
