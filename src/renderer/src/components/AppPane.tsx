import { useCallback, useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart3,
  Box,
  Calendar,
  Clock,
  Gauge,
  KanbanSquare,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  List,
  Map as MapIcon,
  NotebookPen,
  Package,
  PieChart,
  ShoppingCart,
  Table2,
  Users,
  Wallet,
} from "lucide-react";
import { APP_THEME_TOKENS } from "../../../shared/apps";
import type { AppInfo } from "../../../shared/types";
import { api } from "../api";
import { IconClose, IconRefresh } from "../icons";
import { isDark, useStore } from "../store";

/** The lucide names an app.json may use (a small set keeps the bundle small); anything else gets the grid. */
const APP_ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  "chart-bar": BarChart3,
  "bar-chart": BarChart3,
  "chart-line": LineChart,
  "chart-pie": PieChart,
  box: Box,
  calendar: Calendar,
  clock: Clock,
  gauge: Gauge,
  kanban: KanbanSquare,
  "layout-dashboard": LayoutDashboard,
  list: List,
  map: MapIcon,
  notebook: NotebookPen,
  package: Package,
  "shopping-cart": ShoppingCart,
  table: Table2,
  users: Users,
  wallet: Wallet,
};

export function appIcon(name?: string): LucideIcon {
  return (name && APP_ICONS[name]) || LayoutGrid;
}

/** A frame message is small and plain: anything else is dropped before it reaches main. */
const MAX_MESSAGE_CHARS = 256 * 1024;
const MAX_PER_SECOND = 100;

interface Ask {
  id: number;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  shown: string;
  token: string;
}

interface Log {
  level: "error" | "warn";
  message: string;
}

/** The theme as the app sees it: CubiQ's tokens, read off <html>. */
function themeMessage(): { cubiqApp: 1; op: "theme"; scheme: "dark" | "light"; vars: Record<string, string> } {
  const css = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const t of APP_THEME_TOKENS) vars[t] = css.getPropertyValue(`--${t}`).trim();
  return { cubiqApp: 1, op: "theme", scheme: isDark() ? "dark" : "light", vars };
}

/** The App tab: one installed Creator app in a sandboxed frame, with its bridge calls relayed to main. */
export function AppPane({ app }: { app: AppInfo }) {
  const projectId = useStore((s) => s.selectedProjectId);
  const closeApp = useStore((s) => s.closeApp);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [nonce, setNonce] = useState(0);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const rate = useRef({ second: 0, count: 0 });
  // Answers for a frame that was since reloaded go nowhere.
  const loadRef = useRef(0);

  const reply = useCallback((load: number, id: number, body: { ok: true; result: unknown } | { ok: false; error: string }) => {
    if (load !== loadRef.current) return;
    frameRef.current?.contentWindow?.postMessage({ cubiqApp: 1, id, ...body }, "*");
  }, []);

  const postTheme = useCallback(() => frameRef.current?.contentWindow?.postMessage(themeMessage(), "*"), []);

  // Another app in the same pane: earlier questions and logs belong to the old one.
  useEffect(() => {
    loadRef.current++;
    setAsks([]);
    setLogs([]);
    setShowLogs(false);
  }, [app.key]);

  useEffect(() => {
    const onTheme = () => postTheme();
    const mq = matchMedia("(prefers-color-scheme: dark)");
    window.addEventListener("unskilled-theme", onTheme);
    mq.addEventListener("change", onTheme);
    return () => {
      window.removeEventListener("unskilled-theme", onTheme);
      mq.removeEventListener("change", onTheme);
    };
  }, [postTheme]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const m = e.data as Record<string, unknown> | null;
      if (!m || typeof m !== "object" || m.cubiqApp !== 1 || typeof m.op !== "string") return;
      const sec = Math.floor(performance.now() / 1000);
      if (rate.current.second !== sec) rate.current = { second: sec, count: 0 };
      if (++rate.current.count > MAX_PER_SECOND) return;
      let size = 0;
      try {
        size = JSON.stringify(m).length;
      } catch {
        return;
      }
      if (size > MAX_MESSAGE_CHARS) return;
      const load = loadRef.current;
      const id = typeof m.id === "number" ? m.id : -1;
      switch (m.op) {
        case "ready":
          postTheme();
          return;
        case "log":
          if ((m.level === "error" || m.level === "warn") && typeof m.message === "string") {
            const entry = { level: m.level, message: m.message.slice(0, 2000) } as Log;
            setLogs((l) => [...l.slice(-49), entry]);
          }
          return;
        case "call": {
          if (typeof m.server !== "string" || typeof m.tool !== "string") return;
          const args = m.args && typeof m.args === "object" && !Array.isArray(m.args) ? (m.args as Record<string, unknown>) : {};
          const server = m.server;
          const tool = m.tool;
          void api()
            .callApp(app.key, projectId, server, tool, args)
            .then((r) => {
              if (r.ok) reply(load, id, r);
              else if ("approval" in r) setAsks((a) => [...a, { id, server, tool, args, shown: r.approval.args, token: r.approval.token }]);
              else reply(load, id, r);
            })
            .catch((err: unknown) => reply(load, id, { ok: false, error: err instanceof Error ? err.message : String(err) }));
          return;
        }
        case "store.get":
          if (typeof m.key !== "string") return;
          void api()
            .appStoreGet(app.key, m.key)
            .then((v) => reply(load, id, { ok: true, result: v }))
            .catch(() => reply(load, id, { ok: false, error: "The store could not be read." }));
          return;
        case "store.set":
          if (typeof m.key !== "string") return;
          void api()
            .appStoreSet(app.key, m.key, m.value)
            .then((r) => reply(load, id, "approval" in r ? { ok: false, error: "Not allowed." } : r))
            .catch(() => reply(load, id, { ok: false, error: "The store could not be written." }));
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [app.key, projectId, postTheme, reply]);

  const answer = (ask: Ask, decision: "deny" | "once" | "always") => {
    setAsks((a) => a.filter((x) => x !== ask));
    const load = loadRef.current;
    if (decision === "deny") {
      reply(load, ask.id, { ok: false, error: "The user declined this call." });
      return;
    }
    void api()
      .callApp(app.key, projectId, ask.server, ask.tool, ask.args, { token: ask.token, remember: decision === "always" })
      .then((r) => reply(load, ask.id, r.ok ? r : { ok: false, error: "approval" in r ? "The approval expired; try again." : r.error }))
      .catch((err: unknown) => reply(load, ask.id, { ok: false, error: err instanceof Error ? err.message : String(err) }));
  };

  const reload = () => {
    loadRef.current++;
    setAsks([]);
    setLogs([]);
    setNonce((n) => n + 1);
  };

  const ask = asks[0];
  const errors = logs.filter((l) => l.level === "error").length;
  const Icon = appIcon(app.icon);
  return (
    <div className="app-pane">
      <div className="app-pane-head">
        <span className="app-pane-icon" aria-hidden>
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <span className="app-pane-title" title={app.description}>
          {app.title}
        </span>
        <span className="proposal-chip">{app.scope === "project" ? "Project" : "Global"}</span>
        <span className="grow" />
        {logs.length > 0 && (
          <button type="button" className={`app-pane-logs-toggle${errors ? " has-errors" : ""}`} aria-expanded={showLogs} onClick={() => setShowLogs((v) => !v)}>
            {errors ? `${errors} error${errors === 1 ? "" : "s"}` : `${logs.length} warning${logs.length === 1 ? "" : "s"}`}
          </button>
        )}
        <button type="button" className="icon-button" title="Reload" onClick={reload}>
          <IconRefresh />
        </button>
        <button type="button" className="icon-button" title="Close app" onClick={closeApp}>
          <IconClose />
        </button>
      </div>
      {showLogs && logs.length > 0 && (
        <ul className="app-pane-log">
          {logs.map((l, i) => (
            <li key={i} className={l.level}>
              {l.message}
            </li>
          ))}
        </ul>
      )}
      {ask && (
        <div className="app-ask" role="alertdialog" aria-label={`${app.title} wants to run ${ask.server}.${ask.tool}`}>
          <div className="app-ask-text">
            <strong>{app.title}</strong> wants to run <code>{`${ask.server}.${ask.tool}`}</code>, which can change data.
          </div>
          <pre className="app-ask-args">{ask.shown}</pre>
          <div className="app-ask-foot">
            <button type="button" className="button ghost" onClick={() => answer(ask, "deny")}>
              Deny
            </button>
            <button type="button" className="button" onClick={() => answer(ask, "always")}>
              Always for this app
            </button>
            <button type="button" className="button primary" autoFocus onClick={() => answer(ask, "once")}>
              Allow once
            </button>
          </div>
        </div>
      )}
      <iframe
        key={`${app.key}:${nonce}`}
        ref={frameRef}
        className="app-frame"
        title={app.title}
        src={app.url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={postTheme}
      />
    </div>
  );
}
