import { useEffect, useRef, useState } from "react";
import type { BrowserLogEntry, DevicePreset, ScreenshotInfo } from "../../../shared/types";
import { api } from "../api";
import { IconArrowLeft, IconArrowRight, IconGlobe, IconRefresh, IconTarget } from "../icons";
import { useStore } from "../store";
import { ScreenshotStrip, ScreenshotViewer } from "./ScreenshotStrip";
import { TakeOverBanner } from "./TakeOverBanner";

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
  const takeOver = useStore((s) => s.takeOver);
  const browserInput = useStore((s) => s.browserInput);
  const stopAgent = useStore((s) => s.stopAgent);
  const resumeAgent = useStore((s) => s.resumeAgent);
  const setWatch = useStore((s) => s.setWatch);
  /** The running agent's name, for the take-over banner. */
  const agentLabel = useStore((s) => {
    const thread = s.threads[s.selectedProjectId ?? ""]?.find((t) => t.id === s.selectedThreadId);
    return s.agents.find((a) => a.id === thread?.agent)?.label ?? "this agent";
  });
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
  /** The last main-frame load that failed (nothing listening, DNS, TLS), shown instead of a blank page. */
  const [failed, setFailed] = useState<{ url: string; reason: string } | null>(null);
  /** What the page actually shows ("" = nothing yet); the address box can differ while the user types. */
  const [current, setCurrent] = useState("");

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
      setCurrent(url === "about:blank" ? "" : url);
      setNav({ back: el.canGoBack(), forward: el.canGoForward(), loading: false });
    };
    const onReady = () => {
      ready.current = true;
      void api().browserAttached(el.getWebContentsId());
      sync();
    };
    const onStart = () => {
      setFailed(null);
      setNav((n) => ({ ...n, loading: true }));
    };
    const onFail = (e: Event) => {
      const { errorCode, errorDescription, validatedURL, isMainFrame } = e as Event & {
        errorCode: number;
        errorDescription: string;
        validatedURL: string;
        isMainFrame: boolean;
      };
      // -3 is an aborted load: a newer navigation replaced it.
      if (!isMainFrame || errorCode === -3) return;
      setFailed({ url: validatedURL, reason: errorDescription });
    };
    el.addEventListener("dom-ready", onReady, { once: true });
    el.addEventListener("did-navigate", sync);
    el.addEventListener("did-navigate-in-page", sync);
    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", sync);
    el.addEventListener("did-fail-load", onFail);
    return () => {
      el.removeEventListener("did-fail-load", onFail);
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
    <div className={`browser${takeOver.mode === "agent-driving" ? " agent-driving" : ""}`} onKeyDown={(e) => { if (e.key === "Escape") browserInput(); }}>
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
            onFocus={(e) => {
              e.currentTarget.select();
              // Typing a URL pauses the agent rather than fighting it for the pointer.
              useStore.getState().browserInput();
            }}
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
          className="button ghost browser-move"
          title={browserWide ? "Back to the side panel" : "Move to main area"}
          aria-pressed={browserWide}
          onClick={toggleBrowserWide}
        >
          {browserWide ? <IconArrowRight size={14} /> : <IconArrowLeft size={14} />}
          {browserWide ? "Side panel" : "Main area"}
        </button>
      </form>
      <TakeOverBanner
        state={takeOver}
        agentLabel={agentLabel}
        picking={picking}
        onStop={() => void stopAgent()}
        onResume={resumeAgent}
        onWatch={setWatch}
      />
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
        {failed ? (
          <div className="browser-empty" role="status">
            <h3>Can't reach {failed.url}</h3>
            <p>Nothing answered there ({failed.reason}). Start your dev server, or ask the agent to.</p>
            <button type="button" className="button" onClick={() => webView.current?.reload()}>
              Retry
            </button>
          </div>
        ) : (
          !current &&
          !nav.loading && (
            <div className="browser-empty" role="status">
              <h3>Nothing open yet</h3>
              <p>Type a URL above, or ask the agent to open your app. It drives this pane with the browser tools.</p>
            </div>
          )
        )}
        {/* A <webview>'s own input never reaches this document, so this overlay is how a click in the pane is seen; in watch mode it swallows input and the reducer keeps agent-driving. */}
        {takeOver.mode === "agent-driving" && (
          <div
            className={`takeover-overlay${takeOver.watch ? " watch" : ""}`}
            tabIndex={0}
            aria-label="The agent is driving; click or type to take over"
            onPointerDown={(e) => {
              e.preventDefault();
              useStore.getState().browserInput();
            }}
            onKeyDown={(e) => {
              e.preventDefault();
              useStore.getState().browserInput();
            }}
          />
        )}
      </div>
      <div id="browser-console" role="tabpanel" className="browser-console" hidden={view !== "console"}>
        <ConsoleList logs={logs} />
      </div>
      <ScreenshotStrip shots={screenshots} onOpen={setViewing} />
      <ScreenshotViewer shot={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
