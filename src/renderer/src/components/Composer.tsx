import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { File, Folder } from "lucide-react";
import type { SkillEntry } from "../../../shared/types";
import { IconArrowUp, IconStop } from "../icons";
import { api } from "../api";
import { chipLabel, composeMessage } from "../composer";
import { folderPaths, mentionQueryAt, mentionsIn, rankMentions } from "../mentions";
import { useStore } from "../store";
import { originLabel } from "./Library";

/**
 * The message box. Typing `/` at the start opens the menu of skilled's
 * user-invoked skills; picking one turns it into a chip, and whatever is
 * typed after it goes to the skill as its arguments. A picked browser
 * element becomes a context chip whose text rides along with the message.
 * Sending while a turn runs queues the message for the next turn. With no
 * thread yet (`threadId` null), sending starts one. Alt+Return starts the
 * message in a new thread in the background instead, leaving this one open.
 * The thread's controls (agent, model, permissions) and meters sit in its bar.
 */
export function Composer({ threadId, controls, meters }: { threadId: string | null; controls?: ReactNode; meters?: ReactNode }) {
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
  const area = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  /** listFiles results by project id, with when they were fetched, so the picker doesn't refetch per keystroke. */
  const filesCache = useRef(new Map<string, { at: number; files: string[] }>());

  const query = !skill && text.startsWith("/") && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
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

  const mentionQuery = mentionQueryAt(text, caret);
  const mentionOpen = mentionQuery !== null && !menuOpen && !mentionDismissed;
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

  const submit = () => {
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
    if (e.key === "Escape" && menuOpen) {
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
    ? skill.argumentHint ?? `Anything to tell /${skill.name}? Or just press Return.`
    : "Ask anything, or type / for a skill";

  return (
    <div className="composer-wrap">
      <div className="composer">
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
                <span className="n">/{s.name}</span>
                <span className="skill-origin">{originLabel(s.origin)}</span>
                <span className="d">{s.description}</span>
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
            {controls}
            {skill && (
              <span className="skill-chip" title={skill.description}>
                /{skill.name}
              </span>
            )}
            {chips.map((c, i) => (
              <span key={i} className="skill-chip context-chip" title={c}>
                {chipLabel(c)}
              </span>
            ))}
            <span className="grow" />
            {running && <span className="hint">Return queues for the next turn</span>}
            {meters}
          </div>
          <div className="composer-actions">
            {running && (
              <button className="send stop" title="Stop (clears queued messages)" onClick={() => void interrupt()}>
                <IconStop />
              </button>
            )}
            {(!running || text.trim() || chips.length > 0) && (
              <button className="send" title={running ? "Queue for the next turn" : "Send"} disabled={!text.trim() && !skill && !chips.length} onClick={submit}>
                <IconArrowUp />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
