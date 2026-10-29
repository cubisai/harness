import { Fragment, type ReactNode, useState } from "react";
import { LinkCards, LinkChip } from "./components/LinkChip";
import { type FileRef, fileUrlRef, parseFileRef } from "./fileref";
import { SmartTable } from "./genui/SmartTable";
import { UiBlock } from "./genui/UiBlock";
import { useStore } from "./store";
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
  // Smart tables / task lists follow the uiBlocks setting; off, everything renders as before.
  const smart = useStore((s) => s.settings?.uiBlocks === true);
  // While streaming, parse only the frozen prefix (memoized); the tail renders
  // as plain text so an unterminated fence never becomes an open code block.
  const { frozen, tail } = streaming ? splitStreamingTail(text) : { frozen: text, tail: "" };
  const blocks = streaming ? memoizeByHash(frozen, parseBlocks) : parseBlocks(text);
  const building = streaming ? buildingUi(tail) : null;
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
            // A plain list of `- [x]` tasks becomes a readable checklist; other lists are untouched.
            if (smart && !b.ordered && b.items.every((it) => /^\[[ xX]\]\s+/.test(it))) {
              return (
                <ul key={i} className="md-tasks">
                  {b.items.map((it, j) => {
                    const done = /^\[[xX]\]/.test(it);
                    return (
                      <li key={j} className="ui-check md-task">
                        <input type="checkbox" checked={done} readOnly disabled aria-label={done ? "Done" : "Not done"} />
                        <span>{inline(it.replace(/^\[[ xX]\]\s+/, ""), onFile)}</span>
                      </li>
                    );
                  })}
                </ul>
              );
            }
            // A list of `**Title** — text` items reads as a card list, as in ChatGPT.
            const cards = smart ? boldLeadItems(b.items) : null;
            if (cards) {
              return (
                <div key={i} className="ui-block md-cards">
                  <ul className="ui-cards">
                    {cards.map((c, j) => (
                      <li key={j} className="ui-card">
                        <div className="ui-card-body">
                          <div className="ui-card-title">
                            {b.ordered ? `${j + 1}. ` : null}
                            {inline(c.title, onFile)}
                          </div>
                          {c.text ? <div className="ui-card-text">{inline(c.text, onFile)}</div> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            }
            const L = b.ordered ? "ol" : "ul";
            return (
              <Fragment key={i}>
                <L>
                  {b.items.map((it, j) => (
                    <li key={j}>{inline(it, onFile)}</li>
                  ))}
                </L>
                <LinkCards urls={linkUrls(b.items.join("\n"))} />
              </Fragment>
            );
          }
          case "table":
            return smart ? (
              <SmartTable key={i} header={b.header} align={b.align} rows={b.rows} renderCell={(c) => inline(c, onFile)} />
            ) : (
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
            return (
              <Fragment key={i}>
                <p>{inline(b.text, onFile)}</p>
                <LinkCards urls={linkUrls(b.text)} />
              </Fragment>
            );
        }
      })}
      {streaming ? (
        building !== null ? (
          <p className="caret ui-building">Building a {building}…</p>
        ) : (
          <p className="caret" style={{ whiteSpace: "pre-wrap" }}>
            {tail}
          </p>
        )
      ) : null}
    </>
  );
}

/**
 * A list's items as titled cards when every item opens with a bold title
 * (`**Title** — text`, `**Title**: text`, `**Title:** text`) and at least two
 * carry text; otherwise null.
 */
export function boldLeadItems(items: string[]): { title: string; text: string }[] | null {
  if (items.length < 2) return null;
  const out: { title: string; text: string }[] = [];
  for (const item of items) {
    const m = /^\*\*([^*]+?)\*\*\s*(?:[—–:-]\s*)?([\s\S]*)$/.exec(item.trim());
    if (!m) return null;
    out.push({ title: m[1]!.trim().replace(/[:.]$/, ""), text: m[2]!.trim() });
  }
  return out.filter((c) => c.text).length >= 2 ? out : null;
}

/** The name of the ```ui:<name> fence the streaming tail is still writing, if any. */
function buildingUi(tail: string): string | null {
  return /^(```|~~~)\s*ui:([a-z][a-z0-9-]*)/.exec(tail.trimStart())?.[2] ?? null;
}

// A web URL may hold balanced parentheses (Wikipedia's "Electron_(software_framework)").
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\(((?:https?|file):\/\/(?:[^()\s]|\([^()\s]*\))+|\/[^)\s]+|[A-Za-z]:[\\/][^)\s]+)\))|(~~[^~]+~~)|(https?:\/\/(?:[^\s<>()\[\]]|\([^\s<>()\[\]]*\))+)/g;

/** A bare URL without the sentence punctuation after it: [url, the punctuation]. */
function splitTrailing(raw: string): [string, string] {
  let url = raw;
  let trailing = "";
  // A closing parenthesis is the sentence's only when the URL doesn't open one too.
  const unbalanced = (u: string) => (u.match(/\)/g)?.length ?? 0) > (u.match(/\(/g)?.length ?? 0);
  while (/[.,;:!?'"]$/.test(url) || (url.endsWith(")") && unbalanced(url))) {
    trailing = url.slice(-1) + trailing;
    url = url.slice(0, -1);
  }
  return [url, trailing];
}

/** The web links a block's text holds (labelled and bare, not inside code), once each, in order: its link cards. */
export function linkUrls(text: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(INLINE)) {
    const url = m[5] && /^https:\/\//.test(m[5]) ? m[5] : m[7] ? splitTrailing(m[7])[0] : null;
    if (url && /^https:\/\//.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

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
    // Bold, italic and strikethrough hold inline markup too: `**1. `a.ts` — done**` keeps its code.
    else if (m[2]) out.push(<strong key={key++}>{inline(tok.slice(2, -2), onFile)}</strong>);
    else if (m[3]) out.push(<em key={key++}>{inline(tok.slice(1, -1), onFile)}</em>);
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
      out.push(<LinkChip key={key++} href={m[5]!} label={label} />);
    }
    else if (m[6]) out.push(<del key={key++}>{inline(tok.slice(2, -2), onFile)}</del>);
    else if (m[7]) {
      // A bare URL in prose: chip it, and leave any sentence punctuation as text.
      const [url, trailing] = splitTrailing(m[7]!);
      out.push(<LinkChip key={key++} href={url} label={url} />);
      if (trailing) out.push(trailing);
    }
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
