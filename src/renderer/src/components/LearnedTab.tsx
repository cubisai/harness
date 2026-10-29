import { useCallback, useEffect, useState } from "react";
import { GraduationCap, Pin } from "lucide-react";
import { CHEAP_MODEL_HINTS, LEARN_DEFAULTS, type LearnOverview, type Lesson, type LessonAction, type LessonVerification } from "../../../shared/learn";
import type { AgentInfo } from "../../../shared/types";
import { api } from "../api";
import { useStore } from "../store";
import { Select, type SelectOption } from "./Select";
import "../styles/learned.css";

/** A lesson button's id: the API actions, plus Verify, which is the one primary button. */
export type LearnAction = "verify" | LessonAction;

const ACTION_LABELS: Record<LearnAction, string> = {
  verify: "Verify",
  drop: "Drop",
  retire: "Retire",
  pin: "Pin",
  unpin: "Unpin",
  undo: "Undo",
};

/** The shown status groups, in list order; dropped lessons are hidden. */
export interface LessonGroups {
  active: Lesson[];
  candidates: Lesson[];
  retired: Lesson[];
}

/** Group and sort the list: pinned first, then newest; dropped lessons are left out. */
export function groupLessons(lessons: Lesson[]): LessonGroups {
  const order = (a: Lesson, b: Lesson) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt;
  return {
    active: lessons.filter((l) => l.status === "active").sort(order),
    candidates: lessons.filter((l) => l.status === "candidate").sort(order),
    retired: lessons.filter((l) => l.status === "retired").sort(order),
  };
}

/** The evidence block's lines: the verification, or a single "not verified yet" line. */
export function evidenceText(v: LessonVerification | null): string[] {
  if (!v) return ["Not verified yet"];
  const date = new Date(v.at).toISOString().slice(0, 10);
  return [
    `Verified on ${v.agent} · ${v.model} (app ${v.appVersion}), ${date}`,
    `Without it: passed ${v.before.passed}/${v.before.of} · With it: passed ${v.after.passed}/${v.after.of} · Transfer: held ${v.transfer.held}/${v.transfer.of}`,
  ];
}

/** The actions that apply to a lesson's status, in the order the detail shows them. */
export function actionsFor(l: Lesson): LearnAction[] {
  if (l.status === "active") return ["retire", l.pinned ? "unpin" : "pin"];
  if (l.status === "candidate") return ["verify", "drop"];
  return ["undo"];
}

/** A token count in compact form: 950, 12.3k, 1.2M. */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${n}`;
}

/** An agent with at most this many models lists them all; a longer list shows only its cheap ones. */
const SHORT_LIST = 12;

const isCheap = (m: { id: string; label: string }) => CHEAP_MODEL_HINTS.some((h) => m.id.toLowerCase().includes(h) || m.label.toLowerCase().includes(h));

/**
 * What the background-model picker offers: "Automatic" plus each agent with a
 * model to pick, and per agent its models (cheap ones only for a long list),
 * always including the current pick.
 */
export function backgroundChoices(agents: AgentInfo[], current: { agent: string; model: string } | null): { agents: SelectOption<string>[]; models(agentId: string): SelectOption<string>[] } {
  const models = (agentId: string): SelectOption<string>[] => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return current?.agent === agentId ? [{ value: current.model, label: current.model }] : [];
    const listed = agent.models.length <= SHORT_LIST ? agent.models : agent.models.filter(isCheap);
    const options = listed.map((m) => ({ value: m.id, label: m.label }));
    if (current?.agent === agentId && !options.some((o) => o.value === current.model)) {
      options.unshift({ value: current.model, label: agent.models.find((m) => m.id === current.model)?.label ?? current.model });
    }
    return options;
  };
  const offered = agents.filter((a) => models(a.id).length > 0).map((a) => ({ value: a.id, label: a.label }));
  if (current && !offered.some((o) => o.value === current.agent)) offered.push({ value: current.agent, label: current.agent });
  return { agents: [{ value: "", label: "Automatic", detail: "The cheapest model available" }, ...offered], models };
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/**
 * The Library's Learned tab: one project's self-improve lessons, their evidence
 * and the actions the user can take. `overview` is a test seam for a static
 * render; the app passes nothing and fetches on open and on `learn-changed`.
 */
export function LearnedTab({ overview: initial }: { overview?: LearnOverview | null } = {}) {
  const projectId = useStore((s) => s.selectedProjectId);
  const learnVersion = useStore((s) => s.learnVersion);
  const [data, setData] = useState<LearnOverview | null>(initial ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const learnSettings = useStore((s) => s.settings?.learn);
  const agents = useStore((s) => s.agents);

  const reload = useCallback(() => {
    if (initial !== undefined || !projectId) return;
    void api().learnOverview(projectId).then(setData);
  }, [projectId, initial, learnVersion]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!projectId) {
    return (
      <div className="wb-content-pad" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", paddingTop: 60 }}>
        <GraduationCap size={32} strokeWidth={1.5} aria-hidden style={{ color: "var(--text-tertiary)", marginBottom: 12 }} />
        <h3 style={{ margin: "0 0 8px", fontSize: 18, color: "var(--text)" }}>No lessons</h3>
        <p style={{ maxWidth: 460, color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>Open a project to see what it has learned.</p>
      </div>
    );
  }

  if (!data) return <div className="library-pad" />;

  const lesson = selected ? (data.lessons.find((l) => l.id === selected) ?? null) : null;
  const groups = groupLessons(data.lessons);
  const sections = [
    { label: "Active", list: groups.active },
    { label: "Candidates", list: groups.candidates },
    { label: "Retired", list: groups.retired },
  ];
  const heldOut = data.cases.filter((c) => c.heldOut).length;

  const pick = (id: string) => {
    setSelected(id);
    setError(null);
    setNotice(null);
  };

  // Self-improve is opt-in per project; this is its only switch.
  const setEnabled = async (on: boolean) => {
    if (!projectId) return;
    const current = learnSettings ?? LEARN_DEFAULTS;
    const others = current.enabledProjects.filter((id) => id !== projectId);
    setError(null);
    try {
      const next = await api().updateSettings({ learn: { ...current, enabledProjects: on ? [...others, projectId] : others } });
      useStore.setState({ settings: next });
      reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  // The project's own background model; Automatic removes the override.
  const chosen = (projectId && learnSettings?.backgroundByProject[projectId]) || null;
  const choices = backgroundChoices(agents, chosen);
  const setBackground = async (pick: { agent: string; model: string } | null) => {
    if (!projectId) return;
    const current = learnSettings ?? LEARN_DEFAULTS;
    const { [projectId]: _old, ...others } = current.backgroundByProject;
    setError(null);
    try {
      const next = await api().updateSettings({ learn: { ...current, backgroundByProject: pick ? { ...others, [projectId]: pick } : others } });
      useStore.setState({ settings: next });
      reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const pickAgent = (agent: string) => {
    if (!agent) return void setBackground(null);
    // A new agent starts on its cheap tier, as background work should.
    const options = choices.models(agent);
    const model = (options.find((o) => isCheap({ id: o.value, label: o.label })) ?? options[0])?.value;
    if (model) void setBackground({ agent, model });
  };

  const act = async (target: Lesson, action: LearnAction) => {
    setError(null);
    if (action !== "verify") {
      try {
        await api().learnSetLesson(target.id, action);
        reload();
      } catch (err) {
        setError(errorText(err));
      }
      return;
    }
    setVerifying(true);
    setNotice(null);
    try {
      const updated = await api().learnVerify(target.id);
      setNotice(updated ? (updated.note ?? (updated.status === "active" ? "Promoted to active." : "Still a candidate.")) : "Verification didn't run.");
      reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="library-split learned-tab">
      <div className="library-list">
        <div className="learned-strip">
          <span className="learned-meta">{data.background ? data.background.label : "no background model"}</span>
          <span className="learned-meta">{`Today: ${compact(data.usedToday)} / ${compact(data.dailyTokens)} tokens`}</span>
        </div>
        <p className="learned-meta learned-cases">{`${data.cases.length} captured cases (${heldOut} held out)`}</p>
        <div className="learned-bg">
          <span className="label">Background model</span>
          <div className="learned-bg-picks">
            <Select value={chosen?.agent ?? ""} options={choices.agents} onChange={pickAgent} ariaLabel="Background agent for this project" />
            {chosen && <Select value={chosen.model} options={choices.models(chosen.agent)} onChange={(model) => void setBackground({ agent: chosen.agent, model })} ariaLabel="Background model for this project" />}
          </div>
        </div>
        <div className="learned-switch">
          <span className="label">Self-improve</span>
          <div className="segmented" role="group" aria-label="Self-improve for this project">
            {[true, false].map((on) => (
              <button key={String(on)} type="button" className={data.enabled === on ? "on" : ""} aria-pressed={data.enabled === on} onClick={() => void setEnabled(on)}>
                {on ? "On" : "Off"}
              </button>
            ))}
          </div>
        </div>
        {!data.enabled && <p className="note learned-off">Off for this project. On, CubiQ scores each turn and turns failed ones into lessons on the background model, within the daily token budget.</p>}
        {sections.map((s) =>
          s.list.length ? (
            <div key={s.label}>
              <p className="learned-group">{s.label}</p>
              {s.list.map((l) => (
                <div
                  key={l.id}
                  role="button"
                  tabIndex={0}
                  className={`library-item learned-item${l.id === selected ? " selected" : ""}`}
                  onClick={() => pick(l.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      pick(l.id);
                    }
                  }}
                >
                  <span className="learned-item-top">
                    <span className="n learned-rule">{l.rule}</span>
                    {l.pinned && <Pin className="learned-pin" strokeWidth={1.75} aria-hidden />}
                  </span>
                  <span className="learned-meta">{`helpful ${l.helpful} · harmful ${l.harmful} · sent ${l.relevant}`}</span>
                </div>
              ))}
            </div>
          ) : null,
        )}
        {data.lessons.length === 0 && <p className="note">Nothing learned yet.</p>}
      </div>
      <div className="library-detail">
        {lesson ? (
          <div className="learned-view">
            <div className="learned-title">
              <h3>{lesson.rule}</h3>
              <span className="tag">{lesson.status}</span>
            </div>
            {lesson.why && <p className="learned-why">{lesson.why}</p>}
            <div className="learned-evidence">
              {evidenceText(lesson.verified).map((line) => (
                <p key={line} className="note">
                  {line}
                </p>
              ))}
              {lesson.note && <p className="note">{lesson.note}</p>}
            </div>
            <p className="learned-meta">{`Tried ${lesson.tries} ${lesson.tries === 1 ? "time" : "times"} · helpful ${lesson.helpful} · harmful ${lesson.harmful} · sent ${lesson.relevant}`}</p>
            {error && <p className="form-error learned-error">{error}</p>}
            {notice && <p className="note">{notice}</p>}
            <div className="learned-actions">
              {actionsFor(lesson).map((action) =>
                action === "verify" ? (
                  <button key={action} className="button primary" disabled={verifying} onClick={() => void act(lesson, action)}>
                    {verifying ? "Verifying…" : ACTION_LABELS[action]}
                  </button>
                ) : (
                  <button key={action} className="button ghost" disabled={verifying} onClick={() => void act(lesson, action)}>
                    {ACTION_LABELS[action]}
                  </button>
                ),
              )}
            </div>
          </div>
        ) : (
          <p className="note">Pick a lesson to see its evidence and actions.</p>
        )}
      </div>
    </div>
  );
}
