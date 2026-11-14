import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesignChange, DesignHistoryResult, DesignMutation, DocumentStatus, MutationConflict, MutationResult } from "../../../shared/design-mutation";
import { api } from "../api";
import { useStore } from "../store";
import { DesignDocumentClient } from "./document-client";

/** What the bar above the stage is asking about. */
export type EditBanner =
  /** An edit couldn't land. `retry` is what `Reapply on latest` sends; without it the edit can only be let go. */
  | { kind: "conflict"; text: string; retry: { target: DesignMutation["target"]; change: DesignChange } | null }
  /** The next undo would go back past a change made outside the editor. */
  | { kind: "boundary" };

/** The bar's wording for edits a disk change or a relaunch could not carry over. */
export function conflictsText(list: MutationConflict[]): string {
  const n = list.length;
  return `This file changed outside the editor. ${n === 1 ? "Your last edit was" : `${n} of your edits were`} not applied.`;
}

const newId = (): string => crypto.randomUUID();

/** How long a run of edits to one control stays one undo step, and how often a drag writes. */
const GROUP_MS = 500;
const WRITE_MS = 80;

/**
 * Direct editing of one open page (Design v2): edits go to the mutation service in order, a refusal becomes the
 * banner, and undo, redo and structural edits bring the frame to the new text in place (`patchFrame`, from the text
 * the frame showed before), so they don't flash. The frame already shows a plain edit, so nothing else touches it.
 * `reloadFrame` is for when the frame shows something the file doesn't have. Does nothing while `on` is false.
 */
export function useDesignEditing({
  threadId,
  rel,
  on,
  onStamp,
  reloadFrame,
  patchFrame,
  onText,
  notify,
  onHistory,
}: {
  threadId: string;
  rel: string | null;
  on: boolean;
  /** The service stamped an id on an element found by its place: the frame's copy takes it too. */
  onStamp: (path: number[], id: string) => void;
  reloadFrame: () => void;
  /** Bring the frame from `base` (the text it shows) to `html` in place; it reloads itself if it can't. */
  patchFrame?: (base: string, html: string) => void;
  /** The page's text after the frame's own edits landed: what the frame now shows. */
  onText?: (html: string) => void;
  notify: (text: string, error?: boolean) => void;
  /** An undo or redo is starting. */
  onHistory?: () => void;
}) {
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [local, setLocal] = useState<DocumentStatus | null>(null);
  const [banner, setBanner] = useState<EditBanner | null>(null);
  const pushed = useStore((s) => (documentId ? s.designDocuments[documentId] : undefined));
  const status = pushed?.status ?? local;

  const client = useMemo(() => (on && rel ? new DesignDocumentClient(api(), threadId, rel, newId) : null), [on, threadId, rel]);
  const callbacks = useRef({ onStamp, reloadFrame, patchFrame, onText, notify, onHistory });
  callbacks.current = { onStamp, reloadFrame, patchFrame, onText, notify, onHistory };
  /** Moves the frame from `base` to `html`: in place when the canvas can, else a reload. */
  const toText = useCallback((base: string | null, html: string | null) => {
    const patchFrame = callbacks.current.patchFrame;
    if (patchFrame && base !== null && html !== null) patchFrame(base, html);
    else callbacks.current.reloadFrame();
  }, []);

  const showConflicts = useCallback((res: DesignHistoryResult) => {
    setDocumentId(res.status.documentId);
    setLocal(res.status);
    if (res.recovered) callbacks.current.notify(`Recovered ${res.recovered === 1 ? "1 unsaved edit" : `${res.recovered} unsaved edits`} from when the app last closed.`);
    if (res.conflicts.length) setBanner({ kind: "conflict", text: conflictsText(res.conflicts), retry: null });
    if (res.conflicts.length || res.recovered) callbacks.current.reloadFrame();
  }, []);

  // Opening the page replays its journal, so a crash's edits are back before the first edit, and conflicts surface here.
  useEffect(() => {
    setBanner(null);
    setLocal(null);
    setDocumentId(null);
    if (!client) return;
    let live = true;
    void client
      .status()
      .then((res) => live && showConflicts(res))
      .catch((err: unknown) => {
        const text = err instanceof Error ? err.message : String(err);
        // The page went away (the agent deleted a helper page): the canvas is already asking which page to show.
        if (live && !/No such page/.test(text)) callbacks.current.notify(text, true);
      });
    return () => {
      live = false;
    };
  }, [client, showConflicts]);

  // The main process says conflicts wait: ask for them (they are handed out once).
  const conflictCount = pushed?.conflicts ?? 0;
  useEffect(() => {
    if (client && conflictCount > 0) void client.status().then(showConflicts).catch(() => undefined);
  }, [client, conflictCount, showConflicts]);

  // After a run of plain edits, what the frame shows is the page's text: told once the run settles.
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textSoon = useRef<() => void>(() => {});
  const handle = useCallback((result: MutationResult, target: DesignMutation["target"], change: DesignChange) => {
    if (result.ok) {
      if (result.stampedId && "locator" in target) callbacks.current.onStamp(target.locator.path, result.stampedId);
      textSoon.current();
      return;
    }
    if (result.reason === "read-only") {
      callbacks.current.notify("The agent is working on this page. Your edit wasn't kept; edit it when the turn ends.");
      callbacks.current.reloadFrame();
    } else if (result.reason === "invalid") {
      callbacks.current.notify(result.message ?? "That edit can't be made here.", true);
      callbacks.current.reloadFrame();
    } else {
      setBanner({ kind: "conflict", text: conflictsText([{ operationId: result.operationId, message: result.message ?? "" }]), retry: { target, change } });
    }
  }, []);

  // The frame just loaded the file as it is now, so the next edit is based on that. Without this, the first edit after an
  // agent's turn or any outside write would be refused as stale, though the user is looking at the latest page.
  // `onText` hears the page's text, which the canvas checks against what the frame loaded.
  const sync = useCallback(
    (onText?: (html: string) => void) => {
      if (!client) return;
      void client
        .status()
        .then((res) => {
          showConflicts(res);
          onText?.(res.html);
        })
        .catch(() => undefined);
    },
    [client, showConflicts],
  );

  textSoon.current = () => {
    if (!client || !callbacks.current.onText) return;
    if (textTimer.current) clearTimeout(textTimer.current);
    textTimer.current = setTimeout(() => {
      textTimer.current = null;
      void client
        .status()
        .then((res) => {
          showConflicts(res);
          callbacks.current.onText?.(res.html);
        })
        .catch(() => undefined);
    }, 150);
  };
  useEffect(
    () => () => {
      if (textTimer.current) clearTimeout(textTimer.current);
    },
    [client],
  );

  // One undo step per control: edits to the same key within GROUP_MS share a transaction.
  const groups = useRef(new Map<string, { id: string; at: number }>());
  const transactionFor = useCallback((key: string | null): string => {
    if (key === null) return newId();
    const now = Date.now();
    const prior = groups.current.get(key);
    const id = prior && now - prior.at < GROUP_MS ? prior.id : newId();
    groups.current.set(key, { id, at: now });
    return id;
  }, []);

  const send = useCallback(
    (target: DesignMutation["target"], change: DesignChange, key: string | null) => {
      if (!client) return;
      client
        .mutate(target, change, transactionFor(key))
        .then((result) => handle(result, target, change))
        .catch((err: unknown) => {
          callbacks.current.notify(err instanceof Error ? err.message : String(err), true);
          callbacks.current.reloadFrame();
        });
    },
    [client, handle, transactionFor],
  );

  /**
   * Several edits as one undo step, each based on the one before; the frame is patched to the result after, since the
   * page's structure changed. `steps` gets a function that sends one edit and returns its result, or throws when it's refused.
   */
  const transaction = useCallback(
    async <T,>(steps: (step: (target: DesignMutation["target"], change: DesignChange) => Promise<Extract<MutationResult, { ok: true }>>) => Promise<T>): Promise<T | null> => {
      if (!client) return null;
      await flushWaiting.current();
      // The text the frame shows now, so the result can be patched in rather than reloaded.
      const before = await client.status().then(
        (r) => {
          showConflicts(r);
          return r.html;
        },
        () => null,
      );
      const id = newId();
      let refused = false;
      try {
        return await steps(async (target, change) => {
          const result = await client.mutate(target, change, id);
          handle(result, target, change);
          if (!result.ok) {
            refused = true;
            throw new Error(result.message ?? "That edit can't be made here.");
          }
          return result;
        });
      } catch (err) {
        if (!refused) callbacks.current.notify(err instanceof Error ? err.message : String(err), true);
        return null;
      } finally {
        // Saved first: a reload, if the patch can't be made, reads the file.
        const after = await client.flush().then((r) => r.html, () => null);
        toText(before, after);
      }
    },
    [client, handle, showConflicts, toText],
  );

  // A drag writes at most every WRITE_MS, always ending on its last value.
  const waiting = useRef(new Map<string, { target: DesignMutation["target"]; change: DesignChange; timer: ReturnType<typeof setTimeout> }>());
  const sendWaiting = useCallback(() => {
    for (const [key, w] of waiting.current) {
      clearTimeout(w.timer);
      send(w.target, w.change, key);
    }
    waiting.current.clear();
  }, [send]);
  const sendSoon = useCallback(
    (key: string, target: DesignMutation["target"], change: DesignChange) => {
      const prior = waiting.current.get(key);
      if (prior) clearTimeout(prior.timer);
      const timer = setTimeout(() => {
        waiting.current.delete(key);
        send(target, change, key);
      }, WRITE_MS);
      waiting.current.set(key, { target, change, timer });
    },
    [send],
  );

  const flushWaiting = useRef<() => Promise<void>>(async () => {});
  flushWaiting.current = async () => sendWaiting();
  const flush = useCallback(async () => {
    sendWaiting();
    await client?.flush().catch(() => undefined);
  }, [client, sendWaiting]);

  const history = useCallback(
    async (run: (c: DesignDocumentClient) => Promise<DesignHistoryResult>) => {
      if (!client) return;
      sendWaiting();
      try {
        // Queued behind the edits just sent, so this is the text the frame shows.
        const before = await client.status().then(
        (r) => {
          showConflicts(r);
          return r.html;
        },
        () => null,
      );
        const res = await run(client);
        showConflicts(res);
        const r = res.result;
        if (r?.ok) toText(before, res.html);
        else if (r?.reason === "external-change") setBanner({ kind: "boundary" });
        else if (r?.reason === "read-only") callbacks.current.notify("The agent is working on this page. Undo when the turn ends.");
      } catch (err) {
        callbacks.current.notify(err instanceof Error ? err.message : String(err), true);
      }
    },
    [client, sendWaiting, showConflicts, toText],
  );
  const undo = useCallback(() => {
    callbacks.current.onHistory?.();
    void history((c) => c.undo());
  }, [history]);
  const redo = useCallback(() => {
    callbacks.current.onHistory?.();
    void history((c) => c.redo());
  }, [history]);

  const dismiss = useCallback(() => setBanner(null), []);
  const undoPastBoundary = useCallback(() => {
    setBanner(null);
    void history((c) => c.undo(true));
  }, [history]);
  /** Let the refused edit go: the frame goes back to the file. */
  const discard = useCallback(() => {
    setBanner(null);
    callbacks.current.reloadFrame();
  }, []);
  /** Send the refused edit again, on the page as it is now. */
  const reapply = useCallback(() => {
    if (banner?.kind !== "conflict" || !banner.retry || !client) return;
    const { target, change } = banner.retry;
    setBanner(null);
    client
      .mutate(target, change, newId())
      .then((result) => {
        handle(result, target, change);
        callbacks.current.reloadFrame();
      })
      .catch((err: unknown) => callbacks.current.notify(err instanceof Error ? err.message : String(err), true));
  }, [banner, client, handle]);

  // Saved before anything else reads the file: leaving the page, or the app losing focus.
  useEffect(() => {
    if (!client) return;
    const onBlur = () => void flush();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      void flush();
    };
  }, [client, flush]);

  return { status, banner, sync, send, sendSoon, transaction, undo, redo, flush, dismiss, undoPastBoundary, discard, reapply };
}
