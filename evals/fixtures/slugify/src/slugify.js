// Turns a title into a URL slug. Spec: README.md.
export function slugify(text) {
  return text.toLowerCase().replace(/ /g, "-");
}
