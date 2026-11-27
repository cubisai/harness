import { parentPort, workerData } from "node:worker_threads";
import { createCodeTool, type ShownWidget } from "./code";
import type { ScriptJob, WorkerReply, WorkerRequest } from "./code-worker-host";

const port = parentPort!;
const job: ScriptJob = workerData;
const send = (message: WorkerRequest) => port.postMessage(message);
const replies = new Map<number, (result: WorkerReply["result"]) => void>();
let seq = 0;
port.on("message", (reply: WorkerReply) => {
  if (reply.id !== job.id) return;
  replies.get(reply.seq)?.(reply.result);
  replies.delete(reply.seq);
});
let writes: [string, string][] = [], widgets: ShownWidget[] = [];
const tool = createCodeTool({
  ...job, tools: () => job.tools, state: new Map(job.state), onCommit: (changes) => { writes = changes; },
  show: job.show ? (shown) => { widgets = shown; } : undefined,
  broker: (name, args) => new Promise((resolve) => {
    replies.set(++seq, resolve);
    send({ type: "call", id: job.id, seq, name, args });
  }),
});
const result = await tool.run({ code: job.code }, { id: job.callId, signal: new AbortController().signal, onOutput: () => {} });
send({ type: "done", id: job.id, result, writes, widgets });
