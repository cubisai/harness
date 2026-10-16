import { Fragment, type ReactNode, useState } from "react";
import { type FileRef, fileUrlRef, parseFileRef } from "./fileref";
import { UiBlock } from "./genui/UiBlock";
import { memoizeByHash, parseBlocks, splitStreamingTail } from "./streaming";

/**
 * A small Markdown renderer for agent replies: fenced code, headings, lists,
 * GFM tables, paragraphs, and inline code / bold / italic / strikethrough /
 * links. It builds React elements (never raw HTML), so model output can't
 * inject markup. `ui:` fences render as inline UI blocks (validated JSON,
 * never HTML).
 */
/**
 * `onFile`, when given, turns inline code that names a file (`src/a.ts:42`)
 * into a link that opens it.
 */
export function Markdown({ text, streaming, onFile }: { text: string; streaming?: boolean; onFile?: (ref: FileRef) => void }) {
  // While streaming, parse only the frozen prefix (memoized); the tail renders
  // as plain text so an unterminated fence never becomes an open code block.
  const { frozen, tail } = streaming ? splitStreamingTail(text) : { frozen: text, tail: "" };
  const blocks = streaming ? memoizeByHash(frozen, parseBlocks) : parseBlocks(text);
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "code":
            return <CodeBlock key={i} text={b.text} lang={b.lang} />;
          case "ui":
            return <UiBlock key={i} name={b.name} body={b.body} fallback={<CodeBlock text={b.body} lang={`ui:${b.name}`} />} />;
          case "heading": {
            const H = (`h${Math.min(b.level, 3)}` as "h1" | "h2" | "h3");
            return <H key={i}>{inline(b.text, onFile)}</H>;
          }
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, onFile)}</li>
                ))}
              </L>
            );
          }
          case "table":
            return (
              <table key={i}>
                <thead>
                  <tr>
                    {b.header.map((cell, j) => (
                      <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                        {inline(cell, onFile)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, j) => (
                    <tr key={j}>
                      {row.map((cell, k) => (
                        <td key={k}>{inline(cell, onFile)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          default:
            return <p key={i}>{inline(b.text, onFile)}</p>;
        }
      })}
      {streaming ? (
        <p className="caret" style={{ whiteSpace: "pre-wrap" }}>
          {tail}
        </p>
      ) : null}
    </>
  );
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\(((?:https?|file):\/\/[^)\s]+|\/[^)\s]+|[A-Za-z]:[\\/][^)\s]+)\))|(~~[^~]+~~)/g;

function inline(text: string, onFile?: (ref: FileRef) => void): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    if (m[1]) {
      const code = tok.slice(1, -1);
      const ref = onFile ? parseFileRef(code) : null;
      out.push(
        ref ? (
          <button key={key++} className="file-link" title={`Open ${code} in the editor`} onClick={() => onFile!(ref)}>
            <code>{code}</code>
          </button>
        ) : (
          <code key={key++}>{code}</code>
        ),
      );
    }
    else if (m[2]) out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    else if (m[4]) {
      const label = /^\[([^\]]+)\]/.exec(tok)?.[1] ?? tok;
      if (!/^https?:/.test(m[5]!)) {
        // A local file: a file:// URL (Antigravity) or a bare absolute path, "/a/b.ts:12" or
        // "C:\a\b.ts" (Codex). Open it in the editor, never navigate to it.
        const ref = m[5]!.startsWith("file:") ? fileUrlRef(m[5]!) : parseFileRef(m[5]!);
        out.push(
          ref && onFile ? (
            <button key={key++} className="file-link" title={`Open ${ref.path} in the editor`} onClick={() => onFile(ref)}>
              <code>{label}</code>
            </button>
          ) : (
            <code key={key++}>{label}</code>
          ),
        );
        last = idx + tok.length;
        continue;
      }
      out.push(
        <a key={key++} href={m[5]} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    }
    else if (m[6]) out.push(<del key={key++}>{tok.slice(2, -2)}</del>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}

/** A fenced block with a header: its language and a Copy button (DESIGN.md §7.4). */
function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ?? "text"}</span>
        <button
          className="code-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
