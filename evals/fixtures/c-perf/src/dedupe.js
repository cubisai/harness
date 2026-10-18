// Removes duplicates, keeping the first occurrence of each value.
export function dedupe(list) {
  const out = [];
  for (const item of list) {
    if (out.indexOf(item) === -1) out.push(item);
  }
  return out;
}
