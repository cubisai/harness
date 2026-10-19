import { useCallback, useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import type { AutomationInput, AutomationNotice, AutomationPermissions, AutomationTemplate, AutomationView, AutomationsOverview, MissedPolicy, Schedule } from "../../../shared/automations";
import { api } from "../api";
import { useStore } from "../store";
import { Select } from "./Select";
import "../styles/automations.css";

const KINDS: { value: Schedule["kind"]; label: string }[] = [
  { value: "interval", label: "Every N minutes" },
  { value: "daily", label: "Daily" },
];

const MISSED: { value: MissedPolicy; label: string }[] = [
  { value: "coalesce", label: "Run once to catch up" },
  { value: "skip", label: "Skip" },
];

const PERMISSIONS: { value: AutomationPermissions; label: string }[] = [
  { value: "unattended", label: "Run unattended" },
  { value: "ask", label: "Ask me first" },
];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The machine's IANA zone, so "09:00" means the user's morning. */
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The editor's draft: a saved automation carries its id; a new one does not. */
interface Draft extends AutomationInput {
  id?: string;
}

/** A new automation's input from a template: enabled, coalescing, no agent or model pinned. */
export function inputOf(template: AutomationTemplate): AutomationInput {
  return {
    name: template.name,
    template: template.id,
    prompt: template.prompt,
    schedule: template.schedule,
    missed: "coalesce",
    enabled: true,
    agent: null,
    model: null,
    budgetUsd: template.budgetUsd,
    permissions: "unattended",
  };
}

/** The list row's last-run line: "<status> · <time> · $cost", the cost dropped when null. */
export function lastRunText(notice: AutomationNotice | null, now: number): string {
  if (!notice) return "Never run";
  const parts: string[] = [notice.status];
  if (notice.endedAt !== null) parts.push(whenText(notice.endedAt, now));
  if (notice.costUsd !== null) parts.push(`$${notice.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}

/** Relative for the last week, then an absolute date. */
function whenText(at: number, now: number): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** The template picker's options; `detail` is the description the popup shows under the name. */
function templateOptions(list: AutomationTemplate[]): { value: string; label: string; detail: string }[] {
  return list.map((t) => ({ value: t.id, label: t.name, detail: t.description }));
}

function scheduleKind(current: Schedule, kind: Schedule["kind"]): Schedule {
  if (kind === "interval") return current.kind === "interval" ? current : { kind: "interval", everyMinutes: 30 };
  return current.kind === "daily" ? current : { kind: "daily", at: "09:00", timeZone: TZ };
}

function draftOf(input: AutomationInput, id?: string): Draft {
  return { ...input, id };
}

function draftOfView(view: AutomationView): Draft {
  return {
    id: view.id,
    name: view.name,
    template: view.template,
    prompt: view.prompt,
    schedule: view.schedule,
    missed: view.missed,
    enabled: view.enabled,
    agent: view.agent,
    model: view.model,
    budgetUsd: view.budgetUsd,
    permissions: view.permissions,
  };
}

function toInput(draft: Draft): AutomationInput {
  return {
    name: draft.name,
    template: draft.template,
    prompt: draft.prompt,
    schedule: draft.schedule,
    missed: draft.missed,
    enabled: draft.enabled,
    agent: draft.agent,
    model: draft.model,
    budgetUsd: draft.budgetUsd,
    permissions: draft.permissions,
  };
}

/**
 * The Library's Automations tab: one project's automations, an editor and a run.
 * `overview` is a test seam for a static render; the app passes nothing and fetches on open.
 */
export function AutomationsTab({ overview: initial }: { overview?: AutomationsOverview | null } = {}) {
  const projectId = useStore((s) => s.selectedProjectId);
  const agents = useStore((s) => s.agents);
  const [data, setData] = useState<AutomationsOverview | null>(initial ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = useCallback(() => {
    if (initial !== undefined || !projectId) return;
    void api().automationsOverview(projectId).then(setData);
  }, [projectId, initial]);

  useEffect(() => {
    reload();
  }, [reload]);

  // The two-step Delete falls back to "Delete" on its own after a few seconds.
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDelete, selected]);

  if (!projectId) {
    return (
      <div className="wb-content-pad" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", paddingTop: 60 }}>
        <CalendarClock size={32} strokeWidth={1.5} aria-hidden style={{ color: "var(--text-tertiary)", marginBottom: 12 }} />
        <h3 style={{ margin: "0 0 8px", fontSize: 18, color: "var(--text)" }}>No automations</h3>
        <p style={{ maxWidth: 460, color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>Open a project to schedule automations.</p>
      </div>
    );
  }

  if (!data) return <div className="library-pad" />;

  const open = (view: AutomationView) => {
    setError(null);
    setNotice(null);
    setSelected(view.id);
    setDraft(draftOfView(view));
    setSaved(draftOfView(view));
    setConfirmDelete(false);
  };

  const openNew = (template?: AutomationTemplate) => {
    const t = template ?? data.templates[0];
    if (!t) return;
    setError(null);
    setNotice(null);
    setSelected(null);
    setDraft(draftOf(inputOf(t)));
    setSaved(null);
    setConfirmDelete(false);
  };

  const pickTemplate = (id: string) => {
    const t = data.templates.find((x) => x.id === id);
    if (t) openNew(t);
  };

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      const view = await api().automationSave(projectId, toInput(draft), draft.id);
      setDraft(draftOfView(view));
      setSaved(draftOfView(view));
      setSelected(view.id);
      setNotice(null);
      reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const runNow = async () => {
    if (!draft?.id) return;
    setError(null);
    try {
      await api().automationRunNow(draft.id);
      setNotice("Queued — it runs when no turn of yours is running.");
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    setError(null);
    try {
      await api().automationDelete(draft.id);
      setDraft(null);
      setSaved(null);
      setSelected(null);
      setConfirmDelete(false);
      reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const toggleDay = (day: number) => {
    if (!draft || draft.schedule.kind !== "daily") return;
    const days = draft.schedule.days ?? [];
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b);
    // None selected means every day, so the key is dropped rather than left empty (which main rejects).
    setDraft({ ...draft, schedule: next.length ? { ...draft.schedule, days: next } : { kind: "daily", at: draft.schedule.at, timeZone: draft.schedule.timeZone } });
  };

  const item = (a: AutomationView) => (
    <div
      key={a.id}
      role="button"
      tabIndex={0}
      className={`library-item automations-item${a.id === selected ? " selected" : ""}${a.enabled ? "" : " off"}`}
      onClick={() => open(a)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(a);
        }
      }}
    >
      <span className="automations-head">
        <span className="n">{a.name}</span>
        <span className="automations-state">{a.enabled ? "On" : "Off"}</span>
      </span>
      <span className="automations-meta">{a.scheduleText}</span>
      <span className="automations-meta">{lastRunText(a.lastRun, Date.now())}</span>
    </div>
  );

  const dirty =
    draft !== null &&
    (saved === null
      ? draft.name !== "" || draft.prompt !== ""
      : draft.name !== saved.name || draft.prompt !== saved.prompt || draft.schedule !== saved.schedule || draft.missed !== saved.missed || draft.enabled !== saved.enabled || draft.budgetUsd !== saved.budgetUsd || draft.agent !== saved.agent || draft.model !== saved.model || draft.permissions !== saved.permissions);

  const selectedTemplate = draft ? data.templates.find((t) => t.id === draft.template) : undefined;

  return (
    <div className="library-split automations-tab">
      <div className="library-list">
        <div className="skill-toolbar">
          <button className="button" onClick={() => openNew()}>
            New automation
          </button>
        </div>
        {data.automations.length === 0 ? <p className="note">No automations yet.</p> : data.automations.map(item)}
      </div>
      <div className="library-detail">
        {draft ? (
          <form
            className={`automations-form${dirty ? " editing" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {draft.id === undefined && (
              <div className="automations-row">
                <span className="label">Template</span>
                <div className="automations-fields">
                  <Select
                    className="block"
                    value={draft.template}
                    options={templateOptions(data.templates)}
                    onChange={pickTemplate}
                    ariaLabel="Template"
                  />
                  {selectedTemplate && <p className="note">{selectedTemplate.description}</p>}
                </div>
              </div>
            )}
            <div className="automations-row">
              <label className="label" htmlFor="automation-name">
                Name
              </label>
              <input id="automation-name" className="text-input" autoFocus value={draft.name} placeholder="Morning project brief" spellCheck={false} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="automations-row">
              <label className="label" htmlFor="automation-prompt">
                Prompt
              </label>
              <textarea id="automation-prompt" className="text-input automations-body" rows={10} value={draft.prompt} placeholder="What the agent should do each run" onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
            </div>
            <div className="automations-row">
              <span className="label">Schedule</span>
              <div className="automations-fields">
                <Select value={draft.schedule.kind} options={KINDS} onChange={(kind) => setDraft({ ...draft, schedule: scheduleKind(draft.schedule, kind) })} ariaLabel="Schedule" />
                {draft.schedule.kind === "interval" ? (
                  <>
                    <span className="automations-unit">every</span>
                    <input
                      className="text-input"
                      type="number"
                      min={5}
                      value={draft.schedule.everyMinutes}
                      aria-label="Minutes between runs"
                      onChange={(e) => setDraft({ ...draft, schedule: { kind: "interval", everyMinutes: Number(e.target.value) } })}
                    />
                    <span className="automations-unit">minutes</span>
                  </>
                ) : (
                  <>
                    <input
                      className="text-input"
                      type="time"
                      value={draft.schedule.at}
                      aria-label="Time of day"
                      onChange={(e) => draft.schedule.kind === "daily" && setDraft({ ...draft, schedule: { ...draft.schedule, at: e.target.value } })}
                    />
                    <span className="automations-tz">{draft.schedule.timeZone}</span>
                  </>
                )}
              </div>
            </div>
            {draft.schedule.kind === "daily" && (
              <div className="automations-row">
                <span className="label">Days</span>
                <div className="automations-days">
                  {DAYS.map((label, i) => {
                    const on = draft.schedule.kind === "daily" && (draft.schedule.days?.includes(i) ?? false);
                    return (
                      <button key={label} type="button" className={`automations-day${on ? " on" : ""}`} aria-pressed={on} onClick={() => toggleDay(i)}>
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="automations-row">
              <span className="label">Missed runs</span>
              <div className="automations-fields">
                <Select className="block" value={draft.missed} options={MISSED} onChange={(missed) => setDraft({ ...draft, missed })} ariaLabel="Missed runs" />
              </div>
            </div>
            <div className="automations-row">
              <span className="label">Agent</span>
              <div className="automations-fields">
                <Select
                  value={draft.agent ?? ""}
                  options={[{ value: "", label: "Default agent" }, ...agents.map((a) => ({ value: a.id, label: a.label }))]}
                  onChange={(agent) => setDraft({ ...draft, agent: agent || null, model: null })}
                  ariaLabel="Agent"
                />
                {draft.agent && (
                  <Select
                    value={draft.model ?? ""}
                    options={[{ value: "", label: "Its default model" }, ...(agents.find((a) => a.id === draft.agent)?.models ?? []).map((m) => ({ value: m.id, label: m.label }))]}
                    onChange={(model) => setDraft({ ...draft, model: model || null })}
                    ariaLabel="Model"
                  />
                )}
                <p className="note">Each run starts a fresh thread on this agent; a cheap model keeps scheduled runs cheap.</p>
              </div>
            </div>
            <div className="automations-row">
              <span className="label">Permissions</span>
              <div className="automations-fields">
                <Select value={draft.permissions} options={PERMISSIONS} onChange={(permissions) => setDraft({ ...draft, permissions })} ariaLabel="Permissions" />
                <p className="note">
                  {draft.permissions === "unattended"
                    ? "Runs its tools without asking, with git guardrails on. Keep the prompt read-only unless you want it to change files."
                    : "Each tool waits for your approval, so a scheduled run pauses until you answer it in the Message Center."}
                </p>
              </div>
            </div>
            <div className="automations-row">
              <label className="label" htmlFor="automation-budget">
                Budget USD
              </label>
              <div className="automations-fields">
                <input
                  id="automation-budget"
                  className="text-input"
                  type="number"
                  min={0}
                  step={0.05}
                  placeholder="No limit"
                  value={draft.budgetUsd ?? ""}
                  onChange={(e) => setDraft({ ...draft, budgetUsd: e.target.value === "" ? null : Number(e.target.value) })}
                />
                <span className="automations-unit">per run · empty = none</span>
              </div>
            </div>
            <div className="automations-row">
              <span className="label">Enabled</span>
              <div className="automations-check">
                <label>
                  <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                  <span>Run on its schedule</span>
                </label>
                <p className="note">Off keeps it saved but stops it running until you turn it back on.</p>
              </div>
            </div>
            {error && <p className="form-error automations-error">{error}</p>}
            {notice && <p className="note">{notice}</p>}
            <div className="automations-actions">
              {draft.id && (
                <button type="button" className="button ghost danger" onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}>
                  {confirmDelete ? "Confirm delete" : "Delete"}
                </button>
              )}
              <span className="grow" />
              {draft.id && (
                <button type="button" className="button" onClick={() => void runNow()}>
                  Run now
                </button>
              )}
              <button type="submit" className="button primary">
                Save
              </button>
            </div>
          </form>
        ) : data.automations.length === 0 ? (
          <div className="automations-empty">
            <p className="note">No automations yet. Pick a template to start.</p>
            <Select
              value={data.templates[0]?.id ?? ""}
              options={templateOptions(data.templates)}
              onChange={pickTemplate}
              ariaLabel="Template"
            />
            {data.templates[0] && <p className="note">{data.templates[0].description}</p>}
          </div>
        ) : error ? (
          <p className="form-error" style={{ margin: 0 }}>
            {error}
          </p>
        ) : (
          <p className="note">Pick an automation to edit it, or create one.</p>
        )}
      </div>
    </div>
  );
}
