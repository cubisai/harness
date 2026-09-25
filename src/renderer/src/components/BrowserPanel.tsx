import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { IconArrowLeft, IconArrowRight, IconGlobe, IconRefresh, IconTarget } from "../icons";
import { useStore } from "../store";

/** The <webview> element's API, as far as this panel uses it. */
interface WebviewElement extends HTMLElement {
  src: string;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): Promise<void>;
}

function normalize(input: string): string {
  const s = input.trim();
  if (!s) return "about:blank";
  // A scheme, unless it's really host:port ("localhost:3000").
  if (/^[a-z][a-z0-9+.-]*:(\/\/|[^\d])/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/.test(s)) return `http://${s}`;
  return `https://${s}`;
}

/**
 * A real Chromium page beside the thread. The agent drives this same page
 * through its browser_* tools, so a UI check runs where you can watch it.
 */
export function BrowserPanel() {
  const pendingUrl = useStore((s) => s.browserUrl);
  const picking = useStore((s) => s.picking);
  const startPick = useStore((s) => s.startPick);
  const view = useRef<WebviewElement | null>(null);
  // <webview> methods throw until its first dom-ready.
  const ready = useRef(false);
  const [address, setAddress] = useState(pendingUrl ?? "");
  const [nav, setNav] = useState({ back: false, forward: false, loading: false });
  const [initial] = useState(() => (pendingUrl ? normalize(pendingUrl) : "about:blank"));

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const sync = () => {
      if (!ready.current) return;
      const url = el.getURL();
      setAddress(url === "about:blank" ? "" : url);
      setNav({ back: el.canGoBack(), forward: el.canGoForward(), loading: false });
    };
    const onReady = () => {
      ready.current = true;
      void api().browserAttached(el.getWebContentsId());
      sync();
    };
    const onStart = () => setNav((n) => ({ ...n, loading: true }));
    el.addEventListener("dom-ready", onReady, { once: true });
    el.addEventListener("did-navigate", sync);
    el.addEventListener("did-navigate-in-page", sync);
    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", sync);
    return () => {
      el.removeEventListener("did-navigate", sync);
      el.removeEventListener("did-navigate-in-page", sync);
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-stop-loading", sync);
    };
  }, []);

  // A URL requested later (by the agent or the store) while the panel is open.
  useEffect(() => {
    // Before dom-ready the initial src already carries the URL.
    if (!pendingUrl || !view.current || !ready.current) return;
    const url = normalize(pendingUrl);
    if (view.current.getURL() !== url) void view.current.loadURL(url).catch(() => {});
  }, [pendingUrl]);

  return (
    <div className="browser">
      <form
        className="browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready.current) void view.current?.loadURL(normalize(address)).catch(() => {});
        }}
      >
        <button type="button" className="icon-button" title="Back" disabled={!nav.back} onClick={() => view.current?.goBack()}>
          <IconArrowLeft />
        </button>
        <button type="button" className="icon-button" title="Forward" disabled={!nav.forward} onClick={() => view.current?.goForward()}>
          <IconArrowRight />
        </button>
        <button type="button" className="icon-button" title="Reload" onClick={() => view.current?.reload()}>
          {nav.loading ? <span className="spinner" /> : <IconRefresh />}
        </button>
        <label className="address">
          <IconGlobe size={13} />
          <input
            value={address}
            placeholder="localhost:3000"
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <button
          type="button"
          className={`icon-button${picking ? " active" : ""}`}
          title="Pick an element to add to your message (Esc cancels)"
          onClick={() => void startPick()}
        >
          <IconTarget />
        </button>
      </form>
      <webview ref={view as unknown as React.Ref<HTMLWebViewElement>} className="browser-view" src={initial} partition="persist:unskilled-browser" />
    </div>
  );
}
