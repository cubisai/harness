import { useEffect, useRef, useState } from "react";
import type { DesignReview, SizeReview } from "../../../shared/types";
import { api } from "../api";
import { useStore } from "../store";

interface Props {
  threadId: string; page: string; revision: string; mode: "sizes" | "build";
  pick(width: number, selector: string): void; close(): void;
}

export function ReviewPanel({ threadId, page, revision, mode, pick, close }: Props) {
  const [review, setReview] = useState<DesignReview | null>(null);
  const [sizes, setSizes] = useState<SizeReview[]>([]);
  const [snapshot, setSnapshot] = useState("");
  const [size, setSize] = useState({ width: 280, height: 200 });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [checked, setChecked] = useState(revision);
  const latest = useRef(revision);
  latest.current = revision;
  const stale = revision !== checked;
  useEffect(() => {
    let current = true;
    const start = latest.current;
    setChecked(start); setBusy(true); setError(""); setSizes([]); setReview(null);
    const load = mode === "sizes" ? api().designReviewSizes(threadId, page).then((r) => { if (current) setSizes(r); })
      : api().designReview(threadId, page).then((r) => { if (current) setReview(r); });
    void load.catch((err) => { if (current) setError(String(err)); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [threadId, page, mode, attempt]);
  const approve = async () => {
    if (!review) return;
    setBusy(true); setError("");
    try { setSnapshot(await api().designApprove(threadId, review)); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const convert = async () => {
    setBusy(true); setError("");
    try {
      const { thread, app } = await api().designToCreator(threadId, snapshot, size);
      const state = useStore.getState();
      state.apply({ type: "thread", thread });
      await state.selectProject(thread.projectId);
      await state.selectThread(thread.id);
      state.setComposerDraft(`Continue the reviewed design in the app draft ${app.name}. `);
      state.openApp(app);
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  return <section className="design-review-panel" aria-label={mode === "sizes" ? "Review sizes" : "Review build inputs"}>
    <button className="button ghost" onClick={close}>Close review</button>
    {snapshot ? <><p>Approved revision {review?.digest.slice(0, 12)} · {page}</p>
      <button className="button primary" onClick={() => { close(); void useStore.getState().buildDesignInCode(threadId, snapshot, page); }}>Build approved revision</button>
      <label>Widget width <input type="number" min="160" max="480" value={size.width} onChange={(e) => setSize({ ...size, width: Number(e.target.value) })} /></label>
      <label>Height <input type="number" min="80" max="600" value={size.height} onChange={(e) => setSize({ ...size, height: Number(e.target.value) })} /></label>
      <button className="button ghost" disabled={busy} onClick={() => void convert()}>Open in Creator</button>
      {error && <p role="alert">{error}</p>}
      <button className="button ghost" onClick={() => { setSnapshot(""); setAttempt((n) => n + 1); }}>Review current files</button></>
      : stale || error ? <><p role="status">{error || "Files changed since this review."}</p><button className="button ghost" onClick={() => setAttempt((n) => n + 1)}>Review again</button></>
      : busy ? <p role="status">Checking saved files…</p> : mode === "sizes" ? sizes.map(({ width, findings }) => <details key={width} open={findings.length > 0}>
        <summary>{width} px · {findings.length ? `${findings.length} findings` : "No findings"}</summary>
        {findings.map((f, i) => <button className="button ghost" key={i} onClick={() => pick(width, f.selector)}>{f.id ?? f.selector}: {f.detail}</button>)}
      </details>) : review && <><p>{page} · {review.files.length} build inputs</p>
        <ul>{review.files.map((f) => <li key={f.path}>{f.path} <code>{f.sha256.slice(0, 12)}</code></li>)}</ul>
        <button className="button primary" onClick={() => void approve()}>Approve these files</button></>}
  </section>;
}
