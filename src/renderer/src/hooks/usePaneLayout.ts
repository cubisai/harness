import { useEffect, useLayoutEffect, useState } from "react";
import { clampLayout } from "../layout";
import { useStore } from "../store";

/**
 * The pane widths the window can actually draw at its current size. Writes the
 * resulting widths to the CSS custom properties the grid reads; the stored
 * layout is never changed here.
 */
export function usePaneLayout(inspectorVisible: boolean, mainFloor?: number): { sidebar: number; inspector: number | null; inspectorAutoCollapsed: boolean; inspectorMax: number; width: number } {
  const layout = useStore((s) => s.paneLayout);
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const result = clampLayout(width, layout, inspectorVisible, mainFloor);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", `${result.sidebar}px`);
    if (result.inspector !== null) document.documentElement.style.setProperty("--inspector-w", `${result.inspector}px`);
  }, [result.sidebar, result.inspector]);

  return { ...result, width };
}
