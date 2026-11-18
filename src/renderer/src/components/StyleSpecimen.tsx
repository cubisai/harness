import { useEffect, useRef, useState } from "react";

/** A script-free desktop specimen, scaled to its box rather than clipped in narrow panes. */
export function StyleSpecimen({ title, url }: { title: string; url: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ scale: 0.375, height: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const resize = () => {
      const scale = el.clientWidth / 960 || 0.375;
      setSize({ scale, height: el.clientHeight / scale });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div className="sp-specimen" ref={box}>
    <iframe title={title} sandbox="" tabIndex={-1} src={url} style={{ width: 960, height: size.height || undefined, transform: `scale(${size.scale})` }} />
  </div>;
}
