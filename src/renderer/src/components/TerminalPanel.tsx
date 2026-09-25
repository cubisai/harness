import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { api } from "../api";
import { isDark } from "../store";

function theme(): Terminal["options"]["theme"] {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const dark = isDark();
  return {
    background: v("--bg"),
    foreground: v("--text"),
    cursor: v("--accent"),
    cursorAccent: v("--bg"),
    selectionBackground: dark ? "rgba(10,132,255,0.35)" : "rgba(10,132,255,0.2)",
  };
}

/**
 * A real shell in the project folder (node-pty in the main process). One per
 * project; it keeps running while you switch tabs, and a new one starts if
 * the shell exits.
 */
export function TerminalPanel({ id, cwd, visible }: { id: string; cwd: string | null; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const term = useRef<Terminal | null>(null);

  useEffect(() => {
    const el = host.current!;
    const t = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"),
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: false,
      theme: theme(),
      scrollback: 5000,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    term.current = t;
    fit.current = f;
    f.fit();

    const start = () => void api().terminalOpen(id, cwd, t.cols, t.rows).catch((err: unknown) => {
      t.writeln(`\x1b[31mCouldn't start a shell: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    });
    start();
    const input = t.onData((d) => api().terminalWrite(id, d));
    const resize = t.onResize(({ cols, rows }) => api().terminalResize(id, cols, rows));
    const off = api().onUpdate((u) => {
      if (u.type === "terminal-data" && u.id === id) t.write(u.data);
      if (u.type === "terminal-exit" && u.id === id) {
        t.writeln(`\r\n\x1b[2m[shell exited with ${u.code}; press any key for a new one]\x1b[0m`);
        const once = t.onData(() => {
          once.dispose();
          t.clear();
          start();
        });
      }
    });
    const media = matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => (t.options.theme = theme());
    media.addEventListener("change", retheme);
    window.addEventListener("unskilled-theme", retheme);
    const observer = new ResizeObserver(() => {
      if (el.offsetParent) f.fit();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", retheme);
      window.removeEventListener("unskilled-theme", retheme);
      off();
      input.dispose();
      resize.dispose();
      t.dispose();
    };
  }, [id, cwd]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      fit.current?.fit();
      term.current?.focus();
    });
  }, [visible]);

  return <div className="terminal-host" ref={host} />;
}
