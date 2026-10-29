import type { Usage, UsageProvenance } from "../shared/types";

/**
 * The canonical hit rate: cache reads over true processed input. Null when the
 * agent doesn't report cache reads, or when the denominator is zero.
 */
export function hitRate(u: { cacheReadTokens: number | null; cacheWriteTokens: number | null; inputTokens: number }): number | null {
  if (u.cacheReadTokens === null) return null;
  const total = u.cacheReadTokens + (u.cacheWriteTokens ?? 0) + u.inputTokens;
  return total === 0 ? null : u.cacheReadTokens / total;
}

/** Fill a vendor's raw usage report into the canonical `Usage` shape. */
export function normalizeUsage(raw: {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cacheTtl?: Usage["cacheTtl"];
  provenance?: UsageProvenance;
}): Usage {
  const cacheReadTokens = raw.cacheReadTokens ?? null;
  const cacheWriteTokens = raw.cacheWriteTokens ?? null;
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    reasoningTokens: raw.reasoningTokens ?? null,
    cacheReadTokens,
    cacheWriteTokens,
    cacheTtl: raw.cacheTtl ?? null,
    hitRate: hitRate({ cacheReadTokens, cacheWriteTokens, inputTokens: raw.inputTokens }),
    miss: false,
    provenance: raw.provenance ?? (cacheReadTokens === null ? "unavailable" : "reported"),
  };
}
