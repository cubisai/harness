// Turns a title into a URL slug. Spec: README.md.
export function slugify(text) {
  let s = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 40) {
    const cut = s.slice(0, 41).lastIndexOf("-");
    s = cut > 0 ? s.slice(0, cut) : s.slice(0, 40);
  }
  return s || "untitled";
}
