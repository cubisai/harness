import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { BOARD_SIZES, flowOrder, parsePage } from "./board-layout";
import { readBridgeMessage } from "./frame";

/** The page shown, in board order, in a sandboxed frame scaled to the overlay: ← / → step, Exit leaves. */
export function Present({ pages, links, start, onExit }: { pages: { rel: string; url: string }[]; links?: { from: string; to: string }[]; start: string; onExit: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const pageKey = pages.map((p) => p.rel).join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `pages` follows `pageKey`
  const order = useMemo(() => flowOrder(pages), [pageKey]);
  const [current, setCurrent] = useState(start);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  const page = pages.find((p) => p.rel === current) ?? pages.find((p) => p.rel === start) ?? pages[0];
  const parsed = page ? parsePage(page.rel, page.url) : null;
  const size = parsed ? BOARD_SIZES[parsed.kind] : BOARD_SIZES.desktop;
  const scale = stage.width > 0 && stage.height > 0 ? Math.min(1, (stage.width - 64) / size.width, (stage.height - 64) / size.height) : 1;
  const index = order.indexOf(current);

  // Measure the stage (below the bar), so the frame scales down to fit with 32px of padding around it.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Take focus for the keys, and hand it back to whatever had it on exit.
  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayRef.current?.focus();
    return () => restoreRef.current?.focus();
  }, []);

  const step = (dir: number) => {
    if (order.length === 0) return;
    const at = order.indexOf(current);
    const next = order[(at + dir + order.length) % order.length];
    if (next) setCurrent(next);
  };

  // Escape leaves; ← / → step through the board's order.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onExit();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `step` follows `current` and `order`
  }, [current, order, onExit]);

  // A link clicked inside the frame navigates it; the injected bridge says "ready" with the new path (the sandboxed
  // frame is cross-origin, so its location can't be read directly). Follow it when it names one of the design's pages.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const msg = readBridgeMessage(e.data);
      if (msg?.type !== "ready" || !msg.path) return;
      let rel = "";
      try {
        rel = decodeURIComponent(msg.path.split("/").pop() ?? "");
      } catch {
        return;
      }
      if (rel && pages.some((p) => p.rel === rel)) setCurrent(rel);
      // A click inside the prototype moved focus into the frame; take it back so Esc and the arrows keep working.
      overlayRef.current?.focus();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pages` follows `pageKey`
  }, [pageKey]);

  if (!page || !parsed) return null;

  return (
    <div className="design-present" ref={overlayRef} tabIndex={-1} role="dialog" aria-label={`Present: ${parsed.label}`}>
      <div className="design-present-bar">
        <span className="design-present-label" title={page.rel}>
          {parsed.label}
        </span>
        <span className="design-present-count">
          {index + 1} / {order.length}
        </span>
        <button className="icon-button" aria-label="Previous screen" title="Previous screen" onClick={() => step(-1)}>
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <button className="icon-button" aria-label="Next screen" title="Next screen" onClick={() => step(1)}>
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <button className="button ghost" onClick={onExit}>
          Exit
        </button>
      </div>
      <div className="design-present-stage" ref={stageRef}>
        <div className={`design-present-device${parsed.kind === "mobile" ? " mobile" : ""}`} style={{ width: size.width * scale, height: size.height * scale }}>
          <iframe
            key={page.rel}
            ref={frameRef}
            className="design-frame"
            title={`Present: ${page.rel}`}
            src={page.url}
            sandbox="allow-scripts"
            style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
          />
        </div>
      </div>
    </div>
  );
}
