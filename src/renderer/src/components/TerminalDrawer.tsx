import { useEffect, type ReactNode } from "react";
import { BOUNDS, DEFAULT_LAYOUT } from "../layout";
import { useStore } from "../store";
import { Splitter } from "./Splitter";
import { TerminalPanel } from "./TerminalPanel";

/**
 * The bottom terminal drawer, as pure markup. Terminals stay mounted while the
 * drawer is closed (hidden attributes, never unmounting), so their shells live on.
 */
export function TerminalDrawerView(props: {
  open: boolean;
  height: number;
  terminals: string[];
  current: string;
  renderPanel(id: string, visible: boolean): ReactNode;
  onResize(height: number, persist: boolean): void;
  onClose(): void;
}) {
  const { open, height, terminals, current, renderPanel, onResize } = props;
  return (
    <section className="terminal-drawer" id="terminal-drawer" aria-label="Terminal" hidden={!open} style={{ height: open ? height : undefined }}>
      <Splitter
        orientation="horizontal"
        controls="terminal-drawer"
        label="Resize terminal"
        value={height}
        min={BOUNDS.terminal.min}
        max={BOUNDS.terminal.max}
        defaultValue={DEFAULT_LAYOUT.terminal}
        collapsed={false}
        invert
        className="splitter-drawer"
        onChange={(v) => onResize(v, false)}
        onCommit={(v) => onResize(v, true)}
      />
      {terminals.map((id) => (
        <div key={id} className="terminal-body" hidden={!open || id !== current}>
          {renderPanel(id, open && id === current)}
        </div>
      ))}
    </section>
  );
}

/** The connected terminal drawer: reads the store and wires each shell to its project folder. */
export function TerminalDrawer() {
  const open = useStore((s) => s.paneLayout.terminalOpen);
  const height = useStore((s) => s.paneLayout.terminal);
  const terminals = useStore((s) => s.terminals);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const projects = useStore((s) => s.projects);
  const setPaneLayout = useStore((s) => s.setPaneLayout);
  const toggleTerminal = useStore((s) => s.toggleTerminal);
  const current = selectedProjectId ?? "home";

  // Opening the drawer for a project whose shell isn't mounted yet starts one.
  useEffect(() => {
    if (open) useStore.getState().ensureTerminal();
  }, [open, current]);

  return (
    <TerminalDrawerView
      open={open}
      height={height}
      terminals={terminals}
      current={current}
      renderPanel={(id, visible) => <TerminalPanel id={id} cwd={projects.find((p) => p.id === id)?.path ?? null} visible={visible} />}
      onResize={(h, persist) => setPaneLayout({ terminal: h }, persist)}
      onClose={toggleTerminal}
    />
  );
}
