import { useCallback, useEffect, useRef, useState } from "react";
import type { FolderGit, WorktreeReview } from "../../../shared/types";
import { api } from "../api";
import { IconBranch, IconCheck } from "../icons";
import { useStore } from "../store";
import { Select } from "./Select";

export type ReviewScope = "uncommitted" | "base";
export type ReviewBusy = "message" | "commit" | "merge" | "push" | "remove";
/** A worktree thread's way home: commit its work, merge the branch, then remove the folder. */
export type GitStep = "commit" | "merge" | "cleanup";

const STEPS: GitStep[] = ["commit", "merge", "cleanup"];

/** Strip Electron's IPC wrapper, the way the Learned tab does. */
function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** The step a worktree thread is on: uncommitted work first, then a merge, then clean up. */
export function currentStep(review: WorktreeReview): GitStep {
  if (review.uncommitted > 0) return "commit";
  if (review.merged?.upToDate) return "cleanup";
  if (review.ahead > 0) return "merge";
  return "commit";
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
  if (review.merged?.upToDate && review.merged.into === target) return `Already merged into ${target}: no new commits since.`;
  if (target === review.base && review.ahead === 0) return "Nothing to merge yet.";
  if (!message.trim()) return "Write the merge commit's message, or Generate one.";
  return null;
}

/** Why Push can't run, or null when it can. */
function pushBlock(folder: FolderGit): string | null {
  if (!folder.remote) return "This project has no git remote.";
  if (!folder.branch) return "The project is on a detached HEAD.";
  if (folder.unpushed === 0) return "Everything is pushed.";
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface ReviewMergeBarViewProps {
  folder: FolderGit;
  /** The worktree's branch review; null for a thread working in the project folder. */
  review: WorktreeReview | null;
  /** The step whose controls are open (the current one unless the user opened another). */
  open: GitStep;
  scope: ReviewScope;
  message: string;
  busy: ReviewBusy | null;
  error: string | null;
  notice: string | null;
  mode: "squash" | "merge";
  target: string | null;
  onOpen(step: GitStep): void;
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
export function ReviewMergeBarView(p: ReviewMergeBarViewProps) {
  const { folder, review, busy } = p;
  const pushWhy = pushBlock(folder);
  const commitWhy = folder.uncommitted === 0 ? "Nothing to commit." : !p.message.trim() ? "Write a message, or Generate one." : null;

  const commitBox = (
    <div className="git-box">
      <textarea
        className="review-message"
        rows={3}
        placeholder="Commit message"
        aria-label="Commit message"
        value={p.message}
        onChange={(e) => p.onMessage(e.target.value)}
      />
      <div className="git-actions">
        <button type="button" className="button ghost" title="Write the message with AI" disabled={busy !== null} onClick={p.onGenerate}>
          {busy === "message" ? "Writing…" : "Generate"}
        </button>
        <button type="button" className="button primary" title={commitWhy ?? undefined} disabled={commitWhy !== null || busy !== null} onClick={p.onCommit}>
          {busy === "commit" ? "Committing…" : "Commit"}
        </button>
      </div>
      {folder.uncommitted > 0 && commitWhy && <p className="review-hint">{commitWhy}</p>}
    </div>
  );

  // Push lives on the strip: it is about the branch, whichever step is open.
  const push = !folder.remote || !folder.branch ? null : folder.unpushed === 0 ? (
    <span className="git-pushed" title={`Everything is pushed to ${folder.remote}`}>
      <IconCheck /> Pushed
    </span>
  ) : (
    <button type="button" className="button git-push" title={pushWhy ?? `Push ${folder.branch} to ${folder.remote}`} disabled={pushWhy !== null || busy !== null} onClick={p.onPush}>
      {busy === "push" ? "Pushing…" : folder.unpushed ? `Push ${folder.unpushed}` : "Push"}
    </button>
  );

  const facts: string[] = [];
  if (review) {
    if (review.ahead > 0) facts.push(`${plural(review.ahead, "commit")} ahead`);
    if (review.behind > 0) facts.push(`${review.behind} behind`);
  }
  // A worktree's step 1 already counts its uncommitted files.
  else if (folder.uncommitted > 0) facts.push(`${plural(folder.uncommitted, "file")} not committed`);

  return (
    <div className="review-bar git-bar">
      <div className="git-where">
        <span className="git-where-icon">
          <IconBranch />
        </span>
        <span className="review-branch" title={folder.branch ?? "Detached HEAD"}>
          {folder.branch ?? "detached HEAD"}
        </span>
        <span className="git-place">{folder.worktree ? `own worktree${review?.base ? ` · from ${review.base}` : ""}` : "project folder"}</span>
        <span className="git-where-end">{push}</span>
      </div>
      {facts.length > 0 && <div className="git-facts">{facts.join(" · ")}</div>}

      {review ? (
        <ol className="git-steps">
          {STEPS.map((step, i) => {
            const now = currentStep(review);
            const state = step === now ? "now" : STEPS.indexOf(step) < STEPS.indexOf(now) ? "done" : "next";
            const isOpen = step === p.open;
            const target = p.target ?? review.base ?? "base";
            const title = step === "commit" ? "Commit" : step === "merge" ? `Merge into ${target}` : "Clean up";
            const summary =
              step === "commit"
                ? folder.uncommitted > 0
                  ? `${plural(folder.uncommitted, "file")} to commit`
                  : review.ahead > 0
                    ? "All committed"
                    : "No changes yet"
                : step === "merge"
                  ? review.merged
                    ? review.merged.upToDate
                      ? `Merged into ${review.merged.into}`
                      : `Merged into ${review.merged.into} · new commits since`
                    : review.ahead > 0
                      ? `${plural(review.ahead, "commit")} to merge`
                      : "Nothing to merge yet"
                  : "Remove the worktree folder; the branch stays";
            return (
              <li key={step} className={`git-step ${state}${isOpen ? " open" : ""}`}>
                <button type="button" className="git-step-head" aria-expanded={isOpen} onClick={() => p.onOpen(step)}>
                  <span className="git-step-mark">{state === "done" ? <IconCheck /> : i + 1}</span>
                  <span className="git-step-title">{title}</span>
                  {!(isOpen && step === "cleanup") && <span className="git-step-summary">{summary}</span>}
                </button>
                {isOpen && step === "commit" && (folder.uncommitted > 0 ? commitBox : <p className="review-hint git-step-body">{review.ahead > 0 ? "Everything is committed." : `Started from ${review.base ?? "the project"}; edits in the project folder that weren't committed aren't here.`}</p>)}
                {isOpen && step === "merge" && <MergeBox {...p} review={review} />}
                {isOpen && step === "cleanup" && (
                  <div className="git-box">
                    <p className="review-hint">{review.merged ? `Merged into ${review.merged.into}. ` : ""}Removing the worktree deletes its folder; the branch and its commits stay.</p>
                    <div className="git-actions">
                      <button type="button" className="button" disabled={busy !== null || folder.uncommitted > 0} title={folder.uncommitted > 0 ? "Commit or discard its changes first" : undefined} onClick={p.onRemove}>
                        {busy === "remove" ? "Removing…" : "Remove worktree"}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        folder.uncommitted > 0 && commitBox
      )}

      {p.notice && <p className="review-notice">{p.notice}</p>}
      {p.error && (
        <p className="review-error" role="alert">
          {p.error}
        </p>
      )}

      {review && (
        <div className="segmented compact git-scope" role="group" aria-label="Changes scope">
          <button type="button" className={p.scope === "uncommitted" ? "on" : ""} title="Changes not committed yet" onClick={() => p.onScope("uncommitted")}>
            Not committed
          </button>
          <button type="button" className={p.scope === "base" ? "on" : ""} title={`Everything on this branch since it left ${review.base ?? "its base"}, committed or not`} onClick={() => p.onScope("base")}>
            Whole branch
          </button>
        </div>
      )}
    </div>
  );
}

function MergeBox(p: ReviewMergeBarViewProps & { review: WorktreeReview }) {
  const { review, busy } = p;
  const hint = reviewHint(review, p.target, p.message);
  const targets = p.target && !review.targets.includes(p.target) ? [p.target, ...review.targets] : review.targets;
  return (
    <div className="git-box">
      <div className="review-merge">
        <span className="review-into">Into</span>
        <Select
          value={p.target ?? ""}
          options={targets.length ? targets.map((b) => ({ value: b, label: b })) : [{ value: "", label: "No branches" }]}
          onChange={p.onTarget}
          ariaLabel="Branch to merge into"
        />
        <span className="review-into">as</span>
        <Select
          value={p.mode}
          options={[
            { value: "squash" as const, label: "One squashed commit" },
            { value: "merge" as const, label: "Merge commit" },
          ]}
          onChange={p.onMode}
          ariaLabel="Merge mode"
        />
      </div>
      <textarea
        className="review-message"
        rows={3}
        placeholder="Merge commit message"
        aria-label="Merge commit message"
        value={p.message}
        onChange={(e) => p.onMessage(e.target.value)}
      />
      <div className="git-actions">
        <button type="button" className="button ghost" title="Write the message with AI" disabled={busy !== null} onClick={p.onGenerate}>
          {busy === "message" ? "Writing…" : "Generate"}
        </button>
        <button type="button" className="button primary" disabled={hint !== null || busy !== null} onClick={p.onMerge}>
          {busy === "merge" ? "Merging…" : "Merge"}
        </button>
      </div>
      {hint && <p className="review-hint">{hint}</p>}
    </div>
  );
}

/**
 * Commit and push for every thread in a git folder; a worktree thread also
 * gets its steps home: commit, merge into its base, remove the folder.
 */
export function ReviewMergeBar({
  threadId,
  worktree,
  refreshKey,
  onScope,
}: {
  threadId: string;
  /** The thread has its own worktree (and so a branch to review and merge). */
  worktree: boolean;
  /** Bumped by the panel's Refresh button. */
  refreshKey: number;
  onScope(scope: ReviewScope, review: WorktreeReview): void;
}) {
  const diffVersion = useStore((s) => s.diffVersion);
  const [folder, setFolder] = useState<FolderGit | null>(null);
  const [review, setReview] = useState<WorktreeReview | null>(null);
  const [scope, setScope] = useState<ReviewScope>("uncommitted");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<ReviewBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<"squash" | "merge">("squash");
  // null = follow the base; set once the user picks another branch.
  const [picked, setPicked] = useState<string | null>(null);
  // null = the current step is open; set when the user opens another one.
  const [opened, setOpened] = useState<GitStep | null>(null);
  // The open scope, so a reload after a turn refreshes the "whole branch" list too.
  const scopeRef = useRef<ReviewScope>("uncommitted");
  scopeRef.current = scope;
  const onScopeRef = useRef(onScope);
  onScopeRef.current = onScope;

  const load = useCallback(() => {
    let current = true;
    void Promise.all([api().gitFolder(threadId), worktree ? api().worktreeReview(threadId) : Promise.resolve(null)])
      .then(([nextFolder, nextReview]) => {
        if (!current) return;
        setFolder(nextFolder);
        setReview(nextReview);
        if (nextReview && scopeRef.current === "base") onScopeRef.current("base", nextReview);
      })
      .catch((err: unknown) => current && setError(errorText(err)));
    return () => {
      current = false;
    };
  }, [threadId, worktree]);
  useEffect(load, [load, diffVersion, refreshKey]);
  // Commit, merge, push and remove change the diff too: reload it and this bar together.
  const changed = () => useStore.setState((s) => ({ diffVersion: s.diffVersion + 1 }));

  // A new thread starts clean: no message or notice carried over.
  useEffect(() => {
    setFolder(null);
    setReview(null);
    setScope("uncommitted");
    setMessage("");
    setBusy(null);
    setError(null);
    setNotice(null);
    setPicked(null);
    setOpened(null);
  }, [threadId]);

  // Moving to another step (a commit, a merge) opens the new current one.
  const step = review ? currentStep(review) : "commit";
  useEffect(() => setOpened(null), [step]);

  if (!folder) return null;
  const target = review ? (picked ?? review.base) : null;

  const run = async (kind: ReviewBusy, body: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await body();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const generate = () =>
    run("message", async () => {
      const result = await api().worktreeMessage(threadId);
      setMessage(result.message);
      setNotice(`Written by ${result.model}`);
    });

  const commit = () =>
    run("commit", async () => {
      await api().worktreeCommit(threadId, message);
      // A worktree keeps the message: it is the natural message for the squash merge next.
      if (!worktree) setMessage("");
      setNotice("Committed.");
      changed();
    });

  const merge = () =>
    run("merge", async () => {
      const result = await api().worktreeMerge(threadId, { mode, message, target: target ?? undefined });
      if (result.ok) {
        setNotice(`Merged into ${target ?? "base"} (${result.sha.slice(0, 7)}).`);
        setMessage("");
        changed();
      } else {
        setError(result.reason + (result.conflicts.length ? ` Conflicts: ${result.conflicts.join(", ")}` : ""));
      }
    });

  const push = () =>
    run("push", async () => {
      const result = await api().worktreePush(threadId);
      setNotice(`Pushed to ${result.remote}/${result.branch}.`);
      changed();
    });

  const remove = () =>
    run("remove", async () => {
      if (await api().worktreeRemove(threadId)) {
        setNotice("Worktree removed; the branch stays.");
        changed();
      } else setError("The worktree has uncommitted changes, so it was kept.");
    });

  return (
    <ReviewMergeBarView
      folder={folder}
      review={review}
      open={opened ?? step}
      scope={scope}
      message={message}
      busy={busy}
      error={error}
      notice={notice}
      mode={mode}
      target={target}
      onOpen={(next) => setOpened(next)}
      onScope={(next) => {
        if (!review) return;
        setScope(next);
        onScope(next, review);
      }}
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
