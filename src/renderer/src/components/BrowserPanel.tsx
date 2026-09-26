import { useEffect, useRef, useState } from "react";
import type { BrowserLogEntry, DevicePreset, ScreenshotInfo } from "../../../shared/types";
import { api } from "../api";
import { IconArrowLeft, IconArrowRight, IconGlobe, IconRefresh, IconTarget } from "../icons";
import { useStore } from "../store";
import { ScreenshotStrip, ScreenshotViewer } from "./ScreenshotStrip";

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

const DEVICES: { id: DevicePreset; label: string; title: string }[] = [
  { id: "mobile", label: "Mobile", title: "Emulate a 390px phone" },
  { id: "tablet", label: "Tablet", title: "Emulate a 768px tablet" },
  { id: "desktop", label: "Desktop", title: "No emulation" },
];

/** What the page has thrown at us: console errors, warnings, failed requests. */
export function ConsoleList({ logs }: { logs: BrowserLogEntry[] }) {
  if (!logs.length) {
    return <div>No console errors, warnings, or failed requests since the page loaded.</div>;
  }
  return (
    <ul>
      {logs.map((l, i) => (
        <li key={i} className={`log ${l.level}`}>
          <span className="log-level">{l.level}</span> <span className="log-text">{l.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A real Chromium page beside the thread. The agent drives this same page
 * through its browser_* tools, so a UI check runs where you can watch it.
 */
export function BrowserPanel() {
  const pendingUrl = useStore((s) => s.browserUrl);
  const picking = useStore((s) => s.picking);
  const startPick = useStore((s) => s.startPick);
  const device = useStore((s) => s.browser.device);
  const logs = useStore((s) => s.browser.logs);
  const screenshots = useStore((s) => s.browser.screenshots);
  const browserWide = useStore((s) => s.paneLayout.browserWide);
  const setBrowserDevice = useStore((s) => s.setBrowserDevice);
  const toggleBrowserWide = useStore((s) => s.toggleBrowserWide);
  const webView = useRef<WebviewElement | null>(null);
  // <webview> methods throw until its first dom-ready.
  const ready = useRef(false);
  const [address, setAddress] = useState(pendingUrl ?? "");
  const [nav, setNav] = useState({ back: false, forward: false, loading: false });
  const [initial] = useState(() => (pendingUrl ? normalize(pendingUrl) : "about:blank"));
  const [view, setView] = useState<"page" | "console">("page");
  const [viewing, setViewing] = useState<ScreenshotInfo | null>(null);

  // The in-band state is fetched once, when the panel mounts.
  useEffect(() => {
    void useStore.getState().loadBrowserState();
  }, []);

  useEffect(() => {
    const el = webView.current;
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
    if (!pendingUrl || !webView.current || !ready.current) return;
    const url = normalize(pendingUrl);
    if (webView.current.getURL() !== url) void webView.current.loadURL(url).catch(() => {});
  }, [pendingUrl]);

  return (
    <div className="browser">
      <form
        className="browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready.current) void webView.current?.loadURL(normalize(address)).catch(() => {});
        }}
      >
        <button type="button" className="icon-button" title="Back" disabled={!nav.back} onClick={() => webView.current?.goBack()}>
          <IconArrowLeft />
        </button>
        <button type="button" className="icon-button" title="Forward" disabled={!nav.forward} onClick={() => webView.current?.goForward()}>
          <IconArrowRight />
        </button>
        <button type="button" className="icon-button" title="Reload" onClick={() => webView.current?.reload()}>
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
        <div className="segmented device-switch" role="group" aria-label="Viewport">
          {DEVICES.map((d) => (
            <button
              key={d.id}
              type="button"
              aria-pressed={device === d.id}
              className={device === d.id ? "on" : ""}
              title={d.title}
              onClick={() => void setBrowserDevice(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-button"
          title={browserWide ? "Back to the side panel" : "Move to main area"}
          aria-pressed={browserWide}
          onClick={toggleBrowserWide}
        >
          {browserWide ? <IconArrowRight /> : <IconArrowLeft />}
        </button>
      </form>
      <div className="segmented browser-views" role="tablist">
        <button type="button" role="tab" aria-selected={view === "page"} aria-controls="browser-page" className={view === "page" ? "on" : ""} onClick={() => setView("page")}>
          Page
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "console"}
          aria-controls="browser-console"
          className={view === "console" ? "on" : ""}
          onClick={() => setView("console")}
        >
          {`Console${logs.length ? ` (${logs.length})` : ""}`}
        </button>
      </div>
      {/* The page stays mounted in both views: unmounting it would lose it. */}
      <div id="browser-page" role="tabpanel" className="browser-page" hidden={view !== "page"}>
        <webview ref={webView as unknown as React.Ref<HTMLWebViewElement>} className="browser-view" src={initial} partition="persist:unskilled-browser" />
      </div>
      <div id="browser-console" role="tabpanel" className="browser-console" hidden={view !== "console"}>
        <ConsoleList logs={logs} />
      </div>
      <ScreenshotStrip shots={screenshots} onOpen={setViewing} />
      <ScreenshotViewer shot={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
