import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import type { AppInfo } from "../../../shared/types";
import { api } from "../api";
import { IconMore } from "../icons";
import { sidebarApps } from "../plugins";
import { useStore } from "../store";
import { appIcon } from "./AppFrame";

/** The sidebar's Apps: up to three (favourites, then recently opened), each with Favourite / Open / Turn off, and See all. */
export function SidebarApps() {
  const apps = useStore((s) => s.apps);
  const recents = useStore((s) => s.appRecents);
  const shown = sidebarApps(apps, recents);
  if (!shown.length) return null;
  return (
    <section className="inbox-section" aria-label="Apps">
      <div className="section-label">Apps</div>
      {shown.map((a) => (
        <AppRow key={a.key} app={a} />
      ))}
      <button type="button" className="nav-row app-row see-all" onClick={() => useStore.setState({ libraryTab: "apps" })}>
        <span>See all</span>
      </button>
    </section>
  );
}

function AppRow({ app }: { app: AppInfo }) {
  const appOpen = useStore((s) => s.appOpen);
  const appPage = useStore((s) => s.appPage);
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const Icon = appIcon(app.icon);
  const open = appOpen?.key === app.key || appPage?.key === app.key;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenu(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc, true);
    };
  }, [menu]);

  const act = (fn: () => Promise<unknown> | void) => () => {
    setMenu(false);
    void Promise.resolve(fn()).catch((err: unknown) => useStore.getState().showNotice(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div ref={box} className={`app-row-wrap${menu ? " menu-open" : ""}`} onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}>
      <button
        type="button"
        className={`nav-row app-row${open ? " current" : ""}`}
        aria-current={open ? "true" : undefined}
        disabled={Boolean(app.error)}
        title={app.error ?? `${app.description}${app.scope === "global" ? " (global)" : ""}`}
        onClick={() => useStore.getState().openApp(app)}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden />
        <span>{app.title}</span>
        {app.favorite !== undefined && <Star size={11} strokeWidth={1.75} className="app-row-star" aria-label="Favourite" />}
      </button>
      <button type="button" className="icon-button app-row-more" aria-haspopup="menu" aria-expanded={menu} title={`${app.title} options`} aria-label={`${app.title} options`} onClick={() => setMenu((m) => !m)}>
        <IconMore />
      </button>
      {menu && (
        <div className="thread-menu" role="menu">
          <button role="menuitem" autoFocus onClick={act(() => api().setAppFavorite(app.key, app.favorite === undefined))}>
            {app.favorite === undefined ? "Favourite" : "Unfavourite"}
          </button>
          <button role="menuitem" onClick={act(() => useStore.getState().openApp(app))}>
            Open
          </button>
          <button role="menuitem" onClick={act(() => api().setAppEnabled(app.key, false))}>
            Turn off
          </button>
        </div>
      )}
    </div>
  );
}
