import type { DesignChange, DesignHistoryRequest, DesignHistoryResult, DesignMutation, MutationResult } from "../../../shared/design-mutation";

/** The two calls an open page needs from the main process. */
export interface DocumentApi {
  designMutate(threadId: string, rel: string, mutation: DesignMutation): Promise<MutationResult>;
  designHistory(threadId: string, rel: string, request: DesignHistoryRequest): Promise<DesignHistoryResult>;
}

/**
 * One design page as the canvas edits it. Calls run strictly in order, so each edit is based on the revision the
 * one before it produced, and a burst of typing can't overtake itself.
 */
export class DesignDocumentClient {
  private documentId = "";
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly api: DocumentApi,
    private readonly threadId: string,
    private readonly rel: string,
    private readonly newId: () => string,
  ) {}

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async ask(request: DesignHistoryRequest): Promise<DesignHistoryResult> {
    const res = await this.api.designHistory(this.threadId, this.rel, request);
    this.documentId = res.status.documentId;
    this.revision = res.status.revision;
    return res;
  }

  /** Ask for the page's state, plus any conflicts waiting to be told. Opens it the first time, replaying its journal. */
  status(): Promise<DesignHistoryResult> {
    return this.enqueue(() => this.ask({ action: "status" }));
  }

  /** Send one edit. `transactionId` groups edits into one undo step. */
  mutate(target: DesignMutation["target"], change: DesignChange, transactionId: string): Promise<MutationResult> {
    return this.enqueue(async () => {
      if (!this.documentId) await this.ask({ action: "status" });
      const result = await this.api.designMutate(this.threadId, this.rel, {
        operationId: this.newId(),
        documentId: this.documentId,
        baseRevision: this.revision,
        target,
        transactionId,
        change,
      });
      this.revision = result.ok ? result.newRevision : result.currentRevision;
      return result;
    });
  }

  undo(crossBoundary = false): Promise<DesignHistoryResult> {
    return this.enqueue(() => this.ask(crossBoundary ? { action: "undo", crossBoundary: true } : { action: "undo" }));
  }

  redo(): Promise<DesignHistoryResult> {
    return this.enqueue(() => this.ask({ action: "redo" }));
  }

  /** Save now: before the frame reloads or the page closes, or as a retry after a failed save. */
  flush(): Promise<DesignHistoryResult> {
    return this.enqueue(() => this.ask({ action: "flush" }));
  }
}
