import { promises as fs } from "node:fs";
import { renderOffice } from "./office";

/** Requests the main-side PreviewHost sends; the answer echoes the same id. */
type PreviewRequest = { id: number; path: string; maxBytes: number };

// Electron's utility process entry API; typed locally so this module stays electron-free for tests.
const port = (process as unknown as { parentPort: { on(e: "message", f: (m: { data: unknown }) => void): void; postMessage(v: unknown): void } }).parentPort;

/** Handle one request; never let a throw escape the message handler. */
async function handle(message: unknown): Promise<void> {
  const request = message as Partial<PreviewRequest> | null;
  const id = typeof request?.id === "number" ? request.id : -1;
  try {
    const path = request?.path;
    const maxBytes = request?.maxBytes;
    if (typeof path !== "string" || typeof maxBytes !== "number") throw new Error("Malformed preview request");
    const stat = await fs.stat(path);
    if (stat.size > maxBytes) {
      port.postMessage({ id, ok: false, error: `File is larger than ${Math.round(maxBytes / (1024 * 1024))} MB` });
      return;
    }
    const result = await renderOffice(await fs.readFile(path), path);
    port.postMessage({ id, ok: true, result });
  } catch (err) {
    port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

port.on("message", (message) => {
  void handle(message.data);
});
