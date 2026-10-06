import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { commandWarnings, parseMcpInput } from "../../../shared/mcp-add";
import type { ExternalMcpServer, McpDraft, McpOverview, McpProbeResult, McpServerSpec, McpServerStatus, McpServerView } from "../../../shared/types";
import { api } from "../api";
import { joinCommandLine, splitCommandLine } from "../cmdline";
import { useStore } from "../store";
import "../styles/mcp.css";

/** The loopback port the sign-in callback uses unless a server sets its own (main's DEFAULT_CALLBACK_PORT). */
const DEFAULT_CALLBACK_PORT = 33418;

/** Remote servers checked live: each signs in in the browser (dynamic registration), needs no key, or takes a token header. */
interface Featured {
  name: string;
  url: string;
  about: string;
  auth: "sign-in" | "none" | "token";
  /** For "token": the header to fill in. */
  header?: string;
}

const FEATURED: Featured[] = [
  { name: "Linear", url: "https://mcp.linear.app/mcp", about: "Issues, projects and cycles", auth: "sign-in" },
  { name: "Notion", url: "https://mcp.notion.com/mcp", about: "Pages, databases and search", auth: "sign-in" },
  { name: "Sentry", url: "https://mcp.sentry.dev/mcp", about: "Errors, issues and releases", auth: "sign-in" },
  { name: "Figma", url: "https://mcp.figma.com/mcp", about: "Designs, frames and variables", auth: "sign-in" },
  { name: "Canva", url: "https://mcp.canva.com/mcp", about: "Designs and brand assets", auth: "sign-in" },
  { name: "Stripe", url: "https://mcp.stripe.com", about: "Payments, customers and docs", auth: "sign-in" },
  { name: "Supabase", url: "https://mcp.supabase.com/mcp", about: "Projects, tables and SQL", auth: "sign-in" },
  { name: "Vercel", url: "https://mcp.vercel.com", about: "Deployments, logs and projects", auth: "sign-in" },
  { name: "Cloudflare", url: "https://mcp.cloudflare.com/mcp", about: "Workers, DNS and the API", auth: "sign-in" },
  { name: "Asana", url: "https://mcp.asana.com/sse", about: "Tasks, projects and goals", auth: "sign-in" },
  { name: "PayPal", url: "https://mcp.paypal.com/mcp", about: "Invoices, orders and payments", auth: "sign-in" },
  { name: "Atlassian", url: "https://mcp.atlassian.com/v1/mcp", about: "Jira and Confluence", auth: "sign-in" },
  { name: "GitHub", url: "https://api.githubcopilot.com/mcp/", about: "Repos, issues and pull requests", auth: "token", header: "Authorization" },
  { name: "Context7", url: "https://mcp.context7.com/mcp", about: "Up-to-date library docs", auth: "none" },
  { name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", about: "Docs for any GitHub repo", auth: "none" },
  { name: "Cloudflare Docs", url: "https://docs.mcp.cloudflare.com/mcp", about: "Cloudflare's documentation", auth: "none" },
];

const AUTH_LABEL: Record<Featured["auth"], string> = { "sign-in": "Sign in", none: "No key", token: "Token" };

interface Pair {
  key: string;
  value: string;
  /** Stored already: an empty value keeps it. */
  stored: boolean;
}

/** One server being added or edited. */
interface Review {
  /** The server's name before this edit; null when adding. */
  previous: string | null;
  name: string;
  type: McpServerSpec["type"];
  line: string;
  url: string;
  pairs: Pair[];
  clientId: string;
  clientSecret: string;
  hasClientSecret: boolean;
  scopes: string;
  callbackPort: string;
  /** The command line it had when the edit began; a changed command needs consent again. */
  approvedLine: string | null;
  trusted: boolean;
  probe: McpProbeResult | "running" | null;
  advanced: boolean;
}

function reviewOf(draft: McpDraft): Review {
  const spec = draft.spec;
  const map = spec.type === "stdio" ? spec.env : spec.headers;
  return {
    previous: null,
    name: draft.name,
    type: spec.type,
    line: spec.type === "stdio" ? joinCommandLine([spec.command, ...(spec.args ?? [])]) : "",
    url: spec.type === "stdio" ? "" : spec.url,
    pairs: Object.entries(map ?? {}).map(([key, value]) => ({ key, value, stored: false })),
    clientId: spec.type !== "stdio" ? (spec.oauth?.clientId ?? "") : "",
    clientSecret: "",
    hasClientSecret: false,
    scopes: spec.type !== "stdio" ? (spec.oauth?.scopes ?? "") : "",
    callbackPort: spec.type !== "stdio" && spec.oauth?.callbackPort ? String(spec.oauth.callbackPort) : "",
    approvedLine: null,
    trusted: false,
    probe: null,
    advanced: false,
  };
}

function editOf(view: McpServerView): Review {
  const keys = view.type === "stdio" ? view.envKeys : view.headerKeys;
  const command = view.type === "stdio" ? view.target.slice(0, view.target.length - (view.args ?? []).join(" ").length).trim() : "";
  const line = view.type === "stdio" ? joinCommandLine([command, ...(view.args ?? [])]) : "";
  return {
    previous: view.name,
    name: view.name,
    type: view.type,
    line,
    url: view.type === "stdio" ? "" : view.target,
    pairs: keys.map((key) => ({ key, value: view.publicValues?.[key] ?? "", stored: view.publicValues?.[key] === undefined })),
    clientId: view.oauth?.clientId ?? "",
    clientSecret: "",
    hasClientSecret: view.hasClientSecret === true,
    scopes: view.oauth?.scopes ?? "",
    callbackPort: view.oauth?.callbackPort ? String(view.oauth.callbackPort) : "",
    approvedLine: line,
    trusted: true,
    probe: null,
    advanced: Boolean(view.oauth?.clientId || view.oauth?.scopes || view.oauth?.callbackPort),
  };
}

/** The spec a review saves; throws a message for the form. */
function specOf(r: Review): McpServerSpec {
  const map: Record<string, string> = {};
  for (const p of r.pairs) {
    const key = p.key.trim();
    // An empty value on a stored key keeps it; an empty new one is dropped.
    if (key && (p.value !== "" || p.stored)) map[key] = p.value;
  }
  const values = Object.keys(map).length ? map : undefined;
  if (r.type === "stdio") {
    const words = splitCommandLine(r.line.trim());
    if (!words.length) throw new Error("Enter the command that starts the server.");
    return { type: "stdio", command: words[0]!, ...(words.length > 1 && { args: words.slice(1) }), ...(values && { env: values }) };
  }
  const url = r.url.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("The URL has to start with http:// or https://.");
  const port = r.callbackPort.trim() ? Number(r.callbackPort.trim()) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error("The callback port is a number from 1 to 65535.");
  const oauth = { ...(r.clientId.trim() && { clientId: r.clientId.trim() }), ...(r.scopes.trim() && { scopes: r.scopes.trim() }), ...(port && { callbackPort: port }) };
  return { type: r.type, url, ...(values && { headers: values }), ...(Object.keys(oauth).length && { oauth }) };
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function hasAuthHeader(r: Review): boolean {
  return r.pairs.some((p) => p.key.trim().toLowerCase() === "authorization" && (p.value !== "" || p.stored));
}

function minutesLeft(ms: number): string {
  const min = Math.round((ms - Date.now()) / 60_000);
  if (min <= 0) return "expired";
  return min < 90 ? `${min} min left` : `${Math.round(min / 60)} h left`;
}

/**
 * MCP servers in one place, for Library › Connectors and the /mcp sheet: a
 * smart add box (URL, command line, `mcp add` line or JSON), a consent step
 * before any command runs, each server's live status and tools, sign-in, edit,
 * and the servers other agents load. `prefill` starts a review of that text.
 */
export function McpPanel({ prefill, compact }: { prefill?: string; compact?: boolean }) {
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const [scope, setScope] = useState<"all" | "project">("all");
  const inProject = scope === "project" && selectedProjectId !== null;
  const projectId: string | null = inProject ? selectedProjectId : null;
  const [data, setData] = useState<McpOverview | null>(null);
  const [status, setStatus] = useState<Record<string, McpServerStatus>>({});
  const [input, setInput] = useState(prefill ?? "");
  const [inputError, setInputError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [queue, setQueue] = useState<McpDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const scopeRef = useRef(projectId);
  scopeRef.current = projectId;

  const loadStatus = useCallback((refresh = false) => {
    const pid = scopeRef.current;
    void api()
      .mcpStatus(pid, refresh)
      .then((list) => {
        if (scopeRef.current === pid) setStatus(Object.fromEntries(list.map((s) => [s.name, s])));
      })
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    void api().getMcp(scopeRef.current).then(setData);
    loadStatus();
  }, [loadStatus]);

  useEffect(load, [projectId, load]);

  // Sign-ins, refusals and edits elsewhere: ask again (the main side caches listings, so this is cheap).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api().onUpdate((u) => {
      if (u.type !== "mcp-status") return;
      clearTimeout(timer);
      timer = setTimeout(() => loadStatus(), 250);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [loadStatus]);

  // Knock on a URL (debounced) so the review can say whether it wants a sign-in or a key.
  const probeUrl = review && review.type !== "stdio" ? review.url.trim() : "";
  const probeHeaders = review ? JSON.stringify(review.pairs.filter((p) => p.key.trim() && p.value).map((p) => [p.key.trim(), p.value])) : "[]";
  useEffect(() => {
    if (!/^https?:\/\/\S+$/i.test(probeUrl)) return;
    setReview((r) => (r ? { ...r, probe: "running" } : r));
    const timer = setTimeout(() => {
      const headers = Object.fromEntries(JSON.parse(probeHeaders) as [string, string][]);
      void api()
        .probeMcp(probeUrl, Object.keys(headers).length ? headers : undefined)
        .then((probe) =>
          setReview((r) => {
            if (!r || r.url.trim() !== probeUrl) return r;
            // An endpoint that only answers the old SSE way is saved as SSE.
            return { ...r, probe, ...(probe.ok && probe.transport && probe.transport !== r.type && { type: probe.transport }) };
          }),
        )
        .catch((err) => setReview((r) => (r ? { ...r, probe: { ok: false, auth: "none", error: errorText(err) } } : r)));
    }, 450);
    return () => clearTimeout(timer);
  }, [probeUrl, probeHeaders]);

  const startReview = (drafts: McpDraft[]) => {
    setFormError(null);
    setReview(drafts[0] ? reviewOf(drafts[0]) : null);
    setQueue(drafts.slice(1));
  };

  const readInput = (text: string) => {
    const parsed = parseMcpInput(text);
    if (parsed.error || !parsed.drafts.length) {
      setInputError(parsed.error ?? "Nothing to add there.");
      return;
    }
    setInputError(null);
    startReview(parsed.drafts);
  };

  // `/mcp <url|command>` opens the sheet with the text in place, ready to review.
  useEffect(() => {
    if (prefill?.trim()) readInput(prefill);
  }, [prefill]);

  const closeReview = () => {
    const [next, ...rest] = queue;
    setReview(next ? reviewOf(next) : null);
    setQueue(rest);
    setFormError(null);
  };

  const connect = async (name: string) => {
    setBusy((b) => ({ ...b, [name]: "Waiting for the browser…" }));
    setRowError((e) => ({ ...e, [name]: "" }));
    try {
      const res = await api().connectMcp(name, projectId);
      if (!res.ok) setRowError((e) => ({ ...e, [name]: res.error ?? "Sign-in failed." }));
    } finally {
      setBusy((b) => ({ ...b, [name]: "" }));
      loadStatus(true);
    }
  };

  const save = async () => {
    if (!review) return;
    let spec: McpServerSpec;
    try {
      spec = specOf(review);
    } catch (err) {
      setFormError(errorText(err));
      return;
    }
    const name = review.name.trim();
    if (!name) return setFormError("Give the server a name.");
    setSaving(true);
    setFormError(null);
    try {
      setData(await api().saveMcpServer({ name, spec, enabled: true }, review.previous ?? undefined, projectId));
      if (review.clientSecret) setData(await api().setMcpClientSecret(name, review.clientSecret, projectId));
      const signIn = review.previous === null && typeof review.probe === "object" && review.probe?.auth === "oauth" && !hasAuthHeader(review);
      closeReview();
      setInput("");
      if (signIn) await connect(name);
      else loadStatus(true);
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const rowAction = async (name: string, label: string, run: () => Promise<McpOverview | void>) => {
    setBusy((b) => ({ ...b, [name]: label }));
    setRowError((e) => ({ ...e, [name]: "" }));
    try {
      const next = await run();
      if (next) setData(next);
    } catch (err) {
      setRowError((e) => ({ ...e, [name]: errorText(err) }));
    } finally {
      setBusy((b) => ({ ...b, [name]: "" }));
      loadStatus();
    }
  };

  const importExternal = (s: ExternalMcpServer) =>
    rowAction(`ext:${s.agent}:${s.source}:${s.name}`, "Importing…", () => api().importMcp(s.agent, s.source, s.name, projectId));

  if (!data) return <div className="mcp-panel" />;

  const servers = inProject && data.project ? data.project.servers : data.servers;
  const added = new Set(servers.map((s) => s.target.replace(/\/$/, "")));
  const offGlobal = new Set(data.project?.offGlobal ?? []);

  return (
    <div className={`mcp-panel${compact ? " compact" : ""}`}>
      <div className="mcp-bar">
        <div className="segmented compact">
          <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>
            All projects
          </button>
          <button className={inProject ? "on" : ""} disabled={!selectedProjectId} title={selectedProjectId ? undefined : "Pick a project first"} onClick={() => setScope("project")}>
            This project
          </button>
        </div>
      </div>

      <form
        className="mcp-add"
        onSubmit={(e) => {
          e.preventDefault();
          readInput(input);
        }}
      >
        <input
          className="text-input mono"
          aria-label="Add an MCP server"
          value={input}
          placeholder="Paste a URL, a command (npx …), an `mcp add` line or JSON config"
          spellCheck={false}
          onChange={(e) => (setInput(e.target.value), setInputError(null))}
        />
        <button type="submit" className="button" disabled={!input.trim()}>
          Add
        </button>
      </form>
      {inputError && <p className="mcp-error">{inputError}</p>}

      {review && (
        <ReviewForm
          review={review}
          setReview={setReview}
          queued={queue.length}
          error={formError}
          saving={saving}
          onSave={() => void save()}
          onCancel={() => (setReview(null), setQueue([]), setFormError(null))}
        />
      )}

      <section className="mcp-section">
        <h3>{inProject ? "This project's servers" : "Servers"}</h3>
        {servers.length === 0 ? (
          <p className="mcp-empty">None yet. Paste one above or pick a connector below.</p>
        ) : (
          servers.map((s) => (
            <ServerRow
              key={s.name}
              view={s}
              status={status[s.name]}
              busy={busy[s.name]}
              error={rowError[s.name]}
              open={open.has(s.name)}
              onToggleTools={() =>
                setOpen((o) => {
                  const next = new Set(o);
                  if (next.has(s.name)) next.delete(s.name);
                  else next.add(s.name);
                  return next;
                })
              }
              onEnable={(on) => void rowAction(s.name, on ? "Turning on…" : "Turning off…", () => api().setMcpServerEnabled(s.name, on, projectId))}
              onConnect={() => void connect(s.name)}
              onSignOut={() => void rowAction(s.name, "Signing out…", () => api().disconnectMcp(s.name, projectId))}
              onEdit={() => (setFormError(null), setQueue([]), setReview(editOf(s)))}
              onRemove={() => void rowAction(s.name, "Removing…", () => api().removeMcpServer(s.name, projectId))}
            />
          ))
        )}
      </section>

      {inProject && data.project && data.servers.length > 0 && (
        <section className="mcp-section">
          <h3>From all projects</h3>
          {data.servers.map((s) => {
            const off = offGlobal.has(s.name);
            return (
              <div key={s.name} className={`mcp-server${off ? " off" : ""}`}>
                <div className="mcp-server-main">
                  <div className="mcp-server-name">
                    <span className="mcp-name-text">{s.name}</span>
                    <span className="tag">{typeLabel(s.type)}</span>
                  </div>
                  <code className="mcp-target">{s.target}</code>
                </div>
                <label className="mcp-check">
                  <input type="checkbox" checked={!off} onChange={(e) => void api().setGlobalMcpOff(selectedProjectId!, s.name, !e.target.checked).then(setData)} />
                  Use here
                </label>
              </div>
            );
          })}
        </section>
      )}

      {!compact && (
        <section className="mcp-section">
          <h3>Connectors</h3>
          <div className="mcp-featured">
            {FEATURED.map((f) => {
              const isAdded = added.has(f.url.replace(/\/$/, ""));
              return (
                <button
                  key={f.url}
                  className="mcp-featured-card"
                  disabled={isAdded}
                  onClick={() => {
                    const parsed = parseMcpInput(f.url);
                    const draft = parsed.drafts[0];
                    if (!draft) return;
                    const spec = f.header && draft.spec.type !== "stdio" ? { ...draft.spec, headers: { [f.header]: "Bearer " } } : draft.spec;
                    startReview([{ ...draft, spec }]);
                  }}
                >
                  <span className="mcp-featured-name">{f.name}</span>
                  <span className="mcp-featured-about">{f.about}</span>
                  <span className="mcp-featured-auth">{isAdded ? "Added" : AUTH_LABEL[f.auth]}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {data.external.length > 0 && (
        <section className="mcp-section">
          <h3>Loaded by the agents themselves</h3>
          <p className="mcp-note">From each agent&apos;s own config. Import one to manage it here; its values move into the encrypted store.</p>
          {data.external.map((s) => {
            const key = `ext:${s.agent}:${s.source}:${s.name}`;
            return (
              <div key={key} className="mcp-server">
                <div className="mcp-server-main">
                  <div className="mcp-server-name">
                    <span className="mcp-name-text">{s.name}</span>
                    <span className="tag">{s.type === "unknown" ? "Unknown" : typeLabel(s.type)}</span>
                    <span className="mcp-source">
                      {s.agent} · {s.source}
                    </span>
                  </div>
                  {s.target && <code className="mcp-target">{s.target}</code>}
                  {rowError[key] && <p className="mcp-error">{rowError[key]}</p>}
                </div>
                {s.importable && (
                  <button className="button ghost" disabled={Boolean(busy[key])} onClick={() => void importExternal(s)}>
                    {busy[key] || "Import"}
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}

      {!compact && (
        <section className="mcp-section">
          <h3>Built in</h3>
          <div className="mcp-server">
            <div className="mcp-server-main">
              <div className="mcp-server-name">
                <span className="mcp-name-text">{data.builtIn.name}</span>
                <span className="tag">{data.builtIn.active ? "Active" : "Starts with the browser pane"}</span>
              </div>
              <div className="mcp-tool-chips">
                {data.builtIn.tools.map((t) => (
                  <span key={t.name} className="chip mono" title={t.description}>
                    {t.name}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function typeLabel(type: McpServerSpec["type"] | "unknown"): string {
  return type === "stdio" ? "Command" : type === "sse" ? "SSE" : type === "http" ? "URL" : "Unknown";
}

function ServerRow({
  view,
  status,
  busy,
  error,
  open,
  onToggleTools,
  onEnable,
  onConnect,
  onSignOut,
  onEdit,
  onRemove,
}: {
  view: McpServerView;
  status: McpServerStatus | undefined;
  busy: string | undefined;
  error: string | undefined;
  open: boolean;
  onToggleTools: () => void;
  onEnable: (on: boolean) => void;
  onConnect: () => void;
  onSignOut: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const state = !view.enabled ? "disabled" : (status?.state ?? "checking");
  const remote = view.type !== "stdio";
  const auth = status?.auth;
  const keyed = view.headerKeys.some((k) => k.toLowerCase() === "authorization");
  const canSignIn = remote && (Boolean(view.oauth) || Boolean(auth) || (state === "needs-auth" && !keyed));
  const tools = status?.tools ?? [];
  const stateText =
    state === "connected"
      ? `${tools.length} tool${tools.length === 1 ? "" : "s"}`
      : state === "needs-auth"
        ? canSignIn
          ? "Needs sign-in"
          : "Key refused"
        : state === "failed"
          ? "Can't connect"
          : state === "disabled"
            ? "Off"
            : "Checking…";
  return (
    <div className={`mcp-server${view.enabled ? "" : " off"}`}>
      <label className="switch" title={view.enabled ? "On" : "Off"}>
        <input type="checkbox" aria-label={`Use ${view.name}`} checked={view.enabled} onChange={(e) => onEnable(e.target.checked)} />
        <span />
      </label>
      <div className="mcp-server-main">
        <div className="mcp-server-name">
          <span className={`mcp-dot ${state}`} aria-hidden />
          <span className="mcp-name-text">{view.name}</span>
          <span className="tag">{typeLabel(view.type)}</span>
          {state === "connected" && tools.length > 0 ? (
            <button className="mcp-state link" aria-expanded={open} onClick={onToggleTools}>
              {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
              {stateText}
            </button>
          ) : (
            <span className={`mcp-state ${state}`}>{stateText}</span>
          )}
        </div>
        <code className="mcp-target" title={view.target}>
          {view.target}
        </code>
        {(view.envKeys.length > 0 || view.headerKeys.length > 0) && <div className="mcp-keys">{[...view.envKeys, ...view.headerKeys].join(" · ")}</div>}
        {auth?.signedIn && (
          <div className="mcp-meta">
            Signed in{auth.expiresAt ? ` · ${minutesLeft(auth.expiresAt)}` : ""}
            {auth.needsScopes ? ` · wants ${auth.needsScopes}` : ""}
          </div>
        )}
        {view.locked && <p className="mcp-error">Its saved secrets can&apos;t be opened on this computer. Edit it and enter them again.</p>}
        {state !== "connected" && state !== "disabled" && status?.error && <p className="mcp-error">{status.error}</p>}
        {error && <p className="mcp-error">{error}</p>}
        {busy && <div className="mcp-meta">{busy}</div>}
        {open && state === "connected" && (
          <ul className="mcp-tool-list">
            {tools.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code>
                {t.description && <span>{t.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mcp-actions">
        {canSignIn && view.enabled && (state === "needs-auth" || !auth?.signedIn) && (
          <button className="button primary" disabled={Boolean(busy)} onClick={onConnect}>
            {auth?.signedIn || auth?.needsScopes ? "Reconnect" : "Connect"}
          </button>
        )}
        {auth?.signedIn && (
          <button className="button ghost" disabled={Boolean(busy)} onClick={onSignOut}>
            Sign out
          </button>
        )}
        <button className="button ghost" disabled={Boolean(busy)} onClick={onEdit}>
          Edit
        </button>
        <button className="button ghost danger" disabled={Boolean(busy)} onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

function ReviewForm({
  review: r,
  setReview,
  queued,
  error,
  saving,
  onSave,
  onCancel,
}: {
  review: Review;
  setReview: React.Dispatch<React.SetStateAction<Review | null>>;
  queued: number;
  error: string | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<Review>) => setReview((x) => (x ? { ...x, ...patch } : x));
  const setPair = (i: number, patch: Partial<Pair>) => set({ pairs: r.pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const isCommand = r.type === "stdio";
  // A new command, or one whose command line changed, runs only after the user says so.
  const needsConsent = isCommand && r.line.trim() !== (r.approvedLine ?? "").trim();
  let warnings: string[] = [];
  let words: string[] = [];
  if (isCommand) {
    words = splitCommandLine(r.line.trim());
    if (words.length) warnings = commandWarnings({ type: "stdio", command: words[0]!, args: words.slice(1) });
  }
  const probe = typeof r.probe === "object" ? r.probe : null;
  const signIn = r.previous === null && probe?.auth === "oauth" && !hasAuthHeader(r);
  const port = Number(r.callbackPort) || DEFAULT_CALLBACK_PORT;
  const callbackUrl = `http://127.0.0.1:${port}/callback`;
  const pairLabel = isCommand ? "Env" : "Headers";

  return (
    <form
      className="mcp-review"
      aria-label={r.previous ? `Edit ${r.previous}` : "Add a server"}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="mcp-review-head">
        <strong>{r.previous ? `Edit ${r.previous}` : "Add a server"}</strong>
        {queued > 0 && <span className="mcp-meta">{queued} more after this one</span>}
      </div>

      <div className="mcp-field">
        <span className="mcp-label">Name</span>
        <input className="text-input" value={r.name} spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
      </div>

      {isCommand ? (
        <div className="mcp-field">
          <span className="mcp-label">Command</span>
          <input className="text-input mono" value={r.line} spellCheck={false} onChange={(e) => set({ line: e.target.value, trusted: false })} />
        </div>
      ) : (
        <>
          <div className="mcp-field">
            <span className="mcp-label">URL</span>
            <input className="text-input mono" value={r.url} spellCheck={false} onChange={(e) => set({ url: e.target.value, probe: null })} />
          </div>
          <div className="mcp-field">
            <span className="mcp-label" />
            <span className={`mcp-probe${probe && !probe.ok ? " bad" : ""}`}>
              {r.probe === "running"
                ? "Checking the server…"
                : !probe
                  ? ""
                  : !probe.ok
                    ? `Couldn't reach it: ${probe.error ?? "no answer"}. You can still add it.`
                    : probe.auth === "oauth"
                      ? `Wants a sign-in${probe.serverName ? ` (${probe.serverName})` : ""}. You'll approve it in the browser.`
                      : probe.auth === "token"
                        ? "Wants a key. Add an Authorization header, e.g. Bearer <token>."
                        : `Ready${probe.serverName ? `: ${probe.serverName}` : ""}${probe.transport === "sse" ? " (SSE)" : ""}.`}
            </span>
          </div>
        </>
      )}

      {r.pairs.map((p, i) => (
        <div className="mcp-field" key={i}>
          <span className="mcp-label">{i === 0 ? pairLabel : ""}</span>
          <div className="mcp-pair">
            <input className="text-input mono mcp-pair-key" aria-label={`${pairLabel} name`} value={p.key} placeholder={isCommand ? "API_KEY" : "Authorization"} spellCheck={false} onChange={(e) => setPair(i, { key: e.target.value })} />
            <input
              className="text-input mono mcp-pair-value"
              aria-label={`${p.key || pairLabel} value`}
              type="password"
              autoComplete="off"
              value={p.value}
              placeholder={p.stored ? "stored, unchanged" : "value or ${ENV_VAR}"}
              onChange={(e) => setPair(i, { value: e.target.value })}
            />
            <button type="button" className="button ghost" onClick={() => set({ pairs: r.pairs.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="mcp-field">
        <span className="mcp-label">{r.pairs.length ? "" : pairLabel}</span>
        <button type="button" className="button ghost" onClick={() => set({ pairs: [...r.pairs, { key: "", value: "", stored: false }] })}>
          {isCommand ? "Add variable" : "Add header"}
        </button>
      </div>

      {!isCommand && (
        <div className="mcp-advanced">
          <button type="button" className="mcp-disclosure" aria-expanded={r.advanced} onClick={() => set({ advanced: !r.advanced })}>
            {r.advanced ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            Sign-in settings
          </button>
          {r.advanced && (
            <>
              <p className="mcp-note">Leave empty to register automatically. Use your own OAuth client when the server doesn&apos;t allow that; register this callback URL with it.</p>
              <div className="mcp-field">
                <span className="mcp-label">Callback URL</span>
                <div className="mcp-pair">
                  <code className="mcp-callback">{callbackUrl}</code>
                  <button type="button" className="button ghost" title="Copy" onClick={() => void navigator.clipboard?.writeText(callbackUrl)}>
                    <Copy size={13} aria-hidden /> Copy
                  </button>
                </div>
              </div>
              <div className="mcp-field">
                <span className="mcp-label">Client ID</span>
                <input className="text-input mono" value={r.clientId} spellCheck={false} onChange={(e) => set({ clientId: e.target.value })} />
              </div>
              <div className="mcp-field">
                <span className="mcp-label">Client secret</span>
                <input
                  className="text-input mono"
                  type="password"
                  autoComplete="off"
                  value={r.clientSecret}
                  placeholder={r.hasClientSecret ? "stored, unchanged" : "only for confidential clients"}
                  onChange={(e) => set({ clientSecret: e.target.value })}
                />
              </div>
              <div className="mcp-field">
                <span className="mcp-label">Scopes</span>
                <input className="text-input mono" value={r.scopes} placeholder="the server's own list" spellCheck={false} onChange={(e) => set({ scopes: e.target.value })} />
              </div>
              <div className="mcp-field">
                <span className="mcp-label">Callback port</span>
                <input className="text-input mono mcp-port" inputMode="numeric" value={r.callbackPort} placeholder={String(DEFAULT_CALLBACK_PORT)} onChange={(e) => set({ callbackPort: e.target.value.replace(/\D/g, "") })} />
              </div>
            </>
          )}
        </div>
      )}

      {needsConsent && words.length > 0 && (
        <div className="mcp-consent" role="group" aria-label="Run this command?">
          <p className="mcp-consent-title">This runs a program on your computer</p>
          <p className="mcp-note">Each agent starts it with your user&apos;s rights, every time it&apos;s used. Only add commands you trust.</p>
          <code className="mcp-command">
            {joinCommandLine(words)}
            {r.pairs.filter((p) => p.key.trim()).length > 0 && `\n${r.pairs.filter((p) => p.key.trim()).map((p) => `${p.key.trim()}=•••`).join(" ")}`}
          </code>
          {warnings.length > 0 && (
            <ul className="mcp-warnings">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <label className="mcp-check">
            <input type="checkbox" checked={r.trusted} onChange={(e) => set({ trusted: e.target.checked })} />I trust this command
          </label>
        </div>
      )}

      {error && <p className="mcp-error">{error}</p>}
      <div className="mcp-review-actions">
        <button type="button" className="button ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={saving || (needsConsent && !r.trusted)}>
          {saving ? "Saving…" : r.previous ? "Save" : signIn ? "Add and sign in" : "Add server"}
        </button>
      </div>
    </form>
  );
}
