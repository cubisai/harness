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

export type AppThemeToken = (typeof APP_THEME_TOKENS)[number];

/** The tokens' values in each scheme, for a frame with no CubiQ window around it (the Creator app check). Pinned to app.css by a test. */
export const APP_THEME_DEFAULTS: Record<"light" | "dark", Record<AppThemeToken, string>> = {
  light: {
    bg: "#ffffff",
    "bg-subtle": "#f5f6f8",
    "bg-chip": "#f1f3f5",
    "bg-hover": "#eff1f4",
    text: "#0b0d10",
    "text-secondary": "#5b606b",
    "text-tertiary": "#9aa0aa",
    hairline: "#e7e9ed",
    "hairline-strong": "#d5d9df",
    primary: "#0b0d10",
    "on-primary": "#ffffff",
    focus: "#0b0d10",
    success: "#2f9e44",
    danger: "#e5484d",
    warning: "#c98500",
    "signal-fill": "#a8ff55",
    "signal-ink": "#357a08",
    "add-bg": "rgb(47 158 68 / 0.1)",
    "del-bg": "rgb(229 72 77 / 0.08)",
  },
  dark: {
    bg: "#0e1013",
    "bg-subtle": "#14171b",
    "bg-chip": "#1a1d22",
    "bg-hover": "#181b20",
    text: "#f7f8fa",
    "text-secondary": "#9aa0aa",
    "text-tertiary": "#5f6570",
    hairline: "#22252b",
    "hairline-strong": "#30343c",
    primary: "#f7f8fa",
    "on-primary": "#0b0d10",
    focus: "#f7f8fa",
    success: "#3fb950",
    danger: "#ff6369",
    warning: "#f5a524",
    "signal-fill": "#a8ff55",
    "signal-ink": "#a8ff55",
    "add-bg": "rgb(63 185 80 / 0.12)",
    "del-bg": "rgb(255 99 105 / 0.12)",
  },
};

// The script injected into every app page: `window.cubiq`. It only talks to the parent window (the CubiQ pane that
// hosts the frame), which forwards calls to main, where grants are checked. Errors and console warnings go to the
// host too, so the Creator agent's app check sees what broke. An own-style app gets no base sheet (font, background).
export function appBridgeScript(opts: { ownStyle?: boolean } = {}): string {
  return `(() => {
  "use strict";
  if (window.cubiq) return;
  const parent = window.parent;
  const pending = new Map();
  let seq = 0;
  const themeListeners = new Set();
  const toolHandlers = new Map();
  const cardListeners = new Set();
  let cardData, hasCard = false;
  let toolMode = false, toolBusy = false;
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
    if (m.op === "tool-mode") { toolMode = true; return; }
    if (m.op === "card") {
      cardData = m.data; hasCard = true;
      for (const f of cardListeners) { try { f(cardData); } catch (err) { report("error", err); } }
      return;
    }
    if (m.op === "tool-invoke") {
      if (!toolMode || toolBusy || typeof m.name !== "string") return;
      const fn = toolHandlers.get(m.name);
      if (!fn) { post({ op: "tool-result", id: m.id, ok: false, error: "No handler registered for this tool." }); return; }
      toolBusy = true;
      Promise.resolve().then(() => fn(m.args)).then(
        (result) => post({ op: "tool-result", id: m.id, ok: true, result }),
        (err) => post({ op: "tool-result", id: m.id, ok: false, error: text(err).slice(0, 2000) })
      ).finally(() => { toolBusy = false; });
      return;
    }
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
${
    opts.ownStyle
      ? ""
      : `  const base = document.createElement("style");
  base.textContent = ":where(html){background:var(--cq-bg,#fff);color:var(--cq-text,#0b0d10);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}";
  (document.head || document.documentElement).prepend(base);
`
  }  window.cubiq = Object.freeze({
    /** Call a granted connector tool. Resolves to its structured data, else its text (parsed when it is JSON). */
    call: (server, tool, args) => request("call", { server: String(server), tool: String(tool), args: args && typeof args === "object" ? args : {} }),
    store: Object.freeze({
      get: (key) => request("store.get", { key: String(key) }),
      set: (key, value) => request("store.set", { key: String(key), value: value === undefined ? null : value }),
    }),
    theme: () => scheme,
    onTheme: (f) => { themeListeners.add(f); return () => themeListeners.delete(f); },
    /** Register an agent-callable tool. Only the hidden tool host can invoke it. */
    onTool: (name, fn) => {
      if (typeof name !== "string" || typeof fn !== "function" || toolHandlers.has(name)) throw new Error("A tool needs a unique name and a handler.");
      toolHandlers.set(name, fn); post({ op: "tool-register", name });
    },
    /** A transcript card's result data; replayed immediately for a late listener. */
    onCard: (fn) => { cardListeners.add(fn); if (hasCard) fn(cardData); return () => cardListeners.delete(fn); },
    /** A floating widget's label while it is minimised (up to 40 characters; empty shows the title). */
    pill: (text) => post({ op: "pill", text: String(text == null ? "" : text).slice(0, 40) }),
    /** A short toast in CubiQ, headed with the app's title (up to 200 characters; a few per minute at most). */
    notify: (text) => post({ op: "notify", text: String(text == null ? "" : text).slice(0, 200) }),
    /** Open another installed, enabled plugin by its name (its usual placement). */
    openPlugin: (name) => post({ op: "open", name: String(name == null ? "" : name).slice(0, 64) }),
    /** Start a new chat with this text in the composer; the user reads it and sends it (up to 4000 characters). */
    ask: (prompt) => post({ op: "ask", prompt: String(prompt == null ? "" : prompt).slice(0, 4000) }),
  });
  post({ op: "ready" });
})();`;
}
