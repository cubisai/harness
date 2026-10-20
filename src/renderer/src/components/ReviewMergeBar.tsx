import { useCallback, useEffect, useRef, useState } from "react";
import type { WorktreeReview } from "../../../shared/types";
import { api } from "../api";
import { useStore } from "../store";

export type ReviewScope = "uncommitted" | "base";
export type ReviewBusy = "message" | "commit" | "merge" | "remove";

/** Strip Electron's IPC wrapper, the way the Learned tab does. */
function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** The first reason Merge can't run, in the order the bar should say it. */
export function reviewHint(review: WorktreeReview): string | null {
  if (review.uncommitted > 0) return "Commit the worktree's changes first.";
  if (review.projectDirty) return "The project folder has uncommitted changes.";
  if (review.projectBranch !== review.base) return `The project is on ${review.projectBranch ?? "a detached HEAD"}; switch it to ${review.base} to merge.`;
  if (review.ahead === 0) return "Nothing to merge yet.";
  return null;
}

export interface ReviewMergeBarViewProps {
  review: WorktreeReview;
  scope: ReviewScope;
  message: string;
  busy: ReviewBusy | null;
  error: string | null;
  notice: string | null;
  merged: boolean;
  mode: "squash" | "merge";
  onScope(scope: ReviewScope): void;
  onMessage(text: string): void;
  onGenerate(): void;
  onCommit(): void;
  onMerge(): void;
  onMode(mode: "squash" | "merge"): void;
  onRemove(): void;
}

/** The bar as a pure render, so a static test can word every state. */
export function ReviewMergeBarView({
  review,
  scope,
  message,
  busy,
  error,
  notice,
  merged,
  mode,
  onScope,
  onMessage,
  onGenerate,
  onCommit,
  onMerge,
  onMode,
  onRemove,
}: ReviewMergeBarViewProps) {
  const hint = reviewHint(review);
  const mergeDisabled =
    !review.base || review.ahead === 0 || review.uncommitted > 0 || review.projectDirty || review.projectBranch !== review.base || !message.trim() || busy !== null;
  const mergeLabel = review.base ? `Merge into ${review.base}` : "Merge";

  return (
    <div className="review-bar">
      <div className="review-head">
        <span className="review-branch">{review.branch}</span>
        {review.base && <span>{`from ${review.base}`}</span>}
        <span>{`${review.ahead} commit${review.ahead === 1 ? "" : "s"} ahead`}</span>
        {review.behind > 0 && <span>{`· ${review.behind} behind`}</span>}
        {review.uncommitted > 0 && <span>{`· ${review.uncommitted} uncommitted`}</span>}
      </div>
      <div className="segmented compact" role="group" aria-label="Changes scope">
        <button type="button" className={scope === "uncommitted" ? "on" : ""} onClick={() => onScope("uncommitted")}>
          Uncommitted
        </button>
        <button type="button" className={scope === "base" ? "on" : ""} onClick={() => onScope("base")}>
          {`Since ${review.base ?? "base"}`}
        </button>
      </div>
      <textarea
        className="review-message"
        rows={3}
        placeholder="Commit message"
        aria-label="Commit message"
        value={message}
        onChange={(e) => onMessage(e.target.value)}
      />
      <div className="review-actions">
        <button type="button" className="button" title="Write the message with AI" disabled={busy !== null} onClick={onGenerate}>
          {busy === "message" ? "Writing…" : "Generate"}
        </button>
        <button
          type="button"
          className="button"
          title={review.uncommitted === 0 ? "Nothing to commit" : undefined}
          disabled={review.uncommitted === 0 || !message.trim() || busy !== null}
          onClick={onCommit}
        >
          Commit
        </button>
        {!merged && (
          <>
            <div className="segmented compact" role="group" aria-label="Merge mode">
              <button type="button" className={mode === "squash" ? "on" : ""} onClick={() => onMode("squash")}>
                Squash
              </button>
              <button type="button" className={mode === "merge" ? "on" : ""} onClick={() => onMode("merge")}>
                Merge commit
              </button>
            </div>
            <button type="button" className="button primary" disabled={mergeDisabled} onClick={onMerge}>
              {mergeLabel}
            </button>
          </>
        )}
        {merged && (
          <>
            {notice && <p className="review-notice">{notice}</p>}
            <button type="button" className="button" title="Delete the worktree folder; the branch stays" disabled={busy !== null} onClick={onRemove}>
              Remove worktree
            </button>
          </>
        )}
      </div>
      {!merged && hint && <p className="review-hint">{hint}</p>}
      {!merged && notice && <p className="review-notice">{notice}</p>}
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Review and merge for a worktree thread: commits, scope, and the merge itself. */
export function ReviewMergeBar({ threadId, onScope }: { threadId: string; onScope(scope: ReviewScope, review: WorktreeReview): void }) {
  const diffVersion = useStore((s) => s.diffVersion);
  const [review, setReview] = useState<WorktreeReview | null>(null);
  const [scope, setScope] = useState<ReviewScope>("uncommitted");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<ReviewBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [merged, setMerged] = useState(false);
  const [mode, setMode] = useState<"squash" | "merge">("squash");
  // The open scope, so a reload after a turn refreshes the "since base" list too.
  const scopeRef = useRef<ReviewScope>("uncommitted");
  scopeRef.current = scope;
  const onScopeRef = useRef(onScope);
  onScopeRef.current = onScope;

  const load = useCallback(() => {
    void api()
      .worktreeReview(threadId)
      .then((next) => {
        setReview(next);
        if (scopeRef.current === "base") onScopeRef.current("base", next);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [threadId]);
  useEffect(load, [load, diffVersion]);

  // A new thread starts clean: no message or notice carried over.
  useEffect(() => {
    setReview(null);
    setScope("uncommitted");
    setMessage("");
    setBusy(null);
    setError(null);
    setNotice(null);
    setMerged(false);
  }, [threadId]);

  if (!review) return null;

  const changeScope = (next: ReviewScope) => {
    setScope(next);
    onScope(next, review);
  };

  const generate = async () => {
    setBusy("message");
    setError(null);
    setNotice(null);
    try {
      const result = await api().worktreeMessage(threadId);
      setMessage(result.message);
      setNotice(`Written by ${result.model}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    setBusy("commit");
    setError(null);
    setNotice(null);
    try {
      await api().worktreeCommit(threadId, message);
      setMessage("");
      setNotice("Committed.");
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const merge = async () => {
    setBusy("merge");
    setError(null);
    setNotice(null);
    try {
      const result = await api().worktreeMerge(threadId, { mode, message });
      if (result.ok) {
        setMerged(true);
        setNotice(`Merged into ${review.base ?? "base"} (${result.sha.slice(0, 7)}).`);
        setMessage("");
      } else {
        setError(result.reason + (result.conflicts.length ? ` Conflicts: ${result.conflicts.join(", ")}` : ""));
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    setError(null);
    setNotice(null);
    try {
      const ok = await api().worktreeRemove(threadId);
      if (ok) setNotice("Worktree removed; the branch stays.");
      else setError("The worktree has uncommitted changes, so it was kept.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ReviewMergeBarView
      review={review}
      scope={scope}
      message={message}
      busy={busy}
      error={error}
      notice={notice}
      merged={merged}
      mode={mode}
      onScope={changeScope}
      onMessage={setMessage}
      onGenerate={() => void generate()}
      onCommit={() => void commit()}
      onMerge={() => void merge()}
      onMode={setMode}
      onRemove={() => void remove()}
    />
  );
}
