import { BrowserWindow } from "electron";
import type { CheckWindow } from "./check";
import { APP_SCHEME } from "./serve";

/**
 * The app check's hidden window: off screen, sandboxed, no preload or node, default session (where `cubiq-app://`
 * is served with its no-network CSP). It can't navigate away or open windows.
 */
export function electronCheckWindow(width: number, height: number): CheckWindow {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  wc.setFrameRate(30);
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  const guard = (e: { preventDefault(): void }, url: string): void => {
    if (!url.startsWith(`${APP_SCHEME}://`)) e.preventDefault();
  };
  wc.on("will-navigate", (e) => guard(e, e.url));
  wc.on("will-redirect", (e) => guard(e, e.url));
  wc.on("will-frame-navigate", (e) => guard(e, e.url));

  return {
    load: (url) => wc.loadURL(url),
    evaluate: (script) => wc.executeJavaScript(script, true),
    evaluateApp: async (script) => {
      const frame = wc.mainFrame.frames.find((f) => f.url.startsWith(`${APP_SCHEME}://a/`));
      return frame ? frame.executeJavaScript(script, true) : null;
    },
    capture: async (w, h) => {
      let image = await wc.capturePage();
      const size = image.getSize();
      if (size.width !== w || size.height !== h) image = image.resize({ width: w, height: h, quality: "best" });
      return image.toPNG();
    },
    destroy: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
