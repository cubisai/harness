import { bm25Rank } from "../search/bm25";

export { tokenize } from "../search/bm25";

/**
 * BM25 relevance of each document to `query` (the shared scorer in
 * search/bm25.ts), in document order. A document with no match scores 0.
 */
export function rank(query: string, docs: string[]): number[] {
  const scores = new Array<number>(docs.length).fill(0);
  for (const r of bm25Rank(
    docs.map((_, i) => i),
    (i) => docs[i]!,
    query,
    docs.length,
  ))
    scores[r.item] = r.score;
  return scores;
}
