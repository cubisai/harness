import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtSign, File, Folder, Plus, Slash, Sparkles } from "lucide-react";
import type { PermissionMode, SkillEntry } from "../../../shared/types";
import { IconArrowUp, IconStop } from "../icons";
import { api } from "../api";
import { chipLabel, commandQuery, composeMessage, skillQuery } from "../composer";
import { matchCommands, type ComposerCommand } from "../commands";
import { folderPaths, mentionQueryAt, mentionsIn, rankMentions } from "../mentions";
import { nextMode } from "../modes";
import { useStore } from "../store";
import { originLabel } from "./Library";
import { Beam } from "./Beam";

/**
 * The message box. Typing `$` at the start opens the menu of skilled's
 * user-invoked skills; picking one turns it into a chip, and whatever is
 * typed after it goes to the skill as its arguments. Typing `/` opens the
 * menu of CubiQ commands (permission modes, the model picker, a new thread).
 * A picked browser element becomes a context chip whose text rides along with
 * the message. Sending while a turn runs queues the message for the next turn.
 * With no thread yet (`threadId` null), sending starts one. Alt+Return starts
 * the message in a new thread in the background instead, leaving this one open.
 * One bar under the text (DESIGN.md §7.3): + and the permission chip on the
 * left; the model control, the context ring and send on the right.
 */
export function Composer({ threadId, mode, model, meters }: { threadId: string | null; mode?: ReactNode; model?: ReactNode; meters?: ReactNode }) {
  const skills = useStore((s) => s.skills);
  const running = useStore((s) => (threadId ? Boolean(s.running[threadId]) : false));
  const insert = useStore((s) => s.composerInsert);
  const { send, interrupt, enqueue, startThread, sendInBackground } = useStore.getState();
  const projectId = useStore((s) => s.selectedProjectId);
  const [text, setText] = useState("");
  const [chips, setChips] = useState<string[]>([]);
  const [skill, setSkill] = useState<SkillEntry | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [caret, setCaret] = useState(0);
  const [knownFiles, setKnownFiles] = useState<string[]>([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const plusBox = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  /** listFiles results by project id, with when they were fetched, so the picker doesn't refetch per keystroke. */
  const filesCache = useRef(new Map<string, { at: number; files: string[] }>());

  const query = skill ? null : skillQuery(text);
  const matches = useMemo(
    () =>
      query === null
        ? []
        : skills
            .filter(
              (s) =>
                s.name.includes(query) ||
                (query.length > 1 && s.description.toLowerCase().split(/\W+/).some((w) => w.startsWith(query))),
            )
            .sort((a, b) => Number(!a.name.startsWith(query)) - Number(!b.name.startsWith(query))),
    [query, skills],
  );
  const menuOpen = query !== null;

  const cmdQuery = skill ? null : commandQuery(text);
  const commandMatches = useMemo(() => (cmdQuery === null ? [] : matchCommands(cmdQuery)), [cmdQuery]);
  const commandOpen = cmdQuery !== null;

  const mentionQuery = mentionQueryAt(text, caret);
  const mentionOpen = mentionQuery !== null && !menuOpen && !commandOpen && !mentionDismissed;
  const knownPaths = useMemo(() => [...knownFiles, ...folderPaths(knownFiles)], [knownFiles]);
  const knownSet = useMemo(() => new Set(knownPaths), [knownPaths]);
  const mentionMatches = useMemo(
    () => (mentionOpen ? rankMentions(knownPaths, mentionQuery?.query ?? "", 50) : []),
    [mentionOpen, knownPaths, mentionQuery?.query],
  );

  const loadFiles = useCallback(async (id: string) => {
    const { files } = await api().listFiles(id);
    filesCache.current.set(id, { at: Date.now(), files });
    return files;
  }, []);

  // Fetch the project's files once per project; the menu refetches them when its cached copy goes stale.
  useEffect(() => {
    if (!projectId) {
      setKnownFiles([]);
      return;
    }
    const cached = filesCache.current.get(projectId);
    if (cached) {
      setKnownFiles(cached.files);
      return;
    }
    let cancelled = false;
    void loadFiles(projectId).then((files) => {
      if (!cancelled) setKnownFiles(files);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, loadFiles]);

  useEffect(() => {
    if (!mentionOpen || !projectId) return;
    const cached = filesCache.current.get(projectId);
    if (cached && Date.now() - cached.at < 30_000) return;
    void loadFiles(projectId).then((files) => {
      if (useStore.getState().selectedProjectId === projectId) setKnownFiles(files);
    });
  }, [mentionOpen, projectId, loadFiles]);

  useEffect(() => setMenuIndex(0), [query]);
  useEffect(() => setMenuIndex(0), [cmdQuery]);
  useEffect(() => setMenuIndex(0), [mentionQuery?.start, mentionQuery?.query]);
  useEffect(() => setMentionDismissed(false), [mentionQuery?.start, mentionQuery?.query]);
  useEffect(() => {
    area.current?.focus();
    setText("");
    setCaret(0);
    setChips([]);
    const pending = useStore.getState().takePendingSkill();
    setSkill(pending ? (useStore.getState().skills.find((s) => s.name === pending) ?? null) : null);
  }, [threadId]);

  // A skill picked from the command palette while this thread is open.
  const pendingSkill = useStore((s) => s.pendingSkill);
  useEffect(() => {
    if (!pendingSkill) return;
    const name = useStore.getState().takePendingSkill();
    const entry = useStore.getState().skills.find((s) => s.name === name);
    if (!entry) return;
    setSkill(entry);
    area.current?.focus();
  }, [pendingSkill]);

  // Edit on a sent message puts its text back here, caret at the end.
  const draft = useStore((s) => s.composerDraft);
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    setCaret(draft.text.length);
    pendingCaret.current = draft.text.length;
    useStore.setState({ composerDraft: null });
    area.current?.focus();
  }, [draft]);

  // A picked element becomes a chip; its full text goes out with the message.
  useEffect(() => {
    if (!insert) return;
    setChips((c) => [...c, insert.text]);
    useStore.setState({ composerInsert: null }); // consumed: don't re-apply on the next mount
    area.current?.focus();
  }, [insert]);

  // Grow with the content, up to the CSS max-height; a picked mention moves the caret after its insertion.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    const pending = pendingCaret.current;
    if (pending !== null) {
      pendingCaret.current = null;
      el.focus();
      el.setSelectionRange(pending, pending);
      setCaret(pending);
    }
  }, [text]);

  const pick = (s: SkillEntry) => {
    setSkill(s);
    setText("");
    setCaret(0);
    area.current?.focus();
  };

  // Replace the `@query` before the caret with `@path ` and put the caret after it.
  const pickMention = (path: string) => {
    if (!mentionQuery) return;
    const next = `${text.slice(0, mentionQuery.start)}@${path} ${text.slice(caret)}`;
    pendingCaret.current = mentionQuery.start + path.length + 2;
    setText(next);
    area.current?.focus();
  };

  // Run a "/" command: set the permission mode, ask for the model picker, open the context sheet, or start a new thread.
  const runCommand = (c: ComposerCommand) => {
    setText("");
    setCaret(0);
    const s = useStore.getState();
    if (c.name === "new") void s.newThread();
    else if (c.name === "model") s.requestModelPicker();
    else if (c.name === "context") s.openContextSheet(threadId);
    else if (c.name === "compact") {
      if (threadId) void s.compact(threadId, null);
    }
    else if (c.name === "plan" || c.name === "ask" || c.name === "auto-edit" || c.name === "full") {
      const mode: PermissionMode = c.name;
      if (threadId) void s.updateThread({ permissionMode: mode });
      else s.setDraft({ permissionMode: mode });
    }
    area.current?.focus();
  };

  const submit = () => {
    // "/compact <focus>" is a command with an argument, not a message.
    const compactMatch = !skill && /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (compactMatch) {
      if (!threadId || running) return;
      void useStore.getState().compact(threadId, compactMatch[1]?.trim() || null);
      setText("");
      setCaret(0);
      return;
    }
    const body = composeMessage(text, chips);
    if (!body && !skill) return;
    const mentions = mentionsIn(text, knownSet);
    if (!threadId) void startThread(body, skill?.name, mentions);
    else if (running) enqueue(threadId, body, skill?.name, mentions);
    else void send(body, skill?.name, undefined, mentions);
    setText("");
    setChips([]);
    setSkill(null);
    setCaret(0);
  };

  // Alt+Return starts the message as its own thread in the background and leaves this one open.
  const submitInBackground = () => {
    const body = composeMessage(text, chips);
    if (!body && !skill) return;
    const mentions = mentionsIn(text, knownSet);
    void sendInBackground(body, skill?.name, undefined, mentions);
    setText("");
    setChips([]);
    setSkill(null);
    setCaret(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab" && e.shiftKey && !e.nativeEvent.isComposing) {
      // Shift+Tab cycles the permission mode: the open thread's, or the draft's.
      e.preventDefault();
      const s = useStore.getState();
      const current = threadId
        ? (Object.values(s.threads).flat().find((t) => t.id === threadId)?.permissionMode ?? "ask")
        : (s.draft.permissionMode ?? s.settings?.defaultPermissionMode ?? "ask");
      const next = nextMode(current);
      if (threadId) void s.updateThread({ permissionMode: next });
      else s.setDraft({ permissionMode: next });
      return;
    }
    if (e.key === "Enter" && e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submitInBackground();
      return;
    }
    if (menuOpen && matches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const m = matches[menuIndex];
        if (m) pick(m);
        return;
      }
    }
    if (commandOpen && commandMatches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % commandMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + commandMatches.length) % commandMatches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const c = commandMatches[menuIndex];
        if (c) runCommand(c);
        return;
      }
    }
    if (mentionOpen && mentionMatches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const m = mentionMatches[menuIndex];
        if (m) pickMention(m);
        return;
      }
    }
    if (e.key === "Escape" && (menuOpen || commandOpen)) {
      setText("");
      return;
    }
    if (e.key === "Escape" && mentionOpen) {
      setMentionDismissed(true);
      return;
    }
    if (e.key === "Backspace" && !text && (chips.length || skill)) {
      // The last chip first, then the skill.
      if (chips.length) setChips((c) => c.slice(0, -1));
      else setSkill(null);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = skill
    ? skill.argumentHint ?? `Anything to tell $${skill.name}? Or just press Return.`
    : running
      ? "Queue a message for the next turn…"
      : "Ask anything — $ for a skill, / for a command";

  // The + menu starts a trigger at the caret, as if typed: @ mention, $ skill, / command.
  useEffect(() => {
    if (!plusOpen) return;
    const close = (e: MouseEvent) => {
      if (!plusBox.current?.contains(e.target as Node)) setPlusOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [plusOpen]);
  const startTrigger = (ch: "@" | "$" | "/") => {
    setPlusOpen(false);
    // $ and / only open their menus at the start of the message.
    const at = ch === "@" ? caret : 0;
    const before = text.slice(0, at);
    const spacer = ch === "@" && before && !/\s$/.test(before) ? " " : "";
    const next = ch === "@" ? `${before}${spacer}@${text.slice(at)}` : `${ch}${text.replace(/^[$/]\S*\s?/, "")}`;
    const pos = ch === "@" ? at + spacer.length + 1 : 1;
    setText(next);
    setCaret(pos);
    pendingCaret.current = pos;
    area.current?.focus();
  };

  const canSend = Boolean(text.trim() || skill || chips.length);

  return (
    <div className="composer-wrap">
      <div className={`composer${running ? " running" : ""}`}>
        {running && <Beam />}
        {menuOpen && (
          <div className="skill-menu" role="listbox">
            {matches.length === 0 && <div className="empty-line">No skill matches “{query}”</div>}
            {matches.map((s, i) => (
              <div
                key={s.name}
                role="option"
                aria-selected={i === menuIndex}
                className={`item${i === menuIndex ? " active" : ""}`}
                onMouseEnter={() => setMenuIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
              >
                <span className="n">${s.name}</span>
                <span className="skill-origin">{originLabel(s.origin)}</span>
                <span className="d">{s.description}</span>
              </div>
            ))}
          </div>
        )}
        {commandOpen && (
          <div className="skill-menu" role="listbox">
            {commandMatches.length === 0 && <div className="empty-line">No command matches “{cmdQuery}”</div>}
            {commandMatches.map((c, i) => (
              <div
                key={c.name}
                role="option"
                aria-selected={i === menuIndex}
                className={`item${i === menuIndex ? " active" : ""}`}
                onMouseEnter={() => setMenuIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  runCommand(c);
                }}
              >
                <span className="n">/{c.name}</span>
                <span className="d">{c.description}</span>
              </div>
            ))}
          </div>
        )}
        {mentionOpen && (
          <div className="skill-menu" role="listbox">
            {mentionMatches.length === 0 && <div className="empty-line">No files match “{mentionQuery?.query}”</div>}
            {mentionMatches.map((path, i) => (
              <div
                key={path}
                role="option"
                aria-selected={i === menuIndex}
                className={`item${i === menuIndex ? " active" : ""}`}
                onMouseEnter={() => setMenuIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(path);
                }}
              >
                <span className="mention-icon">{path.endsWith("/") ? <Folder size={14} /> : <File size={14} />}</span>
                <span className="n">{path}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-bar">
          <div className="composer-left">
            <div className="model-picker" ref={plusBox}>
              <button className="chip-button icon" title="Add context" aria-haspopup="menu" aria-expanded={plusOpen} onClick={() => setPlusOpen((o) => !o)}>
                <Plus size={15} />
              </button>
              {plusOpen && (
                <div className="model-menu up plus-menu" role="menu">
                  <button role="menuitem" className="model-item" onClick={() => startTrigger("@")}>
                    <AtSign size={13} className="check" />
                    <span className="label">Mention a file or folder</span>
                    <span className="hint">@</span>
                  </button>
                  <button role="menuitem" className="model-item" onClick={() => startTrigger("$")}>
                    <Sparkles size={13} className="check" />
                    <span className="label">Use a skill</span>
                    <span className="hint">$</span>
                  </button>
                  <button role="menuitem" className="model-item" onClick={() => startTrigger("/")}>
                    <Slash size={13} className="check" />
                    <span className="label">Run a command</span>
                    <span className="hint">/</span>
                  </button>
                </div>
              )}
            </div>
            {mode}
            {skill && (
              <span className="skill-chip" title={skill.description}>
                ${skill.name}
              </span>
            )}
            {chips.map((c, i) => (
              <span key={i} className="skill-chip context-chip" title={c}>
                {chipLabel(c)}
              </span>
            ))}
            <span className="grow" />
          </div>
          <div className="composer-actions">
            {model}
            {meters}
            {running && (
              <button className="send stop" title="Stop (clears queued messages)" onClick={() => void interrupt()}>
                <Beam />
                <IconStop />
              </button>
            )}
            {(!running || text.trim() || chips.length > 0) && (
              <button className="send" title={running ? "Queue for the next turn" : "Send"} disabled={!canSend} onClick={submit}>
                {/* Ready to send: the beam invites the click. */}
                {canSend && <Beam />}
                <IconArrowUp />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
