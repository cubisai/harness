import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AtSign, Blocks, BriefcaseBusiness, Check, CircleDot, File, Folder, ImagePlus, Puzzle, Slash, Sparkles } from "lucide-react";
import type { PermissionMode, SkillEntry } from "../../../shared/types";
import { IconArrowUp, IconStop } from "../icons";
import { api } from "../api";
import { chipLabel, commandQuery, composeMessage, skillQueryAt, toggleSkill } from "../composer";
import { MAX_REFS, imageFiles, refLabel, refThumb, withRefs } from "../design/refs";
import { designChipLabel, designIntent, designPlaceholder, systemChips } from "../design/intent";
import { elementLabel, withScope } from "../../../shared/selection";
import { designDirName } from "../../../shared/design";
import { exactCommand, isCommandSkill, issueCommand, matchCommands, type ComposerCommand } from "../commands";
import { folderPaths, mentionQueryAt, mentionsIn, rankMentions } from "../mentions";
import { nextMode } from "../modes";
import { findThread, useStore } from "../store";
import { originLabel } from "./Library";
import { Beam } from "./Beam";
import { ExpertsSubmenu } from "./ExpertsSubmenu";
import { GooeyPlus } from "./GooeyPlus";
import { IssuesSubmenu } from "./IssuesSubmenu";
import { SkillsSubmenu } from "./SkillsSubmenu";

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

/** The studio's one chip: `Selection: StatCard`, or `Selection: 3 elements`. */
export function selectionChipLabel(selection: { elements: Parameters<typeof elementLabel>[0][]; names?: string[] }): string {
  const n = selection.elements.length;
  return `Selection: ${n === 1 ? (selection.names?.[0] ?? elementLabel(selection.elements[0]!)) : `${n} elements`}`;
}

export function Composer({
  threadId,
  mode,
  compactMode,
  model,
  meters,
  lip,
  beforeModel,
  selectionPrompts = false,
}: {
  threadId: string | null;
  mode?: ReactNode;
  /** The same controls folded into fewer chips, swapped in only when `mode` leaves no room on the row. */
  compactMode?: ReactNode;
  model?: ReactNode;
  meters?: ReactNode;
  /** One quiet line on the box's top edge (the studio's running status). */
  lip?: ReactNode;
  /** Controls at the start of the right-hand group (the studio's Chat chip). */
  beforeModel?: ReactNode;
  /** Say in the placeholder what a canvas selection is about to be asked. */
  selectionPrompts?: boolean;
}) {
  const allSkills = useStore((s) => s.skills);
  // Design-only skills are offered in design threads (and a design draft) only; threadKind follows the open thread.
  const designKind = useStore((s) => s.threadKind) === "design";
  // The issue skills run as "/" commands, so "$" leaves them out.
  const skills = useMemo(() => allSkills.filter((s) => !isCommandSkill(s) && (designKind || s.mode !== "design")), [allSkills, designKind]);
  const running = useStore((s) => (threadId ? Boolean(s.running[threadId]) : false));
  const insert = useStore((s) => s.composerInsert);
  const { send, interrupt, enqueue, startThread, sendInBackground } = useStore.getState();
  const projectId = useStore((s) => s.selectedProjectId);
  // The thread's issue, or the one picked for the thread this draft starts.
  const issue = useStore((s) =>
    threadId ? (findThread(s.threads, threadId)?.issue ?? null) : s.draft.issue?.projectId === s.selectedProjectId ? s.draft.issue.issue : null,
  );
  const issueRequest = useStore((s) => s.issuePickerRequest);
  const [text, setText] = useState("");
  const [chips, setChips] = useState<string[]>([]);
  const [picked, setPicked] = useState<SkillEntry[]>([]);
  const [skillDismissed, setSkillDismissed] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [caret, setCaret] = useState(0);
  const [knownFiles, setKnownFiles] = useState<string[]>([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  // Reference images pasted or dropped into a design thread: saved in its design folder, sent as mentions.
  const [refs, setRefs] = useState<{ path: string; thumb: string }[]>([]);
  const [addingRefs, setAddingRefs] = useState(false);
  // Images handed over by the canvas (Draw → Attach) join the reference chips, up to the cap.
  const pendingRefs = useStore((s) => (threadId ? s.pendingRefs[threadId] : undefined));
  useEffect(() => {
    if (!threadId || !pendingRefs?.length) return;
    const taken = useStore.getState().takeDesignRefs(threadId);
    setRefs((list) => {
      if (list.length + taken.length > MAX_REFS) useStore.getState().showNotice(`At most ${MAX_REFS} reference images per message.`);
      return [...list, ...taken].slice(0, MAX_REFS);
    });
  }, [threadId, pendingRefs]);
  // Elements selected on a design thread's canvas: chips here, and a "change only these" block on the next message.
  const selection = useStore((s) => (threadId ? s.designSelection[threadId] : undefined));
  // The studio's design chip (`+` menu, System mode) and System mode's context; both ride on the next message.
  const designChip = useStore((s) => (threadId && selectionPrompts ? s.designChip[threadId] : undefined));
  const systemWhere = useStore((s) => (threadId && selectionPrompts ? s.designSystemWhere[threadId] : undefined));
  const [droppedSystem, setDroppedSystem] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setDroppedSystem(new Set()), [systemWhere?.page, systemWhere?.theme]);
  const system = systemChips(systemWhere, droppedSystem);
  const screenshotInput = useRef<HTMLInputElement>(null);
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
    setRefs([]);
    setPicked(entriesOf(useStore.getState().takePendingSkills()));
  }, [threadId]);

  /** Save pasted or dropped images as the design's references; true when the event was ours to handle. */
  const takeImages = (files: ArrayLike<File> | null | undefined): boolean => {
    if (!designKind) return false;
    const images = imageFiles(files);
    if (!images.length) return false;
    if (!threadId) {
      useStore.getState().showNotice("Send a first message to start the design, then add reference images.");
      return true;
    }
    const room = MAX_REFS - refs.length;
    if (room <= 0) {
      useStore.getState().showNotice(`At most ${MAX_REFS} reference images per message.`);
      return true;
    }
    setAddingRefs(true);
    void (async () => {
      for (const file of images.slice(0, room)) {
        try {
          const path = await api().designSaveRef(threadId, new Uint8Array(await file.arrayBuffer()));
          const thumb = await refThumb(file);
          setRefs((list) => [...list, { path, thumb }]);
        } catch (err) {
          useStore.getState().showNotice(`Couldn't add the image: ${err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err)}`);
        }
      }
      setAddingRefs(false);
    })();
    return true;
  };

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
    else if (c.name === "issue") s.requestIssuePicker();
    else if (c.name === "issue-setup" || c.name === "triage" || c.name === "pr") void s.runIssueCommand(c.name, "");
    else if (c.name === "context") s.openContextSheet(threadId);
    else if (c.name === "mcp") s.openMcpSheet();
    else if (c.name === "doctor") s.openDoctor();
    else if (c.name === "codemode") void s.setCodeMode();
    else if (c.name === "compact") {
      if (threadId) void s.compact(threadId, null);
    }
    else if (c.name === "plan") {
      const mode: PermissionMode = "plan";
      if (threadId) void s.updateThread({ permissionMode: mode });
      else s.setDraft({ permissionMode: mode });
    }
    area.current?.focus();
  };

  const submit = () => {
    // "/issue <description>", "/triage 12", "/pr 12" run their bundled skill with the argument.
    const issueRun = !picked.length && issueCommand(text);
    if (issueRun) {
      void useStore.getState().runIssueCommand(issueRun.skill, issueRun.args);
      setText("");
      setCaret(0);
      return;
    }
    // "/compact <focus>" is a command with an argument, not a message.
    const compactMatch = !picked.length && /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (compactMatch) {
      if (!threadId || running) return;
      void useStore.getState().compact(threadId, compactMatch[1]?.trim() || null);
      setText("");
      setCaret(0);
      return;
    }
    // "/codemode [on|off]" sets code mode for new threads (no argument flips it); it never goes to the agent.
    const codeMatch = !picked.length && /^\/codemode(?:\s+(on|off))?$/i.exec(text.trim());
    if (codeMatch) {
      void useStore.getState().setCodeMode(codeMatch[1]?.toLowerCase() as "on" | "off" | undefined);
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
    // A bare "/name" (what Tab leaves behind) runs that command, as Enter in the menu does.
    const bare = !picked.length && exactCommand(text);
    if (bare) {
      runCommand(bare);
      return;
    }
    const refPaths = refs.map((r) => r.path);
    const message = withRefs(composeMessage(text, chips), refPaths);
    if (!message && !picked.length) return;
    if (designChip?.kind === "match-screenshot" && !refs.length) {
      useStore.getState().showNotice("Add the screenshot first: paste it, drop it here, or pick it from + → Match a screenshot….");
      return;
    }
    // The selection scopes a real request; on its own it isn't one.
    const body = withScope(message, selection && threadId ? `${designDirName(threadId)}/${selection.page}` : null, selection?.elements ?? []);
    const mentions = [...mentionsIn(text, knownSet), ...refPaths];
    const names = picked.map((p) => p.name);
    if (selection && threadId) useStore.getState().setDesignSelection(threadId, null);
    const go = () => {
      if (!threadId) void startThread(body, names, mentions);
      else if (running) enqueue(threadId, body, names, mentions);
      else
        void send(body, names, undefined, mentions).then((ok) => {
          if (!ok) setText((cur) => cur || text);
        });
    };
    // The intent reaches the main process before the message, which takes it into the turn.
    const intent = threadId ? designIntent(designChip, system) : null;
    if (threadId && designChip) useStore.getState().setDesignChip(threadId, null);
    if (threadId && intent) void api().designSetIntent(threadId, intent).catch(() => {}).then(go);
    else go();
    setText("");
    setChips([]);
    setRefs([]);
    setPicked([]);
    setCaret(0);
  };

  // Alt+Return starts the message as its own thread in the background and leaves this one open.
  const submitInBackground = () => {
    // "/codemode [on|off]" sets code mode for new threads (no argument flips it); it never goes to the agent.
    const codeMatch = !picked.length && /^\/codemode(?:\s+(on|off))?$/i.exec(text.trim());
    if (codeMatch) {
      void useStore.getState().setCodeMode(codeMatch[1]?.toLowerCase() as "on" | "off" | undefined);
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
    const refPaths = refs.map((r) => r.path);
    const body = withRefs(composeMessage(text, chips), refPaths);
    if (!body && !picked.length) return;
    const mentions = [...mentionsIn(text, knownSet), ...refPaths];
    void sendInBackground(body, picked.map((p) => p.name), undefined, mentions);
    setText("");
    setChips([]);
    setRefs([]);
    setPicked([]);
    setCaret(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab" && e.shiftKey && !e.nativeEvent.isComposing) {
      // Shift+Tab cycles the permission mode: the open thread's, or the draft's (design threads are always Full).
      e.preventDefault();
      const s = useStore.getState();
      const design = threadId
        ? Object.values(s.threads).flat().find((t) => t.id === threadId)?.kind === "design"
        : s.threadKind === "design";
      if (design) return;
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
      // Tab completes the name ("/name "), so an argument can follow; Enter runs it.
      if (e.key === "Tab") {
        e.preventDefault();
        const c = commandMatches[menuIndex];
        if (c) {
          const next = `/${c.name} `;
          pendingCaret.current = next.length;
          setText(next);
        }
        return;
      }
      if (e.key === "Enter") {
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
      : designPlaceholder(designChip, system) ??
        (selectionPrompts && selection?.elements.length
        ? "Describe a change…"
      : "Ask anything — $ for a skill, / for a command");

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

  const canSend = Boolean(text.trim() || picked.length || chips.length || refs.length) && !addingRefs;

  // The controls stay one row. When the chips wrap or the actions run into them, the bar folds a step at a time:
  // 1 the chips drop their labels (icons), 2 they merge into `compactMode` (a design thread's one chip), and 3 only if
  // the actions still collide do the model, context and Send take a row of their own, so nothing overlaps. Measured
  // before paint; a new width starts unfolded, and a chip that changes size later (a menu that loads its list) only
  // ever folds further, so measuring can't loop.
  const barEl = useRef<HTMLDivElement | null>(null);
  const barObserver = useRef<ResizeObserver | null>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [fold, setFold] = useState(0);
  const [, setResized] = useState(0);
  const foldedAt = useRef(0);
  const barRef = useCallback((el: HTMLDivElement | null) => {
    barObserver.current?.disconnect();
    barObserver.current = null;
    barEl.current = el;
    if (!el) return;
    // flushSync: the new width and every fold step it causes land before the browser paints, so a resize never shows
    // a frame of overlapping or wrapped controls. The two groups are watched too: a chip that appears or grows later
    // re-renders the bar (it lives in its own component), so the layout effect measures again.
    barObserver.current = new ResizeObserver((entries) =>
      flushSync(() => {
        setBarWidth(el.clientWidth);
        if (entries.some((entry) => entry.target !== el)) setResized((n) => n + 1);
      }),
    );
    barObserver.current.observe(el);
    for (const group of el.querySelectorAll(".composer-left, .composer-actions")) barObserver.current.observe(group);
  }, []);
  useLayoutEffect(() => {
    const bar = barEl.current;
    if (!bar) return;
    if (foldedAt.current !== barWidth) {
      foldedAt.current = barWidth;
      if (fold !== 0) {
        setFold(0);
        return;
      }
    }
    if (fold >= 3) return;
    const actions = bar.querySelector<HTMLElement>(".composer-actions");
    const first = actions?.firstElementChild;
    // The actions end-align, so when they don't fit they spill out of their box's start, over the chips.
    const collides = !!actions && !!first && first.getBoundingClientRect().left < actions.getBoundingClientRect().left - 0.5;
    const tops = [...(bar.querySelector(".composer-left")?.children ?? [])].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => r.top);
    const wrapped = tops.some((top) => Math.abs(top - tops[0]!) > 2);
    if (!collides && !wrapped) return;
    let next = fold + 1;
    if (next === 2 && !compactMode) next = 3;
    // A last-resort second row only for a collision; chips that merely wrap stay as they always have.
    if (next === 3 && !collides) return;
    setFold(next);
  });

  return (
    <div className="composer-wrap">
      <div className={`composer${running ? " running" : ""}`}>
        {running && <Beam />}
        {lip}
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
        <div
          className={`composer-input${issue || picked.length || chips.length || refs.length || selection || designChip || system.length ? " has-chips" : ""}`}
          onDragOver={(e) => {
            if (designKind && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (takeImages(e.dataTransfer.files)) e.preventDefault();
          }}
        >
          {issue && (
            <span className="skill-chip context-chip issue-chip" title={[`#${issue.number} ${issue.title}`, issue.labels.join(", ")].filter(Boolean).join("\n")}>
              <span className="issues-num">#{issue.number}</span>
              <span className="chip-label">{issue.title}</span>
              <button className="chip-x" aria-label={`Clear issue #${issue.number}`} onClick={() => void useStore.getState().setIssue(null)}>
                ×
              </button>
            </span>
          )}
          {threadId &&
            system.map((c) => (
              <span key={c} className="skill-chip context-chip system-chip" title={c === "Library" ? "This message changes the design system, not the page" : c}>
                <span className="chip-label">{c}</span>
                <button className="chip-x" aria-label={`Remove ${c}`} onClick={() => setDroppedSystem((d) => new Set([...d, c]))}>
                  ×
                </button>
              </span>
            ))}
          {threadId && designChip && (
            <span className="skill-chip context-chip design-intent-chip">
              <span className="chip-label">{designChipLabel(designChip)}</span>
              <button className="chip-x" aria-label={`Remove ${designChipLabel(designChip)}`} onClick={() => useStore.getState().setDesignChip(threadId, null)}>
                ×
              </button>
            </span>
          )}
          {selection && selectionPrompts ? (
            <span className="skill-chip context-chip select-chip studio-select-chip" title={selection.elements.map((el) => el.selector).join("\n")}>
              <span className="chip-label">{selectionChipLabel(selection)}</span>
              <button className="chip-x" aria-label="Clear the selection" onClick={() => threadId && useStore.getState().setDesignSelection(threadId, null)}>
                ×
              </button>
            </span>
          ) : (
            selection?.elements.map((el, i) => (
            <span key={el.id ?? el.selector} className="skill-chip context-chip select-chip" title={el.selector}>
              <span className="chip-label">{elementLabel(el)}</span>
              <button
                className="chip-x"
                aria-label={`Unselect ${elementLabel(el)}`}
                onClick={() => threadId && useStore.getState().setDesignSelection(threadId, { page: selection.page, elements: selection.elements.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </span>
          ))
          )}
          {refs.map((r) => (
            <span key={r.path} className="skill-chip context-chip ref-chip" title={r.path}>
              {r.thumb && <img className="ref-thumb" src={r.thumb} alt="" />}
              <span className="chip-label">{refLabel(r.path)}</span>
              <button className="chip-x" aria-label={`Remove ${refLabel(r.path)}`} onClick={() => setRefs((list) => list.filter((x) => x.path !== r.path))}>
                ×
              </button>
            </span>
          ))}
          {addingRefs && <span className="skill-chip context-chip ref-chip">Adding image…</span>}
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
            onPaste={(e) => {
              if (takeImages(e.clipboardData.files)) e.preventDefault();
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className={`composer-bar${fold >= 1 ? " icons" : ""}${fold >= 3 ? " stacked" : ""}`} ref={barRef}>
          <div className="composer-left">
            <GooeyPlus
              openSub={{ id: "issues", n: issueRequest }}
              items={[
                { id: "experts", label: "Experts", icon: <BriefcaseBusiness size={14} />, onSelect: () => {}, submenu: (close) => <ExpertsSubmenu close={close} /> },
                { id: "skills", label: "Skills", icon: <Puzzle size={14} />, onSelect: () => {}, submenu: (close) => <SkillsSubmenu close={close} /> },
                { id: "issues", label: "Issues", icon: <CircleDot size={14} />, onSelect: () => {}, submenu: (close) => <IssuesSubmenu close={close} /> },
                { id: "mention", label: "Mention a file or folder (@)", icon: <AtSign size={14} />, onSelect: () => startTrigger("@") },
                { id: "skill", label: "Use a skill ($)", icon: <Sparkles size={14} />, onSelect: () => startTrigger("$") },
                { id: "command", label: "Run a command (/)", icon: <Slash size={14} />, onSelect: () => startTrigger("/") },
                ...(selectionPrompts && threadId
                  ? [
                      { id: "new-kit", label: "Start a new kit…", icon: <Blocks size={14} />, onSelect: () => useStore.getState().setDesignChip(threadId, { kind: "new-kit" }) },
                      { id: "match-screenshot", label: "Match a screenshot…", icon: <ImagePlus size={14} />, onSelect: () => screenshotInput.current?.click() },
                    ]
                  : []),
              ]}
            />
            {selectionPrompts && threadId && (
              <input
                ref={screenshotInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  if (takeImages(e.currentTarget.files)) {
                    useStore.getState().setDesignChip(threadId, { kind: "match-screenshot" });
                    if (!text.trim()) setText("Match this screen: ");
                    area.current?.focus();
                  }
                  e.currentTarget.value = "";
                }}
              />
            )}
            {fold >= 2 && compactMode ? compactMode : mode}
            <span className="grow" />
          </div>
          <div className="composer-actions">
            {beforeModel}
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
