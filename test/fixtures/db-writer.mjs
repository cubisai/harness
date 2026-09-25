// Worker used by db.test.ts to prove seq allocation is atomic across connections.
import { workerData, parentPort } from "node:worker_threads";

const { Store } = await import(workerData.dbPath);
const store = new Store(workerData.file);
try {
  for (let i = 0; i < workerData.count; i++) {
    store.appendEvent(workerData.threadId, { kind: "notice", text: `w${workerData.worker}-${i}` });
  }
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err?.stack ?? err) });
} finally {
  store.close();
}
