/** Schemes the browser pane may load. Everything else is refused. */
export function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ["http:", "https:", "file:", "data:"].includes(u.protocol) || url === "about:blank";
  } catch {
    return false;
  }
}

/** "localhost:3000" → "http://localhost:3000"; "example.com" → "https://example.com". */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  // A scheme, unless it's really host:port ("localhost:3000").
  if (/^[a-z][a-z0-9+.-]*:(\/\/|[^\d])/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/.test(s)) return `http://${s}`;
  return `https://${s}`;
}
