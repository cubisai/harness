import { MODES } from "./ThreadControls";

/**
 * A design thread's access, shown, not picked: always Full, fenced to its folder. The style and tier are the agent's (Auto); the user asks for a different look in words.
 */
export function DesignFenceChip() {
  return (
    <span
      className="chip-button mode-chip design-fence-chip"
      role="img"
      aria-label="Full access, fenced to this design's folder"
      title="Full access, fenced to this design's folder. Ask in the chat for a different look."
    >
      <MODES.full.Icon size={13} />
    </span>
  );
}
