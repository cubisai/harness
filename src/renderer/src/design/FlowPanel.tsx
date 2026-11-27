import { useEffect, useRef, useState } from "react";
import type { DesignEntry, PrototypeFlow } from "../../../shared/types";
import { api } from "../api";
import { Select } from "../components/Select";
import { pageFromPath } from "./frame";

export function FlowPanel({ id, entry, close }: { id: string; entry: DesignEntry; close(): void }) {
  const [flows, setFlows] = useState<PrototypeFlow[]>([]), [name, setName] = useState("");
  const [pages, setPages] = useState([entry.rel, entry.pages.find((p) => p.rel !== entry.rel)?.rel ?? entry.rel]);
  const [play, setPlay] = useState<PrototypeFlow | null>(null), [step, setStep] = useState(0), [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null), clicked = useRef(false);
  const missing = play?.pages.find((p) => !entry.pages.some((v) => v.rel === p));
  useEffect(() => { void api().designFlows(id).then(setFlows).catch((e) => setError(String(e))); }, [id]);
  useEffect(() => {
    if (!play || error || missing || step >= play.pages.length - 1) return;
    const receive = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || e.data?.source !== "cubiq-design") return;
      const expected = play.pages[step + 1];
      if (e.data.type === "follow-link" && typeof e.data.url === "string") {
        const actual = e.data.url;
        clicked.current = actual.split(/[?#]/)[0] === entry.pages.find((p) => p.rel === expected)?.url;
        if (!clicked.current) setError(`Expected ${expected}; followed ${actual}.`);
      } else if (e.data.type === "ready" && typeof e.data.path === "string" && clicked.current) {
        clicked.current = false;
        const actual = pageFromPath(e.data.path, id);
        if (actual === expected) setStep(step + 1);
        else setError(`Expected ${expected}; reached ${actual ?? "another page"}.`);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [entry.pages, play, step, missing, error, id]);
  const save = async () => {
    try { setFlows(await api().designFlows(id, { name, pages })); setError(""); }
    catch (err) { setError(String(err)); }
  };
  return <section className="design-review-panel" aria-label="Prototype flows">
    <button className="button ghost" onClick={close}>Close flows</button>
    {error && <p role="alert">{error}</p>}
    {play ? <><p role="status">{missing ? `Missing step: ${missing}` : error ? "Playback diverged" : step === play.pages.length - 1 ? `Completed ${play.name}` : `${play.name}: ${play.pages[step]} → ${play.pages[step + 1]}`}</p>
      <button className="button ghost" onClick={() => { setPlay(null); setError(""); }}>End playback</button>
      {!missing && <iframe title={play.name} ref={frame} sandbox="allow-scripts" src={entry.pages.find((p) => p.rel === play.pages[0])?.url} />}</> : <>
      {flows.map((f) => <button key={f.name} className="button ghost" onClick={() => { clicked.current = false; setError(""); setStep(0); setPlay(f); }}>Play {f.name}</button>)}
      <label>Flow name <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label>
      {pages.map((p, i) => <Select key={i} ariaLabel={i ? `Destination ${i}` : "Starting page"} value={p} options={entry.pages.map((v) => ({ value: v.rel, label: v.rel }))} onChange={(v) => setPages(pages.map((old, j) => i === j ? v : old))} />)}
      <button className="button ghost" onClick={() => setPages([...pages, entry.rel])}>Add step</button>
      <button className="button" disabled={!name.trim()} onClick={() => void save()}>Save flow</button></>}
  </section>;
}
