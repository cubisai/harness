import { useEffect, useState } from "react";
import { AUTO_SYSTEM, type DesignDirection } from "../../../shared/direction";
import type { DesignSystemOption } from "../../../shared/types";
import { api } from "../api";

/** The system a thread uses when it names none (or one that's gone): the project's own, else Clean, else the first. */
export function shownSystem(options: DesignSystemOption[], id: string | undefined): DesignSystemOption | undefined {
  return (id ? options.find((o) => o.id === id) : undefined) ?? options.find((o) => o.id === "project") ?? options.find((o) => o.id === "clean") ?? options[0];
}

/** The style a thread's design is drawn in, by name (the board's `Page · Style` labels): Auto's pick, else the fixed system. */
export function designStyleName(options: DesignSystemOption[], value: string | undefined, direction?: DesignDirection | null): string | undefined {
  if (value === AUTO_SYSTEM) return direction ? options.find((o) => o.id === direction.style)?.name : undefined;
  return shownSystem(options, value)?.name;
}

const lastOptions = new Map<string | null, DesignSystemOption[]>();

/**
 * The design systems a project's threads can pick from. Re-read on open too: a system the agent just extracted into
 * .agents/design-systems shows up without a restart. And when the value changes: the System tab's first edit switches
 * the thread to a copy that wasn't in the list yet.
 */
export function useDesignSystemOptions(projectId: string | null, open: boolean, value: string | undefined): DesignSystemOption[] {
  // The last list per project seeds a remounted chip, so it doesn't blink empty (and resize the bar) while it re-reads.
  const [options, setOptions] = useState<DesignSystemOption[]>(() => lastOptions.get(projectId) ?? []);
  useEffect(() => {
    let live = true;
    void api()
      .designSystems(projectId)
      .then((list) => {
        lastOptions.set(projectId, list);
        if (live) setOptions(list);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, open, value]);
  return options;
}
