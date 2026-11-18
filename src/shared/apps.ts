/** Theme tokens a Creator app gets as `--cq-*` CSS variables (DESIGN.md names, without the `--`). */
export const APP_THEME_TOKENS = [
  "bg",
  "bg-subtle",
  "bg-chip",
  "bg-hover",
  "text",
  "text-secondary",
  "text-tertiary",
  "hairline",
  "hairline-strong",
  "primary",
  "on-primary",
  "focus",
  "success",
  "danger",
  "warning",
  "signal-fill",
  "signal-ink",
  "add-bg",
  "del-bg",
] as const;

// The script injected into every app page: `window.cubiq`. It only talks to the parent window (the CubiQ pane that
// hosts the frame), which forwards calls to main, where grants are checked. Errors and console warnings go to the
// host too, so the Creator agent's app check sees what broke.
export function appBridgeScript(): string {
  return `(() => {
  "use strict";
  if (window.cubiq) return;
  const parent = window.parent;
  const pending = new Map();
  let seq = 0;
  const themeListeners = new Set();
  let scheme = "light";
  const post = (msg) => parent.postMessage(Object.assign({ cubiqApp: 1 }, msg), "*");
  const request = (op, payload) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    post(Object.assign({ id, op }, payload));
  });
  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.cubiqApp !== 1) return;
    if (m.op === "theme") {
      const root = document.documentElement;
      for (const [k, v] of Object.entries(m.vars || {})) root.style.setProperty("--cq-" + k, String(v));
      scheme = m.scheme === "dark" ? "dark" : "light";
      root.style.colorScheme = scheme;
      root.dataset.cqTheme = scheme;
      for (const f of themeListeners) { try { f(scheme); } catch (err) { report("error", err); } }
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(String(m.error || "The call failed.")));
  });
  const text = (v) => { try { return v instanceof Error ? (v.stack || v.message) : typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); } };
  const report = (level, ...args) => post({ op: "log", level, message: args.map(text).join(" ").slice(0, 2000) });
  window.addEventListener("error", (e) => report("error", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => report("error", e.reason));
  for (const level of ["error", "warn"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { report(level, ...args); orig(...args); };
  }
  const base = document.createElement("style");
  base.textContent = ":where(html){background:var(--cq-bg,#fff);color:var(--cq-text,#0b0d10);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}";
  (document.head || document.documentElement).prepend(base);
  window.cubiq = Object.freeze({
    /** Call a granted connector tool. Resolves to its structured data, else its text (parsed when it is JSON). */
    call: (server, tool, args) => request("call", { server: String(server), tool: String(tool), args: args && typeof args === "object" ? args : {} }),
    store: Object.freeze({
      get: (key) => request("store.get", { key: String(key) }),
      set: (key, value) => request("store.set", { key: String(key), value: value === undefined ? null : value }),
    }),
    theme: () => scheme,
    onTheme: (f) => { themeListeners.add(f); return () => themeListeners.delete(f); },
  });
  post({ op: "ready" });
})();`;
}
