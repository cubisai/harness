// Generic BM25 ranking. MCP tool search and the skill catalog both score text
// the same way; callers only choose what text each item contributes.

const K1 = 1.2;
const B = 0.75;

/** Lowercase, split on anything that isn't a-z0-9 (so "_", "-" and "." split), drop empties. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Rank `items` against a query with BM25 over `text(item)`. Repeat a field in
 * the text to boost it. Only positive scores are kept, best first; ties follow
 * `tiebreak` when given, else the items' own order.
 */
export function bm25Rank<T>(items: T[], text: (item: T) => string, query: string, limit: number, tiebreak?: (a: T, b: T) => number): { item: T; score: number }[] {
  const docs = items.map((item) => tokenize(text(item)));
  const n = items.length;
  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / (n || 1);
  const terms = [...new Set(tokenize(query))];
  const df = new Map(terms.map((term) => [term, docs.filter((doc) => doc.includes(term)).length]));
  const scored = items.map((item, i) => {
    const doc = docs[i] ?? [];
    let score = 0;
    for (const term of terms) {
      const tf = doc.filter((t) => t === term).length;
      if (tf === 0) continue;
      const freq = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - freq + 0.5) / (freq + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgdl)));
    }
    return { item, score, i };
  });
  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (tiebreak ? tiebreak(a.item, b.item) : a.i - b.i))
    .slice(0, limit)
    .map(({ item, score }) => ({ item, score }));
}
