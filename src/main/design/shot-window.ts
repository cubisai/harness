import { BrowserWindow } from "electron";
import { DOC_SCHEME } from "../documents/serve";
import { DESIGN_SCHEME } from "./serve";
import type { ShotWindow } from "./shooter";

/**
 * The shooter's hidden window: off-screen rendering, sandboxed, no preload or
 * node, default session (where `cubiq-design://` and `cubiq-doc://` are served
 * with their no-network CSPs). It can't navigate away or open windows.
 */
export function electronShotWindow(): ShotWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  wc.setFrameRate(30);
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  const guard = (e: { preventDefault(): void }, url: string): void => {
    if (!url.startsWith(`${DESIGN_SCHEME}://`) && !url.startsWith(`${DOC_SCHEME}://`)) e.preventDefault();
  };
  wc.on("will-navigate", (e) => guard(e, e.url));
  wc.on("will-redirect", (e) => guard(e, e.url));

  return {
    setContentSize: (width, height) => win.setContentSize(width, height),
    load: (url) => wc.loadURL(url),
    evaluate: (script) => wc.executeJavaScript(script, true),
    capture: async (width, height) => {
      let image = await wc.capturePage();
      const size = image.getSize();
      // Retina screens capture at 2x: return CSS pixels, so the image is what the tool asked for.
      if (size.width !== width || size.height !== height) image = image.resize({ width, height, quality: "best" });
      return image.toPNG();
    },
    pdf: () => wc.printToPDF({ printBackground: true, preferCSSPageSize: true }),
    destroy: () => win.destroy(),
    isDestroyed: () => win.isDestroyed(),
  };
}
