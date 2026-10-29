import type { CSSProperties } from "react";

/**
 * The running beam (after libraries.dev border-beam, rebuilt in CSS): soft colour
 * glowing just inside the host's edges plus a faint highlight riding its border,
 * swept round by a rotating window. Place it as the first child of a
 * `position: relative` element with a border radius; it takes the host's shape.
 * `edge` is how far the glow reaches in from the edges (px).
 */
export function Beam({ edge }: { edge?: number }) {
  const style = edge === undefined ? undefined : ({ "--beam-edge": `${edge}px` } as CSSProperties);
  return (
    <span className="beam" aria-hidden="true" style={style}>
      <span className="beam-inner" />
      <span className="beam-stroke" />
      <span className="beam-bloom" />
    </span>
  );
}
