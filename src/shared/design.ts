/** A design thread's folder, relative to the thread's working folder: stable, since titles change. */
export function designDirName(threadId: string): string {
  return `designs/${threadId.slice(0, 8)}`;
}

/** An alternative version of the main page, e.g. `variant-a.html`, sitting beside it. */
export const VARIANT_RE = /^variant-[a-z0-9][a-z0-9-]{0,31}\.html?$/i;

/** True when `rel` names a variant page in the design folder's root (never in a subfolder). */
export function isVariant(rel: string): boolean {
  return !rel.includes("/") && !rel.includes("\\") && VARIANT_RE.test(rel);
}

/** A variant's short label for the UI: "variant-dense-hero.html" -> "Dense hero". Anything else as it is. */
export function variantLabel(rel: string): string {
  if (!isVariant(rel)) return rel;
  const words = rel.replace(/^variant-|\.html?$/gi, "").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

