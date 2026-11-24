import { File } from "lucide-react";
import { fileKind } from "../attachments";

const OFFICE_SHORT: Record<string, string> = { DOCX: "DOC", DOCM: "DOC", XLSX: "XLS", XLSM: "XLS", PPTX: "PPT", PPTM: "PPT" };

/** The badge text: the file's extension in capitals, at most 4 letters ("PDF", "DOC" for .docx, "JSON", "PY"); "" when it has none. */
export function badgeText(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  const ext = name.slice(dot + 1);
  if (!/^[a-z0-9]{1,8}$/i.test(ext)) return "";
  const upper = ext.toUpperCase();
  // Office's newer formats read as their three-letter family; the colour already says which app.
  return OFFICE_SHORT[upper] ?? upper.slice(0, 4);
}

/**
 * A file's icon, as on the files in Finder or Explorer: the page with its extension on a badge, in its
 * family's colour (PDF red, Word blue, Excel green, slides orange, archives amber, code violet, media pink).
 * A file with no extension gets the plain page.
 */
export function FileIcon({ name, mediaType, size = 16, className }: { name: string; mediaType?: string; size?: number; className?: string }) {
  const kind = fileKind(name, mediaType);
  const badge = badgeText(name);
  if (!badge) return <File size={size} className={className} data-kind={kind} aria-hidden />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`file-badge-icon ${className ?? ""}`} data-kind={kind} aria-hidden>
      {/* The page with its folded corner, in the line icons' stroke. */}
      <path d="M14 2H6.5A2.5 2.5 0 0 0 4 4.5v15A2.5 2.5 0 0 0 6.5 22h11a2.5 2.5 0 0 0 2.5-2.5V8Z" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
      <path d="M14 2v4.5A1.5 1.5 0 0 0 15.5 8H20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
      {/* The badge runs wider than the page so its letters read at 16px. */}
      <rect className="file-badge" x="0.5" y="11" width="21" height="9" rx="2" />
      <text x="11" y={badge.length > 3 ? 17.6 : 17.9} textAnchor="middle" fontSize={badge.length > 3 ? 5.6 : 7} className="file-badge-text">
        {badge}
      </text>
    </svg>
  );
}
