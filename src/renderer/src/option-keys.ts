import type { KeyboardEvent } from "react";

/**
 * Where focus goes in a list of `count` options after `key`, from `current` (-1 when no option has
 * focus): Arrow Down/Up step and wrap, Home/End jump. Null for any other key, or an empty list.
 */
export function nextOptionIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Moves focus between a popup menu's `[role=option]` buttons for an arrow/Home/End key; true when it handled the key. */
export function focusOption(e: KeyboardEvent, menu: HTMLElement | null): boolean {
  if (!menu) return false;
  const options = Array.from(menu.querySelectorAll<HTMLElement>('[role="option"]'));
  const next = nextOptionIndex(e.key, options.indexOf(document.activeElement as HTMLElement), options.length);
  if (next === null) return false;
  e.preventDefault();
  e.stopPropagation();
  options[next]?.focus();
  return true;
}

/** Focuses a just-opened menu's selected option (else its first), so the arrows start from there. */
export function focusSelectedOption(menu: HTMLElement | null): void {
  (menu?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ?? menu?.querySelector<HTMLElement>('[role="option"]'))?.focus();
}
