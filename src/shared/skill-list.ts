/** The skills of a user event or send request: the list, else the single older `skill`, deduped in order. */
export function skillsOf(x: { skill?: string; skills?: readonly string[] }): string[] {
  const all = x.skills?.length ? x.skills : x.skill ? [x.skill] : [];
  return [...new Set(all.filter((s) => s.trim()))];
}
