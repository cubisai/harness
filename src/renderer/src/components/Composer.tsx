import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillEntry } from "../../../shared/types";
import { IconArrowUp, IconStop } from "../icons";
import { useStore } from "../store";

/**
 * The message box. Typing `/` at the start opens the menu of skilled's
 * user-invoked skills; picking one turns it into a chip, and whatever is
 * typed after it goes to the skill as its arguments.
 */
export function Composer({ threadId }: { threadId: string }) {
  const skills = useStore((s) => s.skills);
  const running = useStore((s) => Boolean(s.running[threadId]));
  const insert = useStore((s) => s.composerInsert);
  const { send, interrupt } = useStore.getState();
  const [text, setText] = useState("");
  const [skill, setSkill] = useState<SkillEntry | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => setMenuIndex(0), [query]);
  useEffect(() => {
    area.current?.focus();
    setText("");
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

  // A picked element lands at the end of whatever is being written.
  useEffect(() => {
    if (!insert) return;
    setText((t) => (t.trim() ? `${t.trimEnd()}\n\n${insert.text}\n` : `${insert.text}\n`));
    useStore.setState({ composerInsert: null }); // consumed: don't re-apply on the next mount
    area.current?.focus();
  }, [insert]);

  // Grow with the content, up to the CSS max-height.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const pick = (s: SkillEntry) => {
    setSkill(s);
    setText("");
    area.current?.focus();
  };

  const submit = () => {
    if (running) return;
    const body = text.trim();
    if (!body && !skill) return;
    void send(body, skill?.name);
    setText("");
    setSkill(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (e.key === "Escape" && menuOpen) {
      setText("");
      return;
    }
    if (e.key === "Backspace" && skill && !text) {
      setSkill(null);
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
                <span className="d">{s.description}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-bar">
          {skill && (
            <span className="skill-chip" title={skill.description}>
              /{skill.name}
            </span>
          )}
          <span className="grow" />
          <span className="hint">{running ? "Esc to stop" : "Return to send · Shift-Return for a new line"}</span>
          {running ? (
            <button className="send stop" title="Stop" onClick={() => void interrupt()}>
              <IconStop />
            </button>
          ) : (
            <button className="send" title="Send" disabled={!text.trim() && !skill} onClick={submit}>
              <IconArrowUp />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
