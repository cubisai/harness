import { Fragment, type ReactNode } from "react";
import { type FileRef, parseFileRef } from "./fileref";

/**
 * A small Markdown renderer for agent replies: fenced code, headings, lists,
 * paragraphs, and inline code / bold / italic / links. It builds React
 * elements (never raw HTML), so model output can't inject markup.
 */
/**
 * `onFile`, when given, turns inline code that names a file (`src/a.ts:42`)
 * into a link that opens it.
 */
export function Markdown({ text, streaming, onFile }: { text: string; streaming?: boolean; onFile?: (ref: FileRef) => void }) {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((b, i) => {
        const last = streaming && i === blocks.length - 1;
        switch (b.type) {
          case "code":
            return (
              <pre key={i} className={last ? "caret" : undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case "heading": {
            const H = (`h${Math.min(b.level, 3)}` as "h1" | "h2" | "h3");
            return <H key={i}>{inline(b.text, onFile)}</H>;
          }
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L key={i}>
                {b.items.map((it, j) => (
                  <li key={j} className={last && j === b.items.length - 1 ? "caret" : undefined}>
                    {inline(it, onFile)}
                  </li>
                ))}
              </L>
            );
          }
          default:
            return (
              <p key={i} className={last ? "caret" : undefined}>
                {inline(b.text, onFile)}
              </p>
            );
        }
      })}
      {streaming && blocks.length === 0 ? <p className="caret" /> : null}
    </>
  );
}

type Block =
  | { type: "code"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "para"; text: string };

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "para", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith(fence[1]!)) body.push(lines[i++] ?? "");
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]!);
      const prev = blocks.at(-1);
      if (prev?.type === "list" && prev.ordered === ordered) prev.items.push(item[2]!);
      else blocks.push({ type: "list", ordered, items: [item[2]!] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const prev = blocks.at(-1);
    if (!para.length && prev?.type === "list" && /^\s{2,}\S/.test(line)) {
      prev.items[prev.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;

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
      out.push(
        <a key={key++} href={m[5]} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}
