import { useCallback, useEffect, useRef, useState } from "react";
import type { WorktreeReview } from "../../../shared/types";
import { api } from "../api";
import { useStore } from "../store";
import { Select } from "./Select";

export type ReviewScope = "uncommitted" | "base";
export type ReviewBusy = "message" | "commit" | "merge" | "push" | "remove";

/** Strip Electron's IPC wrapper, the way the Learned tab does. */
function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/**
 * The first reason Merge into `target` can't run, in the order the bar should
 * say it. A target the project folder doesn't have out is merged in a
 * throwaway worktree, so only the folder's own branch cares that it's dirty.
 */
export function reviewHint(review: WorktreeReview, target: string | null, message: string): string | null {
  if (review.uncommitted > 0) return "Commit the worktree's changes first.";
  if (!target) return "Pick a branch to merge into.";
  if (review.projectDirty && target === review.projectBranch) return "The project folder has uncommitted changes.";
  if (target === review.base && review.ahead === 0) return "Nothing to merge yet.";
  if (!message.trim()) return "Write the merge commit's message, or Generate one.";
  return null;
}

/** Why Push can't run, or null when it can. */
function pushBlock(review: WorktreeReview): string | null {
  if (!review.remote) return "This project has no git remote.";
  if (review.unpushed === 0) return "Everything is pushed.";
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
  target: string | null;
  onScope(scope: ReviewScope): void;
  onMessage(text: string): void;
  onGenerate(): void;
  onCommit(): void;
  onMerge(): void;
  onMode(mode: "squash" | "merge"): void;
  onTarget(target: string): void;
  onPush(): void;
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
  target,
  onScope,
  onMessage,
  onGenerate,
  onCommit,
  onMerge,
  onMode,
  onTarget,
  onPush,
  onRemove,
}: ReviewMergeBarViewProps) {
  const hint = reviewHint(review, target, message);
  const mergeDisabled = hint !== null || busy !== null;
  const pushWhy = pushBlock(review);
  const targets = target && !review.targets.includes(target) ? [target, ...review.targets] : review.targets;

  return (
    <div className="review-bar">
      <div className="review-head">
        <span className="review-branch">{review.branch}</span>
        {review.base && <span>{`from ${review.base}`}</span>}
        <span>{`${review.ahead} commit${review.ahead === 1 ? "" : "s"} ahead`}</span>
        {review.behind > 0 && <span>{`· ${review.behind} behind`}</span>}
        {review.uncommitted > 0 && <span>{`· ${review.uncommitted} uncommitted`}</span>}
        {review.remote && review.unpushed !== null && review.unpushed > 0 && <span>{`· ${review.unpushed} unpushed`}</span>}
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
        <button
          type="button"
          className="button"
          title={pushWhy ?? `Push ${review.branch} to ${review.remote}`}
          disabled={pushWhy !== null || busy !== null}
          onClick={onPush}
        >
          {busy === "push" ? "Pushing…" : "Push"}
        </button>
      </div>
      {!merged && (
        <div className="review-merge">
          <span className="review-into">Into</span>
          <Select
            value={target ?? ""}
            options={targets.length ? targets.map((b) => ({ value: b, label: b })) : [{ value: "", label: "No branches" }]}
            onChange={onTarget}
            ariaLabel="Branch to merge into"
          />
          <div className="segmented compact" role="group" aria-label="Merge mode">
            <button type="button" className={mode === "squash" ? "on" : ""} onClick={() => onMode("squash")}>
              Squash
            </button>
            <button type="button" className={mode === "merge" ? "on" : ""} onClick={() => onMode("merge")}>
              Merge commit
            </button>
          </div>
          <button type="button" className="button primary" disabled={mergeDisabled} onClick={onMerge}>
            {busy === "merge" ? "Merging…" : "Merge"}
          </button>
        </div>
      )}
      {merged && (
        <div className="review-merge">
          {notice && <p className="review-notice">{notice}</p>}
          <button type="button" className="button" title="Delete the worktree folder; the branch stays" disabled={busy !== null} onClick={onRemove}>
            Remove worktree
          </button>
        </div>
      )}
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

/** Review and merge for a worktree thread: commits, scope, push, and the merge itself. */
export function ReviewMergeBar({
  threadId,
  refreshKey,
  onScope,
}: {
  threadId: string;
  /** Bumped by the panel's Refresh button. */
  refreshKey: number;
  onScope(scope: ReviewScope, review: WorktreeReview): void;
}) {
  const diffVersion = useStore((s) => s.diffVersion);
  const [review, setReview] = useState<WorktreeReview | null>(null);
  const [scope, setScope] = useState<ReviewScope>("uncommitted");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<ReviewBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [merged, setMerged] = useState(false);
  const [mode, setMode] = useState<"squash" | "merge">("squash");
  // null = follow the base; set once the user picks another branch.
  const [picked, setPicked] = useState<string | null>(null);
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
  useEffect(load, [load, diffVersion, refreshKey]);
  // Commit, merge, push and remove change the diff too: reload it and this bar together.
  const changed = () => useStore.setState((s) => ({ diffVersion: s.diffVersion + 1 }));

  // A new thread starts clean: no message or notice carried over.
  useEffect(() => {
    setReview(null);
    setScope("uncommitted");
    setMessage("");
    setBusy(null);
    setError(null);
    setNotice(null);
    setMerged(false);
    setPicked(null);
  }, [threadId]);

  if (!review) return null;
  const target = picked ?? review.base;

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
      // The message stays: it is the natural message for a squash merge next.
      setNotice("Committed.");
      changed();
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
      const result = await api().worktreeMerge(threadId, { mode, message, target: target ?? undefined });
      if (result.ok) {
        setMerged(true);
        setNotice(`Merged into ${target ?? "base"} (${result.sha.slice(0, 7)}).`);
        setMessage("");
        changed();
      } else {
        setError(result.reason + (result.conflicts.length ? ` Conflicts: ${result.conflicts.join(", ")}` : ""));
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const push = async () => {
    setBusy("push");
    setError(null);
    setNotice(null);
    try {
      const result = await api().worktreePush(threadId);
      setNotice(`Pushed to ${result.remote}/${result.branch}.`);
      changed();
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
      if (ok) {
        setNotice("Worktree removed; the branch stays.");
        changed();
      } else setError("The worktree has uncommitted changes, so it was kept.");
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
      target={target}
      onScope={changeScope}
      onMessage={setMessage}
      onGenerate={() => void generate()}
      onCommit={() => void commit()}
      onMerge={() => void merge()}
      onMode={(next) => {
        setMode(next);
        setError(null);
      }}
      onTarget={(next) => {
        setPicked(next);
        setError(null);
      }}
      onPush={() => void push()}
      onRemove={() => void remove()}
    />
  );
}
