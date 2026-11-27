import { type Ref, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, ChevronRight, LayoutGrid, Palette, Plug, Puzzle } from "lucide-react";
import type { ExtensionProposalView } from "../../../shared/types";
import { api } from "../api";
import { Markdown } from "../markdown";
import { PluginParts } from "./PluginParts";
import { AppThemeControls } from "./AppThemeControls";
import { useStore } from "../store";
import "../styles/creator.css";
import { StyleSpecimen } from "./StyleSpecimen";
import { SchedulePreview } from "./SchedulePreview";
import type { AppCheckEvidence } from "../../../shared/types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** SKILL.md for the preview: its YAML frontmatter as a code block, so it doesn't run together as one paragraph. */
export function previewMarkdown(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return md;
  return "```yaml\n" + m[1] + "\n```\n\n" + md.slice(m[0].length);
}

/** Inline transcript card for reviewing and installing/rejecting a Creator mode proposal. */
export function ProposalCard({ proposalId, threadId }: { proposalId: string; threadId: string }) {
  const [proposal, setProposal] = useState<ExtensionProposalView | null | undefined>(undefined);
  const [busy, setBusy] = useState<"install" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  // Where Install puts it: the user's pick, starting from the scope the agent proposed.
  const [pick, setPick] = useState<"project" | "global" | null>(null);
  const inFlightRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const refocusRef = useRef(false);

  const noticeCount = useStore((s) => (s.events[threadId] ?? []).filter((e) => e.event.kind === "notice").length);
  const seenNoticesRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const view = await api().getExtensionProposal(proposalId);
      setProposal(view);
    } catch {
      setProposal(null);
    }
  }, [proposalId]);

  useEffect(() => {
    let cancelled = false;
    setProposal(undefined);
    setActionError(null);
    setPick(null);
    setPreviewOpen(false);
    setPreviewBusy(false);
    setConfirmRemove(false);
    seenNoticesRef.current = null;
    void api()
      .getExtensionProposal(proposalId)
      .then((view) => {
        if (!cancelled) setProposal(view);
      })
      .catch(() => {
        if (!cancelled) setProposal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);

  useEffect(() => {
    if (seenNoticesRef.current === null) {
      seenNoticesRef.current = noticeCount;
      return;
    }
    if (noticeCount !== seenNoticesRef.current) {
      seenNoticesRef.current = noticeCount;
      void load();
    }
  }, [noticeCount, load]);

  // The clicked button unmounts when the status changes: keep keyboard focus in the card.
  useEffect(() => {
    if (!refocusRef.current || busy !== null) return;
    refocusRef.current = false;
    const card = cardRef.current;
    if (!card || (document.activeElement && document.activeElement !== document.body && card.contains(document.activeElement))) return;
    const next = card.querySelector<HTMLElement>(".proposal-foot button:not(:disabled)");
    (next ?? card).focus();
  }, [proposal, busy]);

  if (proposal === undefined) {
    return (
      <div className="proposal-card proposal-card-loading" aria-busy="true">
        Loading proposal…
      </div>
    );
  }
  if (!proposal) return null;

  const draft = proposal.draft;
  const appProps: Pick<ProposalCardViewProps, "onPreview" | "onOpenApp"> =
    draft.kind === "app"
      ? {
          onPreview: () => {
            void api()
              .appInfo(draft.draftKey)
              .then((a) => a && useStore.getState().openApp(a));
          },
          onOpenApp: () => {
            const key = proposal.scope.kind === "project" ? `p~${proposal.scope.projectId}~${draft.name}` : `g~${draft.name}`;
            void api()
              .appInfo(key)
              .then((a) => a && useStore.getState().openApp(a));
            void useStore.getState().loadApps();
          },
        }
      : {};

  const handleInstall = async () => {
    if (inFlightRef.current || busy !== null) return;
    inFlightRef.current = true;
    refocusRef.current = cardRef.current?.contains(document.activeElement) ?? false;
    setBusy("install");
    setActionError(null);
    try {
      const updated = await api().installExtension(proposal.id, pick ?? proposal.scope.kind);
      setProposal(updated);
      if (updated.status === "installed" && updated.draft.kind === "skill") {
        void api()
          .listSkills()
          .then((skills) => useStore.setState({ skills }))
          .catch(() => {});
      }
      if (updated.status === "installed" && updated.draft.kind === "app") {
        void useStore.getState().loadApps();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      void load();
    } finally {
      inFlightRef.current = false;
      setBusy(null);
    }
  };

  const handleReject = async () => {
    if (inFlightRef.current || busy !== null) return;
    inFlightRef.current = true;
    refocusRef.current = cardRef.current?.contains(document.activeElement) ?? false;
    setBusy("reject");
    setActionError(null);
    try {
      const updated = await api().rejectExtension(proposal.id);
      setProposal(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      void load();
    } finally {
      inFlightRef.current = false;
      setBusy(null);
    }
  };

  return (
    <ProposalCardView
      ref={cardRef}
      proposal={proposal}
      busy={busy}
      actionError={actionError}
      previewOpen={previewOpen}
      onTogglePreview={() => {
        if (draft.kind !== "theme" || previewOpen) { setPreviewOpen((v) => !v); return; }
        if (previewBusy) return;
        setPreviewBusy(true);
        setActionError(null);
        void api().getExtensionThemePreview(proposal.id).then(() => setPreviewOpen(true)).catch((err) => setActionError(err instanceof Error ? err.message : String(err))).finally(() => setPreviewBusy(false));
      }}
      previewBusy={previewBusy}
      onInstall={handleInstall}
      onReject={handleReject}
      scopePick={pick ?? proposal.scope.kind}
      onScopePick={setPick}
      {...appProps}
      onUninstall={proposal.installId && (draft.kind === "theme" || draft.kind === "automation") ? async () => {
        if (!confirmRemove) { setConfirmRemove(true); return; }
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setActionError(null);
        setBusy("install");
        try {
          await api().uninstallExtension(proposal.installId!);
          setConfirmRemove(false);
          await load();
        } catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
        finally { inFlightRef.current = false; setBusy(null); }
      } : undefined}
      confirmRemove={confirmRemove}
      onCancelUninstall={() => setConfirmRemove(false)}
    />
  );
}

export interface ProposalCardViewProps {
  proposal: ExtensionProposalView;
  busy: "install" | "reject" | null;
  actionError: string | null;
  previewOpen: boolean;
  onTogglePreview(): void;
  onInstall(): void;
  onReject(): void;
  /** The scope Install uses, shown as a picker while the proposal waits and the thread has a project. */
  scopePick?: "project" | "global";
  onScopePick?(scope: "project" | "global"): void;
  /** Opens the draft app where it will open (modal or floating), for an app proposal that can still be reviewed. */
  onPreview?(): void;
  /** Opens the installed app. */
  onOpenApp?(): void;
  onUninstall?(): void;
  confirmRemove?: boolean;
  previewBusy?: boolean;
  onCancelUninstall?(): void;
  ref?: Ref<HTMLDivElement>;
}

/** The card itself, stateless: every status renders from props (tests render it directly). */
export function ProposalCardView({ proposal, busy, actionError, previewOpen, onTogglePreview, onInstall, onReject, scopePick, onScopePick, onPreview, onOpenApp, onUninstall, confirmRemove, previewBusy, onCancelUninstall, ref }: ProposalCardViewProps) {
  const { draft, scope, status } = proposal;
  const scopeLabel = scope.kind === "project" ? `Project${proposal.projectName ? `: ${proposal.projectName}` : ""}` : "Global";
  const waiting = status === "staged" || (status === "failed" && proposal.retryable !== false);
  // The picker replaces the head's scope chip while the user can still choose; Chats threads have only Global.
  const choice = waiting && onScopePick && (draft.kind === "skill" || draft.kind === "connector") ? proposal.projectChoice : null;
  const picked = scopePick ?? scope.kind;
  const KindIcon = draft.kind === "skill" ? Puzzle : draft.kind === "app" ? LayoutGrid : draft.kind === "theme" ? Palette : draft.kind === "automation" ? CalendarClock : Plug;
  const kindLabel = draft.kind === "skill" ? "Skill" : draft.kind === "app" ? "App" : draft.kind === "theme" ? "Page theme" : draft.kind === "automation" ? "Automation" : "Connector";
  const libraryTarget = draft.kind === "skill" ? "skills" : draft.kind === "automation" ? "automations" : "connectors";
  const errorText = actionError ?? (status === "failed" ? (proposal.error ?? "Installation failed.") : null);

  return (
    <div ref={ref} tabIndex={-1} className={`proposal-card proposal-kind-${draft.kind} status-${status}`} data-proposal-id={proposal.id} onKeyDown={(e) => {
      if (e.key === "Escape" && confirmRemove) { e.preventDefault(); e.stopPropagation(); onCancelUninstall?.(); }
    }}>
      <div className="proposal-head">
        <span className="proposal-icon" aria-hidden>
          <KindIcon size={15} strokeWidth={1.75} />
        </span>
        <span className="proposal-name">{draft.kind === "app" || draft.kind === "theme" ? draft.title : draft.kind === "automation" ? draft.input.name : draft.name}</span>
        <span className="proposal-chip">{kindLabel}</span>
        {!choice && <span className="proposal-chip">{scopeLabel}</span>}
        {status !== "staged" && (
          <span className={`proposal-status ${status}`}>
            {status === "installed" ? "Installed" : status === "rejected" ? "Rejected" : "Failed"}
          </span>
        )}
      </div>

      <div className="proposal-body">
        {draft.kind === "skill" ? (
          <>
            <p className="proposal-desc">{draft.description}</p>
            <ul className="proposal-files">
              {draft.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  <span className="proposal-size">{formatBytes(f.bytes)}</span>
                </li>
              ))}
            </ul>
            {draft.skillMd && (
              <div className="proposal-preview-wrap">
                <button
                  type="button"
                  className="proposal-preview-toggle"
                  aria-expanded={previewOpen}
                  onClick={onTogglePreview}
                >
                  <ChevronRight className={`proposal-chevron${previewOpen ? " open" : ""}`} size={14} strokeWidth={1.75} aria-hidden />
                  <span>{previewOpen ? "Hide SKILL.md" : "Preview SKILL.md"}</span>
                </button>
                {previewOpen && (
                  <div className="proposal-preview msg-assistant">
                    <Markdown text={previewMarkdown(draft.skillMd)} />
                  </div>
                )}
              </div>
            )}
          </>
        ) : draft.kind === "app" ? (
          <>
            <p className="proposal-desc">{draft.description}</p>
            {!!draft.tools?.length && <><div className="proposal-grants-label">Agent tools</div><ul className="proposal-grants">{draft.tools.map((t) => <li key={t.name}><code>{t.name}</code><span>{t.description}</span></li>)}</ul><p className="proposal-desc">Tools can change this plugin's saved data. They ask before running, except in Full access; Plan mode blocks them.</p></>}
            <PluginParts parts={draft.parts} />
            <ProposalChecks key={proposal.id} id={proposal.id} />
            {(waiting || status === "installed") && draft.parts?.some((p) => p.kind === "app-theme" && p.change !== "removed") && <AppThemeControls key={proposal.id} {...(proposal.status === "installed" ? { pluginKey: `g~${draft.name}` } : { proposalId: proposal.id })} />}
            {!!draft.cards?.length && <p className="proposal-desc">Chat cards: {draft.cards.join(", ")}. Cards cannot change data.</p>}
            {draft.grants.length > 0 ? (
              <>
                <div className="proposal-grants-label">Can use</div>
                <ul className="proposal-grants">
                  {draft.grants.map((g) => (
                    <li key={`${g.server}.${g.tool}`}>
                      <code>{`${g.server}.${g.tool}`}</code>
                      <span className={`proposal-access ${g.access}`}>{g.access === "read" ? "Read" : g.access === "write" ? "Can change data" : "Unknown"}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="proposal-desc">Uses no connectors.</p>
            )}
            {draft.grants.some((g) => g.access === "write") && (
              <div className="proposal-warning">
                <AlertTriangle size={13} strokeWidth={1.75} aria-hidden />
                <span>It asks you before each call that can change data.</span>
              </div>
            )}
            <ul className="proposal-files">
              {draft.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  {f.change && (
                    <span className={`proposal-change ${f.change}`}>
                      {f.change === "added" ? "New" : f.change === "changed" ? "Changed" : "Removed"}
                    </span>
                  )}
                  {f.change !== "removed" && <span className="proposal-size">{formatBytes(f.bytes)}</span>}
                </li>
              ))}
            </ul>
          </>
        ) : draft.kind === "theme" ? (
          <>
            {draft.description && <p className="proposal-desc">{draft.description}</p>}
            <p className="proposal-desc">Based on {draft.baseName}. Installing changes no page; choose it in Design → Style.</p>
            <ul className="proposal-files creator-token-list">
              {draft.tokens.map((t) => <li key={`${t.scheme}:${t.name}`}><code>{t.name}</code><span>{t.scheme}</span><code>{t.before} → {t.value}</code></li>)}
            </ul>
            {waiting && <button type="button" className="button ghost" disabled={previewBusy} aria-expanded={previewOpen} onClick={onTogglePreview}>{previewBusy ? "Preparing preview…" : previewOpen ? "Hide preview" : "Preview page theme"}</button>}
            {waiting && previewOpen && <ThemeSpecimen url={draft.previewUrl} title={draft.title} />}
          </>
        ) : draft.kind === "automation" ? (
          <>
            <p className="proposal-desc">{draft.scheduleText} · {draft.input.agent} · {draft.input.model ?? "default model"}</p>
            <p className="proposal-desc">{draft.input.budgetUsd === null ? "No per-run budget limit" : `$${draft.input.budgetUsd} per run`} · Missed runs: {draft.input.missed === "skip" ? "skip" : "run once to catch up"}</p>
            <div className="creator-automation-prompt"><pre>{draft.input.prompt}</pre></div>
            <SchedulePreview {...draft.input} enabled={false} />
            <p className="proposal-desc">Saved Off, with Ask permissions. Enable it or Run now in Library → Automations. Installing starts no run.</p>
          </>
        ) : (
          <>
            <div className="proposal-target">
              <span className="proposal-transport">{draft.type.toUpperCase()}</span>
              <code className="proposal-command">{draft.target}</code>
            </div>
            {draft.type === "stdio" && (
              <div className="proposal-warning">
                <AlertTriangle size={13} strokeWidth={1.75} aria-hidden />
                <span>Runs a local program on this computer.</span>
              </div>
            )}
            {draft.requiredVars.length > 0 && (
              <div className="proposal-vars">
                <span className="proposal-vars-label">Required variables:</span>
                <div className="proposal-vars-list">
                  {draft.requiredVars.map((v) => (
                    <code key={v}>{`\${${v}}`}</code>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {errorText && (
          <div className="proposal-error" role="alert">
            {errorText}
          </div>
        )}
      </div>

      <div className="proposal-foot">
        {choice && (
          <div className="proposal-scope">
            <span className="proposal-scope-label">Install to</span>
            <div className="segmented compact" role="group" aria-label="Install to">
              <button type="button" className={picked === "project" ? "on" : ""} aria-pressed={picked === "project"} disabled={busy !== null} title={choice.name} onClick={() => onScopePick?.("project")}>
                {`Project: ${choice.name}`}
              </button>
              <button type="button" className={picked === "global" ? "on" : ""} aria-pressed={picked === "global"} disabled={busy !== null} title="Every project" onClick={() => onScopePick?.("global")}>
                Global
              </button>
            </div>
          </div>
        )}
        {status === "staged" && (
          <>
            {draft.kind === "app" && (
              <button type="button" className="button ghost" onClick={onPreview}>
                Preview
              </button>
            )}
            <button type="button" className="button ghost" disabled={busy !== null} onClick={onReject}>
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            <button type="button" className="button primary" disabled={busy !== null} onClick={onInstall}>
              {busy === "install"
                 ? (draft.kind === "app" || draft.kind === "theme" || draft.kind === "automation") && draft.update
                  ? "Updating…"
                  : "Installing…"
                : (draft.kind === "app" || draft.kind === "theme" || draft.kind === "automation") && draft.update
                  ? "Update"
                  : "Install"}
            </button>
          </>
        )}
        {status === "installed" && (
          <>
            {draft.kind === "app" ? (
              <button type="button" className="button" onClick={onOpenApp}>
                Open app
              </button>
            ) : draft.kind === "theme" ? (
              <>
                <span className="proposal-desc">{proposal.installId ? "Available in Design → Style" : "No longer managed by this card"}</span>
                {onUninstall && <button type="button" className="button ghost danger" disabled={busy !== null} onClick={onUninstall}>{busy ? "Uninstalling…" : confirmRemove ? "Confirm uninstall" : "Uninstall"}</button>}
              </>
            ) : (
              <button type="button" className="button" onClick={() => useStore.setState({ libraryTab: libraryTarget })}>
                Open in Library
              </button>
            )}
          </>
        )}
        {status === "failed" && (
          <>
            {draft.kind === "app" && (
              <button type="button" className="button ghost" onClick={onPreview}>
                Preview
              </button>
            )}
            <button type="button" className="button ghost" disabled={busy !== null} onClick={onReject}>
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            {proposal.retryable !== false && (
              <button type="button" className="button primary" disabled={busy !== null} onClick={onInstall}>
                {busy === "install" ? "Retrying…" : "Retry"}
              </button>
            )}
          </>
        )}
        {status === "installed" && draft.kind === "automation" && onUninstall && <button type="button" className="button ghost danger" disabled={busy !== null} onClick={onUninstall}>{busy ? "Uninstalling…" : confirmRemove ? "Confirm uninstall" : "Uninstall"}</button>}
      </div>
    </div>
  );
}

function ThemeSpecimen({ url, title }: { url: string; title: string }) {
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  return <div className="creator-theme-preview">
    <div className="segmented compact" role="group" aria-label="Page theme preview scheme">
      {(["light", "dark"] as const).map((s) => <button type="button" key={s} className={scheme === s ? "on" : ""} aria-pressed={scheme === s} onClick={() => setScheme(s)}>{s === "light" ? "Light" : "Dark"}</button>)}
    </div>
    <StyleSpecimen title={`${title} ${scheme} page theme preview`} url={url.replace(/theme=light/, `theme=${scheme}`)} />
  </div>;
}

function ProposalChecks({ id }: { id: string }) {
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  const [evidence, setEvidence] = useState<AppCheckEvidence[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const request = useRef(0);
  const check = useCallback(async (mode?: "samples" | "real") => {
    const generation = ++request.current;
    setBusy(true); setError("");
    try { const rows = await api().appProposalChecks(id, scheme, mode); if (generation === request.current) setEvidence(rows); }
    catch (err) { if (generation === request.current) setError(String(err)); }
    finally { if (generation === request.current) setBusy(false); }
  }, [id, scheme]);
  useEffect(() => { void check(); return () => { request.current++; }; }, [check]);
  const rows = evidence.filter((r) => r.scheme === scheme);
  return <section aria-label="App checks"><div className="proposal-grants-label">App checks</div>
    <div className="segmented compact">{(["light", "dark"] as const).map((s) => <button type="button" key={s} aria-pressed={scheme === s} onClick={() => setScheme(s)}>{s}</button>)}</div>
    {busy ? <p role="status">Checking…</p> : error ? <p role="alert">{error}</p> : !rows.length ? <p>Not checked</p> : <ul>{rows.map((r) => <li key={r.scenario}>{r.scenario}: {r.ok ? "Passed" : "Failed"} · {r.placement}, {r.width} × {r.height} · {r.realConnector ? "Used a real connector" : r.detail}</li>)}</ul>}
    <button type="button" className="button ghost" disabled={busy} onClick={() => void check("samples")}>Check sample data</button>
    <button type="button" className="button ghost" disabled={busy} onClick={() => void check("real")}>Real read-only connector check</button>
  </section>;
}
