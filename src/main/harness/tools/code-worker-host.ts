import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { commitScriptState, type CodeToolOptions, type ShownWidget } from "./code";

type BrokerResult = Awaited<ReturnType<CodeToolOptions["broker"]>>;
type Result = { text: string; isError?: boolean };
export interface ScriptJob {
  id: string; callId: string; code: string; tools: ReturnType<CodeToolOptions["tools"]>;
  state: [string, string][]; outputDir: string; show: boolean; timeoutMs: number; memoryBytes: number;
}
export type WorkerRequest = { id: string } & (
  | { type: "call"; seq: number; name: string; args: Record<string, unknown> }
  | { type: "done"; result: Result; writes: [string, string][]; widgets: ShownWidget[] }
);
export type WorkerReply = { id: string; seq: number; result: BrokerResult };

/** One worker/port per invocation. Main owns permissions, effects and the only live state map. */
export async function runCodeWorker(file: string, o: CodeToolOptions, code: string, call: { id: string; signal: AbortSignal }, timeoutMs: number, memoryBytes: number): Promise<Result> {
  const job: ScriptJob = { id: randomUUID(), callId: call.id, code, state: [...(o.state ?? [])],
    tools: o.tools().map(({ definition, access, returns }) => ({ definition, access, returns })),
    outputDir: o.outputDir, show: Boolean(o.show), timeoutMs, memoryBytes };
  const controller = new AbortController();
  const stopped = { text: "Interrupted by the user.", isError: true };
  if (call.signal.aborted) return stopped;
  const worker = new Worker(file, { workerData: job });
  return new Promise<Result>((resolve) => {
    const finish = (result: Result) => {
      if (controller.signal.aborted) return;
      controller.abort();
      clearTimeout(timer);
      call.signal.removeEventListener("abort", abort);
      void worker.terminate();
      resolve(result);
    };
    const abort = () => finish(stopped);
    const timer = setTimeout(() => finish({ text: "Stopped: the script time limit was reached.", isError: true }), timeoutMs);
    call.signal.addEventListener("abort", abort, { once: true });
    worker.on("error", (err) => finish({ text: String(err), isError: true }));
    worker.on("exit", (n) => finish({ text: `Script worker exited (${n}).`, isError: true }));
    worker.on("message", async (message: WorkerRequest) => {
      if (controller.signal.aborted || message.id !== job.id) return;
      try {
        if (message.type === "call") {
          const result = await o.broker(message.name, message.args, job.callId, controller.signal);
          if (!controller.signal.aborted) worker.postMessage({ id: job.id, seq: message.seq, result } satisfies WorkerReply);
        } else {
          if (!message.result.isError) {
            if (o.beforePublish) await o.beforePublish(message.widgets.length > 0);
            if (controller.signal.aborted) return;
            if (o.state && message.writes.length) commitScriptState(o.state, message.writes);
            if (message.widgets.length) await o.show?.(message.widgets, job.callId);
          }
          finish(message.result);
        }
      } catch (err) { finish({ text: err instanceof Error ? err.message : String(err), isError: true }); }
    });
  });
}
