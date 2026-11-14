import { useEffect, useMemo, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { api } from "../api";
import { Select } from "../components/Select";
import { highlight, langOf } from "./highlight";

/** The picker's order: the page first, then its tokens and components, then the design's other files. */
export function codeFileOrder(files: string[], page: string): string[] {
  const first = [page, "system/tokens.css", "system/ui.css"];
  return [...first.filter((f) => f === page || files.includes(f)), ...files.filter((f) => !first.includes(f))];
}

/** The top bar's Code view: a read-only source viewer over the canvas, with one-click copy. Opens at `line` when asked. */
export function CodeView({ threadId, designDir, page, reloadKey, line = null }: { threadId: string; designDir: string; page: string; reloadKey: string; line?: number | null }) {
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState(page);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => setFile(page), [page]);
  useEffect(() => {
    let live = true;
    void api()
      .designFiles(threadId)
      .then((res) => live && setFiles(res))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [threadId, designDir, reloadKey]);
  useEffect(() => {
    let live = true;
    void api()
      .readArtifact(threadId, `${designDir}/${file}`)
      .then((res) => live && setCode(res.ok && typeof res.text === "string" ? res.text : null))
      .catch(() => live && setCode(null));
    return () => {
      live = false;
    };
  }, [threadId, designDir, file, reloadKey]);

  const tokens = useMemo(() => (code === null ? [] : highlight(code, langOf(file))), [code, file]);
  const lineCount = useMemo(() => (code === null ? 0 : code.split("\n").length), [code]);
  const order = codeFileOrder(files, page);

  // One line's height is read from the gutter, so it holds at any text size.
  useEffect(() => {
    if (line === null || code === null || file !== page) return;
    const row = scroller.current?.querySelector<HTMLElement>(".design-inspector-gutter > div");
    if (row && scroller.current) scroller.current.scrollTop = Math.max(0, (line - 4) * row.offsetHeight);
  }, [line, code, file, page]);

  const copy = () => {
    if (code === null) return;
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <section className="studio-code" aria-label="Code">
      <div className="design-inspector-code-head">
        {order.length > 1 ? (
          <Select<string> value={file} options={order.map((f) => ({ value: f, label: f }))} onChange={setFile} ariaLabel="File" className="ghost-select" />
        ) : (
          <span className="design-inspector-code-path" title={`${designDir}/${file}`}>
            {file}
          </span>
        )}
        <span className="grow" />
        <button className="button ghost" disabled={code === null} onClick={copy}>
          <Copy size={14} strokeWidth={1.75} aria-hidden />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {code !== null ? (
        <div className="design-inspector-code-scroll" ref={scroller}>
          <div className="design-inspector-gutter" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <pre className="design-inspector-code">{tokens.map((t, i) => (t.kind === "plain" ? t.text : <span key={i} className={`syn-${t.kind}`}>{t.text}</span>))}</pre>
        </div>
      ) : (
        <p className="design-inspector-empty">Can't show this file.</p>
      )}
    </section>
  );
}
