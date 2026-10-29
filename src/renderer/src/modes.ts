import type { PermissionMode } from "../../shared/types";

/** The permission-mode cycle order (Shift+Tab): ask → auto-edit → plan → full. */
export const MODE_ORDER: PermissionMode[] = ["ask", "auto-edit", "plan", "full"];

/** The next mode in the cycle; full wraps back to ask. */
export function nextMode(m: PermissionMode): PermissionMode {
  const at = MODE_ORDER.indexOf(m);
  return MODE_ORDER[(at + 1) % MODE_ORDER.length]!;
}
