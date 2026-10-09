import { Component, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { parseUnifiedDiff } from "../../../shared/diff";
import type { ArtifactContent, ArtifactFile, ArtifactKind, DiffHunk, SheetPreview, SlidePreview } from "../../../shared/types";
import { api } from "../api";
import { artifactKind, isPseudoArtifact, pseudoArtifactLabel } from "../../../shared/artifact-kind";
import { IconChevron, IconCopy, IconOpen } from "../icons";
import { Markdown } from "../markdown";
import "../styles/artifact.css";

export type ArtifactTab = "preview" | "source" | "diff";

export interface ArtifactPanelProps {
  threadId: string;
  /** Files written this thread, most recent first. */
  files: ArtifactFile[];
  /** The file shown. */
  path: string;
  onSelectPath(path: string): void;
  onClose(): void;
  onOpenInEditor(path: string): void;
  /** Show in Finder/Explorer. */
  onReveal(path: string): void;
  /** "Finder" | "File Explorer" | "Files". */
  fileManager: string;
}

const TAB_LABELS: Record<ArtifactTab, string> = { preview: "Preview", source: "Source", diff: "Diff" };

const ROW_HEIGHT = 26;

/** The tab a file opens on: code and plain text have no preview, so Source. */
export function defaultTab(kind: ArtifactKind): ArtifactTab {
  return kind === "code" || kind === "text" ? "source" : "preview";
}

/** A data: URI for an SVG string, so it renders as an image and never as markup. */
export function svgDataUri(text: string): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
}

/**
 * The rows a virtualized list should render: what fits in the viewport plus an
 * overscan band on each side. Pure, so the windowing math is unit-testable.
 */
export function visibleRows(scrollTop: number, viewport: number, rowHeight: number, total: number, overscan = 20): { start: number; end: number } {
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewport)) / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(total, last + overscan) };
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? path : path.slice(i + 1);
}

/** The name the panel shows: the file name, or "Plan"/"Critique" for the store-only artifacts. */
function displayName(path: string): string {
  return pseudoArtifactLabel(path) ?? basename(path);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

/** A minimal document around mammoth's sanitized docx HTML. */
function docxDocument(html: string): string {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
    "html,body{margin:0}" +
    "body{max-width:720px;margin:0 auto;padding:16px;font:13px/1.6 -apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,sans-serif;color-scheme:light dark;background:Canvas;color:CanvasText}" +
    "</style></head><body>" +
    html +
    "</body></html>"
  );
}

/** The body of the panel: pure over its props, so static renders can test it. */
export function ArtifactBody({
  content,
  tab,
  diff,
  onOpenInEditor,
}: {
  content: ArtifactContent | null;
  tab: ArtifactTab;
  diff: string | null | undefined;
  onOpenInEditor?: () => void;
}): JSX.Element {
  if (content === null) return <div className="artifact-loading">Loading…</div>;
  if (!content.ok) return <PreviewError error={content.error} onOpenInEditor={onOpenInEditor} />;
  if (tab === "diff") return <DiffBody diff={diff} />;
  if (tab === "source" || content.kind === "code" || content.kind === "text") return <SourceBody content={content} />;
  return <PreviewBody content={content} />;
}

type OkContent = Extract<ArtifactContent, { ok: true }>;

function PreviewBody({ content }: { content: OkContent }): JSX.Element {
  switch (content.kind) {
    case "md":
      return (
        <div className="artifact-md msg-assistant">
          <Markdown text={content.text ?? ""} />
        </div>
      );
    case "html":
      return <iframe className="artifact-frame" sandbox="" srcDoc={content.text ?? ""} title={content.path} />;
    case "svg":
      return (
        <div className="artifact-image-wrap">
          <img className="artifact-image" src={svgDataUri(content.text ?? "")} alt={content.path} />
        </div>
      );
    case "pdf":
      return <iframe className="artifact-frame" src={content.url} title={content.path} />;
    case "image":
      return (
        <div className="artifact-image-wrap">
          <img className="artifact-image" src={content.url} alt={content.path} />
        </div>
      );
    case "docx":
      return content.office?.kind === "docx" ? (
        <iframe className="artifact-frame" sandbox="" srcDoc={docxDocument(content.office.html)} title={content.path} />
      ) : (
        <SourceBody content={content} />
      );
    case "sheet":
    case "csv":
      return content.office?.kind === "sheet" ? <SheetBody sheets={content.office.sheets} /> : <SourceBody content={content} />;
    case "pptx":
      return content.office?.kind === "pptx" ? <SlidesBody slides={content.office.slides} /> : <SourceBody content={content} />;
    default:
      return <SourceBody content={content} />;
  }
}

function PreviewError({ error, onOpenInEditor }: { error?: string; onOpenInEditor?: () => void }): JSX.Element {
  return (
    <div className="artifact-empty">
      <p className="artifact-empty-title">Can't preview</p>
      {error ? <p className="artifact-empty-detail">{error}</p> : null}
      {onOpenInEditor ? (
        <button className="button" onClick={onOpenInEditor}>
          Open in Editor
        </button>
      ) : null}
    </div>
  );
}

function SourceBody({ content }: { content: OkContent }): JSX.Element {
  if (content.text === undefined) {
    return (
      <div className="artifact-empty">
        <p className="artifact-empty-detail">No source view for this file type</p>
      </div>
    );
  }
  return <SourceView text={content.text} truncated={content.truncated} />;
}

function SourceView({ text, truncated }: { text: string; truncated?: boolean }): JSX.Element {
  const lines = text.split("\n");
  return (
    <div className="artifact-source">
      <div className="artifact-source-scroll">
        <div className="artifact-gutter" aria-hidden="true">
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <pre className="artifact-code">{text}</pre>
      </div>
      {truncated ? <div className="artifact-note">Showing the first 2 MB</div> : null}
    </div>
  );
}

function DiffBody({ diff }: { diff: string | null | undefined }): JSX.Element {
  if (diff === undefined) return <div className="artifact-loading">Loading…</div>;
  if (diff === null) {
    return (
      <div className="artifact-empty">
        <p className="artifact-empty-detail">No diff for this file type</p>
      </div>
    );
  }
  const files = parseUnifiedDiff(diff);
  if (!files.some((f) => f.hunks.length > 0)) {
    return (
      <div className="artifact-empty">
        <p className="artifact-empty-detail">No changes</p>
      </div>
    );
  }
  return (
    <div className="artifact-diff">
      {files.map((f, i) => (
        <div className="artifact-diff-file" key={`${f.path}-${i}`}>
          <div className="artifact-diff-path">{f.path}</div>
          {f.hunks.map((h, k) => (
            <DiffHunk key={k} hunk={h} />
          ))}
        </div>
      ))}
    </div>
  );
}

function DiffHunk({ hunk }: { hunk: DiffHunk }): JSX.Element {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
  let oldNo = Number(m?.[1] ?? 1);
  let newNo = Number(m?.[2] ?? 1);
  return (
    <div className="artifact-hunk">
      <div className="artifact-hunk-header">{hunk.header}</div>
      {hunk.lines.map((line, i) => {
        const oldCell = line.kind === "add" ? "" : String(oldNo);
        const newCell = line.kind === "del" ? "" : String(newNo);
        if (line.kind === "add") newNo += 1;
        else if (line.kind === "del") oldNo += 1;
        else {
          oldNo += 1;
          newNo += 1;
        }
        return (
          <div key={i} className={`artifact-diff-line ${line.kind}`}>
            <span className="artifact-diff-no">{oldCell}</span>
            <span className="artifact-diff-no">{newCell}</span>
            <span className="artifact-diff-sign" aria-hidden="true">
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            </span>
            <span className="artifact-diff-text">{line.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function SheetBody({ sheets }: { sheets: SheetPreview[] }): JSX.Element {
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, sheets.length]);

  const sheet = sheets[Math.min(active, sheets.length - 1)];
  if (!sheet) {
    return (
      <div className="artifact-empty">
        <p className="artifact-empty-detail">No sheets</p>
      </div>
    );
  }

  const rows = sheet.rows;
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const cols = rows.reduce((max, r) => Math.max(max, r.length), 0) + 1;
  const win = visibleRows(scrollTop, viewport, ROW_HEIGHT, body.length);

  return (
    <div className="artifact-sheet">
      {sheets.length > 1 ? (
        <div className="artifact-sheet-tabs">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              className={i === active ? "on" : ""}
              onClick={() => {
                setActive(i);
                setScrollTop(0);
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="artifact-sheet-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <table className="artifact-sheet-table">
          {header.length > 0 ? (
            <thead>
              <tr>
                <th className="artifact-rownum" scope="col" aria-label="Row" />
                {header.map((cell, i) => (
                  <th key={i} scope="col">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {win.start > 0 ? (
              <tr className="artifact-sheet-spacer" aria-hidden="true">
                <td colSpan={cols} style={{ height: win.start * ROW_HEIGHT }} />
              </tr>
            ) : null}
            {body.slice(win.start, win.end).map((row, i) => (
              <tr key={win.start + i}>
                <td className="artifact-rownum">{win.start + i + 1}</td>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
            {win.end < body.length ? (
              <tr className="artifact-sheet-spacer" aria-hidden="true">
                <td colSpan={cols} style={{ height: (body.length - win.end) * ROW_HEIGHT }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {sheet.truncated ? (
        <div className="artifact-sheet-foot">
          Showing the first {body.length} of {sheet.totalRows} rows
        </div>
      ) : null}
    </div>
  );
}

function SlidesBody({ slides }: { slides: SlidePreview[] }): JSX.Element {
  if (slides.length === 0) {
    return (
      <div className="artifact-empty">
        <p className="artifact-empty-detail">No slides</p>
      </div>
    );
  }
  return (
    <div className="artifact-slides">
      {slides.map((slide) => (
        <div className="artifact-slide" key={slide.index}>
          <div className="artifact-slide-label">Slide {slide.index}</div>
          {slide.title ? <h3 className="artifact-slide-title">{slide.title}</h3> : null}
          {slide.texts.map((text, i) => (
            <p className="artifact-slide-text" key={i}>
              {text}
            </p>
          ))}
          {slide.images.map((src, i) => (
            <img className="artifact-slide-img" key={i} src={src} alt="" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A render crash in the body shows the same "Can't preview" state. */
class ArtifactErrorBoundary extends Component<{ children: ReactNode; onOpenInEditor?: () => void }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: string | null } {
    return { error: error instanceof Error ? error.message : "This preview couldn't be rendered." };
  }

  render(): ReactNode {
    if (this.state.error !== null) return <PreviewError error={this.state.error} onOpenInEditor={this.props.onOpenInEditor} />;
    return this.props.children;
  }
}

/**
 * The artifact panel: the file an agent wrote, with a version picker, Preview /
 * Source / Diff tabs, and the actions that open it elsewhere (DESIGN.md §7.5).
 */
export function ArtifactPanel(props: ArtifactPanelProps): JSX.Element {
  const { threadId, files, path, onSelectPath, onClose, onOpenInEditor, onReveal, fileManager } = props;
  const file = files.find((f) => f.path === path) ?? null;
  // The plan and the critique live only in the version store: no file to open elsewhere.
  const plan = isPseudoArtifact(path);
  // From the path itself: the thread's file list loads after the panel opens.
  const kind: ArtifactKind = file?.kind ?? artifactKind(path);
  const versions = [...(file?.versions ?? [])].sort((a, b) => b.version - a.version);

  const [version, setVersion] = useState<number | null>(null);
  const [tab, setTab] = useState<ArtifactTab>(() => defaultTab(kind));
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [diff, setDiff] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [openMenu, setOpenMenu] = useState<"files" | "version" | "open" | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);
  const diffSeq = useRef(0);

  // A new file starts over: latest on disk, its default tab, nothing loaded.
  useEffect(() => {
    setVersion(null);
    setTab(defaultTab(kind));
    setContent(null);
    setDiff(undefined);
    setCopied(false);
    setOpenMenu(null);
    // Reset only when the file changes; `kind` follows it.
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Latest" reloads when a new version lands (the plan gets one per round while the panel is open).
  const newest = version === null ? (versions[0]?.version ?? null) : null;

  // Load the content; a late response for an old path/version never lands.
  useEffect(() => {
    const seq = ++loadSeq.current;
    setContent(null);
    void api()
      .readArtifact(threadId, path, version)
      .then((res) => {
        if (seq === loadSeq.current) setContent(res);
      })
      .catch(() => {
        if (seq === loadSeq.current) setContent({ ok: false, error: "Couldn't read this file." });
      });
  }, [threadId, path, version, newest]);

  // The diff is fetched only when its tab is opened, and refetched when the file or version changes.
  useEffect(() => {
    if (tab !== "diff") return;
    const seq = ++diffSeq.current;
    setDiff(undefined);
    void api()
      .artifactDiff(threadId, path, version)
      .then((res) => {
        if (seq === diffSeq.current) setDiff(res);
      })
      .catch(() => {
        if (seq === diffSeq.current) setDiff(null);
      });
  }, [tab, threadId, path, version, newest]);

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!headerRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpenMenu(null);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [openMenu]);

  const tabs: ArtifactTab[] = kind === "code" || kind === "text" ? ["source", "diff"] : ["preview", "source", "diff"];
  const text = content?.ok ? content.text : undefined;
  const latest = versions[0]?.version;
  const versionLabel = version === null ? (latest !== undefined ? `v${latest}` : "Latest") : `v${version}`;

  const copy = () => {
    if (text === undefined) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const onTabsKey = (e: { key: string; preventDefault(): void }) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = tabs.indexOf(tab);
    const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length;
    setTab(tabs[next] ?? tabs[0]!);
  };

  return (
    <div className="artifact">
      <div className="artifact-head" ref={headerRef}>
        <div className="artifact-name" title={plan ? `The agent's ${displayName(path).toLowerCase()}, one version per round` : path}>
          {displayName(path)}
        </div>
        <div className="artifact-head-actions">
          {files.length > 1 ? (
            <div className="artifact-menu-wrap">
              <button
                className="artifact-chip"
                aria-haspopup="menu"
                aria-expanded={openMenu === "files"}
                onClick={() => setOpenMenu(openMenu === "files" ? null : "files")}
              >
                Files
                <IconChevron open size={12} />
              </button>
              {openMenu === "files" ? (
                <div className="artifact-menu" role="menu">
                  {files.map((f) => (
                    <button
                      key={f.path}
                      role="menuitem"
                      className={f.path === path ? "on" : ""}
                      title={f.path}
                      onClick={() => {
                        setOpenMenu(null);
                        onSelectPath(f.path);
                      }}
                    >
                      <span className="artifact-menu-label">{displayName(f.path)}</span>
                      {dirname(f.path) ? <span className="artifact-menu-sub">{dirname(f.path)}</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {versions.length > 0 ? (
            <div className="artifact-menu-wrap">
              <button
                className="artifact-chip"
                aria-label="Version"
                aria-haspopup="menu"
                aria-expanded={openMenu === "version"}
                onClick={() => setOpenMenu(openMenu === "version" ? null : "version")}
              >
                {versionLabel}
                <IconChevron open size={12} />
              </button>
              {openMenu === "version" ? (
                <div className="artifact-menu" role="menu">
                  <button
                    role="menuitem"
                    className={version === null ? "on" : ""}
                    onClick={() => {
                      setVersion(null);
                      setOpenMenu(null);
                    }}
                  >
                    {plan ? "Latest" : "Latest on disk"}
                  </button>
                  {versions.map((v) => (
                    <button
                      key={v.version}
                      role="menuitem"
                      className={version === v.version ? "on" : ""}
                      onClick={() => {
                        setVersion(v.version);
                        setOpenMenu(null);
                      }}
                    >
                      {`v${v.version}`}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {plan ? null : (
          <div className="artifact-menu-wrap">
            <button
              className="artifact-chip"
              aria-haspopup="menu"
              aria-expanded={openMenu === "open"}
              onClick={() => setOpenMenu(openMenu === "open" ? null : "open")}
            >
              Open in
              <IconChevron open size={12} />
            </button>
            {openMenu === "open" ? (
              <div className="artifact-menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setOpenMenu(null);
                    onOpenInEditor(path);
                  }}
                >
                  <IconOpen />
                  Editor
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setOpenMenu(null);
                    onReveal(path);
                  }}
                >
                  <IconOpen />
                  {fileManager}
                </button>
              </div>
            ) : null}
          </div>
          )}

          <button className="artifact-icon" aria-label={copied ? "Copied" : "Copy"} title="Copy" disabled={text === undefined} onClick={copy}>
            <IconCopy />
          </button>
          <button className="artifact-icon" aria-label="Close panel" title="Close panel" onClick={onClose}>
            ×
          </button>
        </div>
      </div>

      <div className="artifact-tabs" role="tablist" aria-label="Artifact view" onKeyDown={onTabsKey}>
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            tabIndex={tab === t ? 0 : -1}
            className={tab === t ? "on" : ""}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="artifact-body">
        <ArtifactErrorBoundary key={`${path}:${version ?? "latest"}:${tab}`} onOpenInEditor={() => onOpenInEditor(path)}>
          <ArtifactBody content={content} tab={tab} diff={diff} onOpenInEditor={() => onOpenInEditor(path)} />
        </ArtifactErrorBoundary>
      </div>
    </div>
  );
}
