// Secret redaction for anything a plan might be logged or serialized as. Pure,
// so the injection layer never reaches for the settings store to redact.

const REPLACEMENT = "«redacted»";

/** Secrets shorter than this are ignored: they match too much ordinary text. */
const MIN_LENGTH = 4;

/**
 * Every occurrence of each secret in `text`, replaced with «redacted».
 * Secrets under four characters are skipped as too short to match safely;
 * longer secrets go first, so a key that contains another is replaced whole.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const ordered = secrets.filter((s) => s.length >= MIN_LENGTH).sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of ordered) out = out.split(secret).join(REPLACEMENT);
  return out;
}

/** A deep copy of `value` with every string redacted, for events and logged plans. */
export function redactDeep<T>(value: T, secrets: readonly string[]): T {
  if (!secrets.length) return value;
  if (typeof value === "string") return redactSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, secrets);
    return out as T;
  }
  return value;
}
