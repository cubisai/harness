import { useEffect, useRef, useState } from "react";
import type { Density, Motion, PermissionMode, SettingsView, Theme } from "../../../shared/types";
import type { DesignReferenceStatus } from "../../../shared/design-mutation";
import { DEFAULT_COMMIT_INSTRUCTIONS, MAX_RUNNING_CHOICES } from "../../../shared/types";
import { api } from "../api";
import { ProvidersSection } from "./ProviderSheet";
import { useStore, type LibraryTab } from "../store";
import { ANTIGRAVITY_ACK_VERSION } from "../../../shared/provider-rules";
import { CHEAP_MODEL_HINTS } from "../../../shared/learn";
import { ZOOM_STEPS } from "../../../shared/zoom";
import { StepSlider } from "./StepSlider";
import { UnsupportedChip } from "./UnsupportedChip";
import { Select, selectPopupOpen } from "./Select";
import { SPLASHES, playSplash, splashVisible } from "./Splash";
import { backgroundChoices } from "./LearnedTab";

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const MOTIONS: { id: Motion; label: string }[] = [
  { id: "instant", label: "Instant" },
  { id: "subtle", label: "Subtle" },
  { id: "full", label: "Full" },
];

const DENSITIES: { id: Density; label: string }[] = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
];
const zoomKeys = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘= ⌘− ⌘0" : "Ctrl+= Ctrl+− Ctrl+0";

const MODES: { id: PermissionMode; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "auto-edit", label: "Auto-edit" },
  { id: "plan", label: "Plan" },
  { id: "full", label: "Full" },
];

/** A cheap model, by the same hints the Learned tab's background picker uses. */
const isCheap = (m: { id: string; label: string }) => CHEAP_MODEL_HINTS.some((h) => m.id.toLowerCase().includes(h) || m.label.toLowerCase().includes(h));

/** The left-nav groups, in order, and the sections each shows. */
export const SETTINGS_GROUPS = [
  { id: "appearance", label: "Appearance", sections: ["Appearance"] },
  { id: "threads", label: "Threads", sections: ["New threads", "Commit messages", "Background", "Issues", "Editor"] },
  { id: "agents", label: "Agents & Providers", sections: ["Providers", "Agents", "Antigravity"] },
  { id: "skills", label: "Skills & MCP", sections: ["Skills", "MCP servers"] },
  { id: "design", label: "Design", sections: ["Design references"] },
  { id: "data", label: "Data & Security", sections: ["Data"] },
  { id: "updates", label: "Updates", sections: ["Updates"] },
  { id: "experiments", label: "Experiments", sections: ["Code mode"] },
] as const;

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]["id"];

/**
 * Where each section of the single scrolling sheet went. "Skills and agents"
 * lands in Skills & MCP; its agent list moved to Agents & Providers and its
 * data-folder button to Data & Security.
 */
export const FORMER_SECTIONS: Record<string, SettingsGroup> = {
  Appearance: "appearance",
  "New threads": "threads",
  Editor: "threads",
  Providers: "agents",
  Updates: "updates",
  "Skills and agents": "skills",
};

/** Settings, as a sheet over the window (⌘, / Ctrl+,): a left nav of groups, one group's sections at a time. */
/** Rich replies, one control over two settings: interactive blocks (guide tokens) and link previews (network). */
export type RichReplies = "off" | "on" | "links";

const RICH_REPLIES: { value: RichReplies; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
  { value: "links", label: "On + link previews" },
];

/** The stop the two settings sit on; link previews alone (an older setup) shows as the fullest stop. */
export function richRepliesOf(s: Pick<SettingsView, "uiBlocks" | "linkPreviews">): RichReplies {
  if (s.linkPreviews) return "links";
  return s.uiBlocks ? "on" : "off";
}

/** The two settings a stop writes. */
export function richRepliesPatch(stop: RichReplies): Pick<SettingsView, "uiBlocks" | "linkPreviews"> {
  return { uiBlocks: stop !== "off", linkPreviews: stop === "links" };
}

export function SettingsSheet() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const [group, setGroup] = useState<SettingsGroup>("appearance");
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // An open pick list takes Escape for itself.
      if (e.key === "Escape" && selectPopupOpen()) return;
      // A preview splash takes the key to close itself.
      if (e.key === "Escape" && splashVisible()) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open || !settings) return null;

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="sheet settings-sheet" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} ref={panel}>
        <div className="sheet-head">
          <h2>Settings</h2>
          <button className="button ghost" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings groups">
            {SETTINGS_GROUPS.map((g) => (
              <button
                key={g.id}
                role="tab"
                id={`settings-tab-${g.id}`}
                aria-selected={group === g.id}
                aria-controls="settings-panel"
                className={group === g.id ? "on" : ""}
                onClick={() => setGroup(g.id)}
              >
                {g.label}
              </button>
            ))}
          </nav>
          <div className="settings-content" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${group}`}>
            <SettingsGroupContent group={group} settings={settings} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** One group's sections. */
export function SettingsGroupContent({ group, settings }: { group: SettingsGroup; settings: SettingsView }) {
  const agents = useStore((s) => s.agents);
  const skills = useStore((s) => s.skills);
  const appUpdate = useStore((s) => s.appUpdate);
  const editors = useStore((s) => s.editors);
  const update = (patch: Parameters<ReturnType<typeof api>["updateSettings"]>[0]) =>
    void api().updateSettings(patch).then((s) => useStore.setState({ settings: s }));
  const openLibrary = (tab: LibraryTab) => useStore.setState({ settingsOpen: false, libraryTab: tab });

  const zoom = settings.zoom ?? 1;
  switch (group) {
    case "appearance":
      return (
        <section>
          <h3>Appearance</h3>
          <div className="row">
            <span className="label">Theme</span>
            <div className="segmented">
              {THEMES.map((t) => (
                <button key={t.id} className={settings.theme === t.id ? "on" : ""} onClick={() => update({ theme: t.id })}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <span className="label" title="Your system's reduce-motion setting always wins">Motion</span>
            <div className="segmented">
              {MOTIONS.map((m) => (
                <button key={m.id} className={(settings.motion ?? "full") === m.id ? "on" : ""} onClick={() => update({ motion: m.id })}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <span className="label">Density</span>
            <div className="segmented">
              {DENSITIES.map((d) => (
                <button key={d.id} className={(settings.density ?? "comfortable") === d.id ? "on" : ""} onClick={() => update({ density: d.id })}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <span className="label" title={`Scales the whole app (${zoomKeys})`}>Text size</span>
            <div className="settings-slider">
              <StepSlider
                ariaLabel="Text size"
                labels={ZOOM_STEPS.map((z) => `${Math.round(z * 100)}%`)}
                index={Math.max(0, ZOOM_STEPS.indexOf(zoom as (typeof ZOOM_STEPS)[number]))}
                label={zoom === 1 ? "100% · default" : `${Math.round(zoom * 100)}%`}
                ends={["Smaller", "Larger"]}
                hotFrom={ZOOM_STEPS.indexOf(1.25)}
                title={`Scales the whole app (${zoomKeys})`}
                reset={zoom !== 1 ? { title: "Back to 100%", onReset: () => update({ zoom: 1 }) } : undefined}
                onPick={(i) => update({ zoom: ZOOM_STEPS[i] ?? 1 })}
              />
            </div>
          </div>
          <div className="row">
            <span className="label" title="Checklists, calculators, comparisons, timelines, charts, reply buttons, forms, stat tiles and cards inside replies; link previews">Rich replies</span>
            <div className="segmented">
              {RICH_REPLIES.map((o) => (
                <button key={o.value} className={richRepliesOf(settings) === o.value ? "on" : ""} onClick={() => update(richRepliesPatch(o.value))}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <p className="note">Lets agents answer with small interactive blocks and makes reply tables sortable: about 120 tokens per new session, and blocks agents write anyway always render. "+ link previews" also fetches favicons, titles and thumbnails from the linked https sites, which see your IP address; without it nothing is fetched.</p>
          <div className="row">
            <span className="label" title="The looping clip shown while CubiQ starts">Splash screen</span>
            <Select
              value={settings.splash ?? "agent"}
              options={SPLASHES.map((o) => ({ value: o.id, label: o.label }))}
              onChange={(splash) => update({ splash })}
              ariaLabel="Splash screen"
            />
            <button className="button ghost" disabled={settings.splash === "off"} onClick={playSplash}>
              Preview
            </button>
          </div>
        </section>
      );
    case "threads": {
      const commitPick = settings.git?.commitModel ?? null;
      const commitChoices = backgroundChoices(agents, commitPick);
      const pickCommitAgent = (agent: string) => {
        if (!agent) return update({ git: { commitModel: null, coAuthor: settings.git?.coAuthor ?? false } });
        // A new agent starts on its cheap tier, as commit messages should.
        const options = commitChoices.models(agent);
        const model = (options.find((o) => isCheap({ id: o.value, label: o.label })) ?? options[0])?.value;
        if (model) update({ git: { commitModel: { agent, model }, coAuthor: settings.git?.coAuthor ?? false } });
      };
      return (
        <>
          <section>
            <h3>New threads</h3>
            <div className="row">
              <span className="label">Agent</span>
              <Select
                value={settings.defaultAgent ?? ""}
                options={[
                  { value: "", label: `${agents[0]?.label ?? "Claude"} (default)` },
                  ...agents.slice(1).map((a) => ({ value: a.id, label: a.label })),
                ]}
                onChange={(v) => update({ defaultAgent: v || null })}
                ariaLabel="Default agent"
              />
            </div>
            <div className="row">
              <span className="label">Permissions</span>
              <div className="segmented">
                {MODES.map((m) => (
                  <button key={m.id} className={settings.defaultPermissionMode === m.id ? "on" : ""} onClick={() => update({ defaultPermissionMode: m.id })}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section>
            <h3>Commit messages</h3>
            <div className="row">
              <span className="label">Model</span>
              <Select
                value={commitPick?.agent ?? ""}
                options={commitChoices.agents}
                onChange={pickCommitAgent}
                ariaLabel="Commit message agent"
              />
              {commitPick && (
                <Select
                  value={commitPick.model}
                  options={commitChoices.models(commitPick.agent)}
                  onChange={(model) => update({ git: { commitModel: { agent: commitPick.agent, model }, coAuthor: settings.git?.coAuthor ?? false } })}
                  ariaLabel="Commit message model"
                />
              )}
            </div>
            <div className="row">
              <span className="label">Co-author line</span>
              <div className="segmented">
                {[true, false].map((on) => (
                  <button
                    key={String(on)}
                    type="button"
                    className={(settings.git?.coAuthor ?? false) === on ? "on" : ""}
                    onClick={() => update({ git: { commitModel: settings.git?.commitModel ?? null, coAuthor: on } })}
                  >
                    {on ? "On" : "Off"}
                  </button>
                ))}
              </div>
            </div>
            <CommitInstructions
              value={settings.git?.instructions ?? null}
              onSave={(instructions) =>
                update({ git: { commitModel: settings.git?.commitModel ?? null, coAuthor: settings.git?.coAuthor ?? false, instructions } })
              }
            />
            <p className="note">
              Used by Generate in a worktree thread's Review &amp; merge bar. Automatic picks a cheap model. The instructions set the style; the default asks for a plain,
              Conventional Commits message. The co-author line credits the thread's agent (Claude, Codex, OpenCode or Cursor) with a Co-authored-by trailer.
            </p>
          </section>
          <section>
            <h3>Background</h3>
            <div className="row">
              <span className="label">Run at once</span>
              <div className="segmented">
                {MAX_RUNNING_CHOICES.map((n) => (
                  <button
                    key={n}
                    className={(settings.background?.maxRunning ?? 0) === n ? "on" : ""}
                    onClick={() => update({ background: { maxRunning: n, worktree: settings.background?.worktree ?? false } })}
                  >
                    {n === 0 ? "No limit" : n}
                  </button>
                ))}
              </div>
            </div>
            <div className="row">
              <span className="label">Own worktree</span>
              <div className="segmented">
                {([true, false] as const).map((on) => (
                  <button
                    key={String(on)}
                    className={(settings.background?.worktree ?? false) === on ? "on" : ""}
                    onClick={() => update({ background: { maxRunning: settings.background?.maxRunning ?? 0, worktree: on } })}
                  >
                    {on ? "On" : "Off"}
                  </button>
                ))}
              </div>
            </div>
            <p className="note">Alt+Enter sends a message to a new thread in the background. With a limit, extra background threads wait in the Running list and start when one finishes. With Own worktree on, each starts on its own git branch so its edits stay off your checkout.</p>
          </section>
          <section>
            <h3>Issues</h3>
            <div className="row">
              <span className="label">File issue? cards</span>
              <div className="segmented">
                {([true, false] as const).map((on) => (
                  <button key={String(on)} className={(settings.issueOffers ?? true) === on ? "on" : ""} onClick={() => update({ issueOffers: on })}>
                    {on ? "On" : "Off"}
                  </button>
                ))}
              </div>
            </div>
            <p className="note">In projects with an issue tracker (set up with /issue-setup), the background model reads each reply that mentions a problem. When the reply reports one it didn't fix, a File issue? card offers to file it. Each check costs a few hundred background-model tokens.</p>
          </section>
          <section>
            <h3>Editor</h3>
            <div className="row">
              <span className="label">Open files in</span>
              {editors.length ? (
                <Select
                  value={settings.editor ?? ""}
                  options={[
                    { value: "", label: `${editors[0]!.label} (first found)` },
                    ...editors.slice(1).map((e) => ({ value: e.id, label: e.label })),
                  ]}
                  onChange={(v) => update({ editor: v || null })}
                  ariaLabel="Editor"
                />
              ) : (
                <span className="value">No editors found</span>
              )}
            </div>
            <p className="note">Used by Open in the Changes panel, the Files tab and file links in the conversation. Picking another editor there makes it the default.</p>
          </section>
        </>
      );
    }
    case "agents":
      return (
        <>
          <ProvidersSection />
          <section>
            <h3>Agents</h3>
            <div className="row">
              <span className="label">Installed</span>
              <span className="value">{agents.map((a) => a.label).join(", ")}</span>
            </div>
            <p className="note">Add ACP agents in agents.json in the data folder (Data &amp; Security), then restart the app. The Library lists every agent it knows.</p>
          </section>
          <AntigravityOptIn settings={settings} update={update} />
        </>
      );
    case "skills":
      return (
        <>
          <section>
            <h3>Skills</h3>
            <div className="row">
              <span className="label">Skills</span>
              <span className="value">
                {skills.length > 0 ? `${skills.length} workflow skills in the $ menu, and the rest loaded by the agent as needed` : "No skills installed"}
              </span>
            </div>
            <div className="row">
              <span className="label" />
              <button className="button" onClick={() => openLibrary("skills")}>
                Browse Skills…
              </button>
            </div>
          </section>
          <section>
            <h3>MCP servers</h3>
            <p className="note">Servers every agent gets, and the ones each agent brings from its own config, are in the Library.</p>
            <div className="row">
              <span className="label">MCP tool search</span>
              <div className="segmented">
                {([["auto", "Auto"], ["off", "Off"]] as const).map(([value, label]) => (
                  <button key={value} className={(settings.mcpRouter ?? "auto") === value ? "on" : ""} onClick={() => update({ mcpRouter: value })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="note">For agents without their own (OpenCode): route MCP tools through CubiQ's search when 20+ are enabled, instead of loading every schema.</p>
            <div className="row">
              <span className="label" />
              <button className="button" onClick={() => openLibrary("mcp")}>
                Open MCP Servers…
              </button>
            </div>
          </section>
        </>
      );
    case "design":
      return <DesignReferencesSection />;
    case "data":
      return (
        <section>
          <h3>Data</h3>
          <div className="row">
            <span className="label">Keys</span>
            <span className="value">{settings.secretsEncrypted ? "Encrypted with your system keychain" : "Obfuscated: this system has no keychain"}</span>
          </div>
          <div className="row">
            <span className="label">Data folder</span>
            <button className="button" onClick={() => void api().openDataFolder()}>
              Open Data Folder
            </button>
          </div>
          <div className="row">
            <span className="label">Settings file</span>
            <button
              className="button"
              onClick={() =>
                void api()
                  .exportSettings()
                  .then((path) => path && useStore.getState().showNotice(`Exported to ${path}`))
                  .catch((err: unknown) => useStore.getState().showNotice(err instanceof Error ? err.message : String(err)))
              }
            >
              Export Settings…
            </button>
            <button
              className="button"
              onClick={() =>
                void api()
                  .importSettings()
                  .then((s) => s && useStore.setState({ settings: s }))
                  .catch((err: unknown) => useStore.getState().showNotice(err instanceof Error ? err.message : String(err)))
              }
            >
              Import…
            </button>
          </div>
          <p className="note">
            An export holds your providers, which agent uses which, and these preferences. Keys go in it encrypted for this computer and user account only: on
            another machine, enter them again. Importing replaces your providers.
          </p>
          <p className="note">Threads, settings, agents.json and mcp.json live here. Export a thread from the command palette to keep or move it.</p>
        </section>
      );
    case "experiments":
      return (
        <section>
          <h3>Code mode</h3>
          <div className="row">
            <span className="label">Code mode</span>
            <div className="segmented">
              {([["off", "Off"], ["on", "Read-only + MCP (Recommended)"]] as const).map(([value, label]) => (
                <button key={value} className={(settings.codeMode ?? "off") === value ? "on" : ""} onClick={() => update({ codeMode: value })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="note">
            Agents get run_code: one sandboxed script that chains read, grep, glob and other read-only tools, so a multi-step search costs one call. The agent keeps its own read, search and edit tools. OpenCode 2 uses its own Code Mode. Applies to new threads.
          </p>
        </section>
      );
    case "updates":
      return (
        <section>
          <h3>Updates</h3>
          <div className="row">
            <span className="label">Version</span>
            <span className="value">
              {appUpdate ? `CubiQ ${appUpdate.current}` : "CubiQ"}
              {appUpdate?.ready && ` · ${appUpdate.ready} is ready, and installs when you quit`}
            </span>
          </div>
          <div className="row">
            <span className="label">Auto-update</span>
            <div className="segmented">
              {[true, false].map((on) => (
                <button key={String(on)} className={settings.autoUpdate === on ? "on" : ""} onClick={() => update({ autoUpdate: on })}>
                  {on ? "On" : "Off"}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <span className="label">About</span>
            <button
              className="button"
              onClick={() => {
                useStore.getState().setSettingsOpen(false);
                useStore.getState().setAboutOpen(true);
              }}
            >
              About CubiQ…
            </button>
          </div>
          {appUpdate && !appUpdate.supported && <p className="note">This build doesn't update itself. Installed releases do.</p>}
        </section>
      );
  }
}

/** The GradientDeck design references: download, update or remove, and what is installed. */
function DesignReferencesSection() {
  const [status, setStatus] = useState<DesignReferenceStatus | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState<"download" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);

  useEffect(() => {
    let live = true;
    void api()
      .designReferences()
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(
    () => () => {
      unsubscribe.current?.();
      unsubscribe.current = null;
    },
    [],
  );

  const stop = () => {
    unsubscribe.current?.();
    unsubscribe.current = null;
  };

  const download = () => {
    setBusy("download");
    setError(null);
    setProgress(null);
    stop();
    unsubscribe.current = api().onDesignReferenceProgress((p) => setProgress({ done: p.done, total: p.total }));
    void api()
      .designReferencesDownload()
      .then((res) => {
        stop();
        setProgress(null);
        setBusy(null);
        if (res.ok) {
          setStatus(res.status);
          return;
        }
        if (res.code !== "cancelled") setError(res.message);
        void api().designReferences().then(setStatus).catch(() => {});
      })
      .catch((err: unknown) => {
        stop();
        setProgress(null);
        setBusy(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const remove = () => {
    setBusy("remove");
    setError(null);
    void api()
      .designReferencesRemove()
      .then((s) => setStatus(s))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  const markAsked = () => {
    void api()
      .updateSettings({ designReferencesAsked: true })
      .then((s) => useStore.setState({ settings: s }))
      .catch(() => {});
  };

  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const statusText =
    status === null
      ? "…"
      : status.state === "none"
        ? "Not downloaded"
        : `${status.count.toLocaleString()} references · updated ${new Date(status.fetchedAt).toLocaleDateString()}${status.missing > 0 ? ` · ${status.missing} unavailable` : ""} · ${Math.round(status.bytes / 1e6)} MB`;
  const bar = (
    <span className="sp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <span style={{ display: "block", height: "100%", width: pct + "%", background: "var(--text)", borderRadius: "inherit" }} />
    </span>
  );

  return (
    <section>
      <h3>Design references</h3>
      <div className="row">
        <span className="label">Status</span>
        <span className="value">{statusText}</span>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <span className="label">Download</span>
        {busy === "download" ? (
          <>
            <span className="value">
              {total > 0 ? `Downloading… ${done.toLocaleString()} of ${total.toLocaleString()}` : "Starting…"}
            </span>
            <button className="button ghost" onClick={() => void api().designReferencesCancel()}>
              Cancel
            </button>
          </>
        ) : status?.state === "installed" ? (
          <>
            <button className="button" disabled={busy !== null} onClick={download}>
              Check for updates
            </button>
            <button className="button ghost" disabled={busy !== null} onClick={remove}>
              Remove
            </button>
          </>
        ) : (
          <button
            className="button primary"
            disabled={status === null || busy !== null}
            onClick={() => {
              markAsked();
              download();
            }}
          >
            Download
          </button>
        )}
      </div>
      {busy === "download" && (
        <div className="row">
          <span className="label" />
          {bar}
        </div>
      )}
      {error && (
        <p className="note" role="alert">
          {error}
        </p>
      )}
      <p className="note">
        An additional resource for Design mode (about 43 MB, text only).
      </p>
    </section>
  );
}

/**
 * Antigravity runs Google's own ACP server, and its terms treat third-party
 * access as a breach: off by default, on only after the user acknowledges
 * that, and the acknowledgement is kept (with its disclosure version).
 */
export function AntigravityOptIn({ settings, update }: { settings: SettingsView; update(patch: Partial<SettingsView>): void }) {
  const [understood, setUnderstood] = useState(false);
  const acked = settings.antigravityAck?.version === ANTIGRAVITY_ACK_VERSION;
  const on = settings.antigravity === true && acked;
  return (
    <section>
      <h3>Antigravity</h3>
      <UnsupportedChip note="Gemini-compatible endpoints only" />
      <p className="note">
        CubiQ runs Google's own Antigravity ACP server (agy_acp_server.par) with your own Google sign-in. The binary is Google's, but driving it from another
        app is still third-party access: the Antigravity Terms of Service (section 6) restrict that, and it isn't clear it's allowed, so it could put your account
        at risk. It can't use your OpenAI or Anthropic providers.
      </p>
      {on ? (
        <div className="row">
          <span className="label">Status</span>
          <span className="value">On{settings.antigravityAck ? ` since you accepted the risk on ${new Date(settings.antigravityAck.at).toLocaleDateString()}` : ""}. Restart to apply a change.</span>
          <button className="button" onClick={() => update({ antigravity: false })}>
            Turn Off
          </button>
        </div>
      ) : (
        <>
          <label className="row checkbox-row">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>I understand that using Antigravity here may breach its terms and put my account at risk.</span>
          </label>
          <div className="row">
            <span className="label" />
            <button
              className="button"
              disabled={!understood}
              onClick={() => update({ antigravityAck: { version: ANTIGRAVITY_ACK_VERSION, at: 0 }, antigravity: true })}
            >
              Turn On Antigravity
            </button>
          </div>
          <p className="note">Off by default. Turning it on adds Antigravity when the app restarts, if the ACP server (agy_acp_server.par) is on your PATH.</p>
        </>
      )}
    </section>
  );
}

/** The commit-message style rules: the default until edited, saved when the box loses focus. */
function CommitInstructions({ value, onSave }: { value: string | null; onSave(instructions: string | null): void }) {
  const [draft, setDraft] = useState(value ?? DEFAULT_COMMIT_INSTRUCTIONS);
  useEffect(() => setDraft(value ?? DEFAULT_COMMIT_INSTRUCTIONS), [value]);
  const save = (text: string) => {
    const next = text.trim() && text.trim() !== DEFAULT_COMMIT_INSTRUCTIONS ? text.trim() : null;
    if (next !== value) onSave(next);
  };
  return (
    <div className="row commit-instructions">
      <span className="label">Instructions</span>
      <textarea
        className="text-input"
        rows={8}
        aria-label="Commit message instructions"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => save(draft)}
      />
      {value !== null && (
        <button type="button" className="button" onClick={() => save("")}>
          Reset to default
        </button>
      )}
    </div>
  );
}
