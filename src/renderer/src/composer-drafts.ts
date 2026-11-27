import { createStore } from "zustand/vanilla";
import type { PluginCommandInvocation } from "../../shared/plugin-parts";
import type { SkillEntry } from "../../shared/types";
import type { PendingAttachment } from "./attachments";

interface ComposerInput {
  text: string;
  chips: string[];
  refs: { path: string; thumb: string }[];
  files: PendingAttachment[];
  picked: SkillEntry[];
  pluginCommand: PluginCommandInvocation | null;
}

const empty: ComposerInput = { text: "", chips: [], refs: [], files: [], picked: [], pluginCommand: null };
const hasInput = (d: ComposerInput) => Boolean(d.text || d.chips.length || d.refs.length || d.files.length || d.picked.length);

function createDrafts() {
  const store = createStore(() => ({ input: empty, waiting: [] as ComposerInput[] }));
  return {
    store,
    edit<K extends keyof ComposerInput>(key: K, value: ComposerInput[K] | ((current: ComposerInput[K]) => ComposerInput[K])) {
      store.setState(({ input }) => ({ input: { ...input, [key]: typeof value === "function" ? value(input[key]) : value } }));
    },
    take() {
      const { input, waiting } = store.getState();
      store.setState({ input: waiting[0] ?? empty, waiting: waiting.slice(1) });
      return input;
    },
    recover(input: ComposerInput) {
      store.setState((s) => hasInput(s.input) ? { ...s, waiting: [...s.waiting, input] } : { ...s, input });
    },
    switchDraft() {
      const { input, waiting } = store.getState();
      if (!waiting.length) return;
      const rest = waiting.slice(1);
      if (hasInput(input)) rest.push(input);
      store.setState({ input: waiting[0]!, waiting: rest });
    },
  };
}

// Renderer-session only. A late creation reply edits the store it started from,
// even if a different thread or project's start screen is now mounted.
const projects = new Map<string | null, Map<string, ReturnType<typeof createDrafts>>>();
export function composerDrafts(project: string | null, owner: string) {
  let entries = projects.get(project);
  if (!entries) {
    entries = new Map();
    projects.set(project, entries);
  }
  let drafts = entries.get(owner);
  if (!drafts) {
    drafts = createDrafts();
    entries.set(owner, drafts);
  }
  return drafts;
}

export function forgetComposerDrafts(project: string, thread?: string) {
  if (thread) projects.get(project)?.delete(thread);
  else projects.delete(project);
}
