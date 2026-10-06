import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtSign, Check, File, Folder, Slash, Sparkles } from "lucide-react";
import type { PermissionMode, SkillEntry } from "../../../shared/types";
import { IconArrowUp, IconStop } from "../icons";
import { api } from "../api";
import { chipLabel, commandQuery, composeMessage, skillQueryAt, toggleSkill } from "../composer";
import { matchCommands, type ComposerCommand } from "../commands";
import { folderPaths, mentionQueryAt, mentionsIn, rankMentions } from "../mentions";
import { nextMode } from "../modes";
import { useStore } from "../store";
import { originLabel } from "./Library";
import { Beam } from "./Beam";
import { GooeyPlus } from "./GooeyPlus";

/**
 * The message box. Typing `$` at a word start opens the menu of skilled's
 * user-invoked skills; picking one adds it as a chip inside the box (picking
 * it again takes it out), so a message can carry several, and whatever is
 * typed goes to them as their arguments. Typing `/` opens the
 * menu of CubiQ commands (permission modes, the model picker, a new thread).
 * A picked browser element becomes a context chip whose text rides along with
 * the message. Sending while a turn runs queues the message for the next turn.
 * With no thread yet (`threadId` null), sending starts one. Alt+Return starts
 * the message in a new thread in the background instead, leaving this one open.
 * One bar under the text (DESIGN.md §7.3): + and the permission chip on the
 * left; the model control, the context ring and send on the right.
 */
/** Skill entries for names, in order: from the loaded catalog, else from `extra`; unknown names are dropped. */
function entriesOf(names: string[], extra: SkillEntry[] = []): SkillEntry[] {
  const all = useStore.getState().skills;
  return names.flatMap((n) => all.find((s) => s.name === n) ?? extra.find((s) => s.name === n) ?? []);
}

export function Composer({ threadId, mode, model, meters }: { threadId: string | null; mode?: ReactNode; model?: ReactNode; meters?: ReactNode }) {
  const skills = useStore((s) => s.skills);
  const running = useStore((s) => (threadId ? Boolean(s.running[threadId]) : false));
  const insert = useStore((s) => s.composerInsert);
  const { send, interrupt, enqueue, startThread, sendInBackground } = useStore.getState();
  const projectId = useStore((s) => s.selectedProjectId);
  const [text, setText] = useState("");
  const [chips, setChips] = useState<string[]>([]);
  const [picked, setPicked] = useState<SkillEntry[]>([]);
  const [skillDismissed, setSkillDismissed] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [caret, setCaret] = useState(0);
  const [knownFiles, setKnownFiles] = useState<string[]>([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  /** listFiles results by project id, with when they were fetched, so the picker doesn't refetch per keystroke. */
  const filesCache = useRef(new Map<string, { at: number; files: string[] }>());

  const skillAt = skillQueryAt(text, caret);
  const query = skillAt && !skillDismissed ? skillAt.query : null;
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

  const cmdQuery = picked.length ? null : commandQuery(text);
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
  useEffect(() => setSkillDismissed(false), [skillAt?.start, skillAt?.query]);
  useEffect(() => setMenuIndex(0), [cmdQuery]);
  useEffect(() => setMenuIndex(0), [mentionQuery?.start, mentionQuery?.query]);
  useEffect(() => setMentionDismissed(false), [mentionQuery?.start, mentionQuery?.query]);
  useEffect(() => {
    area.current?.focus();
    setText("");
    setCaret(0);
    setChips([]);
    setPicked(entriesOf(useStore.getState().takePendingSkills()));
  }, [threadId]);

  // Skills picked from the command palette or the Library while this thread is open join the chips.
  const pendingSkills = useStore((s) => s.pendingSkills);
  useEffect(() => {
    if (!pendingSkills.length) return;
    const add = entriesOf(useStore.getState().takePendingSkills());
    if (!add.length) return;
    setPicked((p) => [...p, ...add.filter((a) => !p.some((x) => x.name === a.name))]);
    area.current?.focus();
  }, [pendingSkills]);

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

  // Add the skill as a chip, or take it out when it's already picked; the typed `$query` goes away.
  const pick = (s: SkillEntry) => {
    const names = toggleSkill(picked.map((p) => p.name), s.name);
    setPicked(entriesOf(names, [...picked, s]));
    if (skillAt) {
      setText(`${text.slice(0, skillAt.start)}${text.slice(caret)}`);
      pendingCaret.current = skillAt.start;
    }
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

  // Run a "/" command: set the permission mode, ask for the model picker, open the context or MCP sheet, or start a new thread.
  const runCommand = (c: ComposerCommand) => {
    setText("");
    setCaret(0);
    const s = useStore.getState();
    if (c.name === "new") void s.newThread();
    else if (c.name === "model") s.requestModelPicker();
    else if (c.name === "context") s.openContextSheet(threadId);
    else if (c.name === "mcp") s.openMcpSheet();
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
    const compactMatch = !picked.length && /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (compactMatch) {
      if (!threadId || running) return;
      void useStore.getState().compact(threadId, compactMatch[1]?.trim() || null);
      setText("");
      setCaret(0);
      return;
    }
    // "/mcp <url|command|json>" opens the MCP sheet with that text up for review; it never goes to the agent.
    const mcpMatch = !picked.length && /^\/mcp(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (mcpMatch) {
      useStore.getState().openMcpSheet(mcpMatch[1]?.trim() ?? "");
      setText("");
      setCaret(0);
      return;
    }
    const body = composeMessage(text, chips);
    if (!body && !picked.length) return;
    const mentions = mentionsIn(text, knownSet);
    const names = picked.map((p) => p.name);
    if (!threadId) void startThread(body, names, mentions);
    else if (running) enqueue(threadId, body, names, mentions);
    else void send(body, names, undefined, mentions);
    setText("");
    setChips([]);
    setPicked([]);
    setCaret(0);
  };

  // Alt+Return starts the message as its own thread in the background and leaves this one open.
  const submitInBackground = () => {
    // "/mcp <url|command|json>" opens the MCP sheet with that text up for review; it never goes to the agent.
    const mcpMatch = !picked.length && /^\/mcp(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (mcpMatch) {
      useStore.getState().openMcpSheet(mcpMatch[1]?.trim() ?? "");
      setText("");
      setCaret(0);
      return;
    }
    const body = composeMessage(text, chips);
    if (!body && !picked.length) return;
    const mentions = mentionsIn(text, knownSet);
    void sendInBackground(body, picked.map((p) => p.name), undefined, mentions);
    setText("");
    setChips([]);
    setPicked([]);
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
    // Esc closes the skill menu and keeps what was typed; the command menu clears its "/" as before.
    if (e.key === "Escape" && menuOpen) {
      setSkillDismissed(true);
      return;
    }
    if (e.key === "Escape" && commandOpen) {
      setText("");
      return;
    }
    if (e.key === "Escape" && mentionOpen) {
      setMentionDismissed(true);
      return;
    }
    if (e.key === "Backspace" && !text && (chips.length || picked.length)) {
      // The last chip in the box goes: context chips sit after the skills.
      if (chips.length) setChips((c) => c.slice(0, -1));
      else setPicked((p) => p.slice(0, -1));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder =
    picked.length === 1
      ? picked[0]!.argumentHint ?? `Anything to tell $${picked[0]!.name}? Or just press Return.`
      : picked.length > 1
        ? `Anything to tell ${picked.map((p) => `$${p.name}`).join(", ")}? Or just press Return.`
        : running
      ? "Queue a message for the next turn…"
      : "Ask anything — $ for a skill, / for a command";

  // The + starts a trigger at the caret, as if typed: @ mention, $ skill, / command.
  const startTrigger = (ch: "@" | "$" | "/") => {
    // @ and $ open at the caret (a word start); / only at the start of the message.
    const inline = ch !== "/";
    const at = inline ? caret : 0;
    const before = text.slice(0, at);
    const spacer = inline && before && !/\s$/.test(before) ? " " : "";
    const next = inline ? `${before}${spacer}${ch}${text.slice(at)}` : `${ch}${text.replace(/^\/\S*\s?/, "")}`;
    const pos = inline ? at + spacer.length + 1 : 1;
    setText(next);
    setCaret(pos);
    pendingCaret.current = pos;
    area.current?.focus();
  };

  const canSend = Boolean(text.trim() || picked.length || chips.length);

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
                {picked.some((p) => p.name === s.name) && <Check size={13} className="skill-picked" aria-label="Picked" />}
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
        {/* Skill and context chips sit inline before the text, each with its own ×. */}
        <div className={`composer-input${picked.length || chips.length ? " has-chips" : ""}`}>
          {picked.map((p) => (
            <span key={p.name} className="skill-chip" title={p.description}>
              ${p.name}
              <button className="chip-x" aria-label={`Remove $${p.name}`} onClick={() => setPicked((list) => list.filter((x) => x.name !== p.name))}>
                ×
              </button>
            </span>
          ))}
          {chips.map((c, i) => (
            <span key={i} className="skill-chip context-chip" title={c}>
              <span className="chip-label">{chipLabel(c)}</span>
              <button className="chip-x" aria-label="Remove this context" onClick={() => setChips((list) => list.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
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
        </div>
        <div className="composer-bar">
          <div className="composer-left">
            <GooeyPlus
              items={[
                { id: "mention", label: "Mention a file or folder (@)", icon: <AtSign size={14} />, onSelect: () => startTrigger("@") },
                { id: "skill", label: "Use a skill ($)", icon: <Sparkles size={14} />, onSelect: () => startTrigger("$") },
                { id: "command", label: "Run a command (/)", icon: <Slash size={14} />, onSelect: () => startTrigger("/") },
              ]}
            />
            {mode}
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
