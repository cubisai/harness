/** Lowercased alphanumeric terms: non-alphanumerics split, empty terms dropped. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

const K1 = 1.2;
const B = 0.75;

/**
 * BM25 relevance of each document to `query` (k1 1.2, b 0.75), query and
 * documents sharing one tokeniser. A term absent from every document
 * contributes nothing, so a document with no match scores 0.
 */
export function rank(query: string, docs: string[]): number[] {
  const terms = [...new Set(tokenize(query))];
  const tokenized = docs.map(tokenize);
  const total = tokenized.reduce((sum, d) => sum + d.length, 0);
  const avgdl = docs.length ? total / docs.length : 0;
  const df = new Map<string, number>();
  for (const term of terms) df.set(term, tokenized.filter((d) => d.includes(term)).length);
  return tokenized.map((tokens) => {
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = freq.get(term) ?? 0;
      if (!f) continue;
      const n = df.get(term)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (tokens.length / (avgdl || 1)))));
    }
    return score;
  });
}
