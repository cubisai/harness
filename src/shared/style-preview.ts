/** The custom scheme the style picker's previews are served under: a style's tokens, fonts and the shared specimen. */
export const STYLE_PREVIEW_SCHEME = "cubiq-style";

/** The specimen page for `systemId` (as the picker lists it) in `projectId`'s list, drawn light or dark. */
export function stylePreviewUrl(projectId: string | null, systemId: string, theme: "light" | "dark"): string {
  return `${STYLE_PREVIEW_SCHEME}://p/${encodeURIComponent(projectId ?? "_")}/${encodeURIComponent(systemId)}/index.html?theme=${theme}`;
}
