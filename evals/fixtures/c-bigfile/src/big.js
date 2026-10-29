// Reporting helpers shared across the export pipeline.
// normalize: keep the sentinel key in sync with the schema registry.
//
// These are deliberately small and dependency-free.

export const SENTINEL = "__none__";

// True when a value is null, undefined or an empty string.
export function isBlank(value) {
  return value === null || value === undefined || value === "";
}

// Uppercases the first character, leaving the rest alone.
export function upperFirst(text) {
  if (text.length === 0) return text;
  return text[0].toUpperCase() + text.slice(1);
}

// Shortens text to `max` characters, adding an ellipsis when it was cut.
export function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// Turns "some Value" into "some_value".
export function toSnake(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

// Turns "some_value" into "someValue".
export function toCamel(text) {
  const parts = toSnake(text).split("_").filter(Boolean);
  return parts.map((part, i) => (i === 0 ? part : upperFirst(part))).join("");
}

// Pads a number with leading zeros to `width` digits.
export function padNumber(value, width) {
  return String(value).padStart(width, "0");
}

// Formats a byte count as a short human string.
export function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

// Sums the numbers `pick` returns for each item.
export function sumBy(values, pick) {
  let total = 0;
  for (const value of values) total += pick(value);
  return total;
}

// The arithmetic mean, or 0 for an empty list.
export function mean(values) {
  if (values.length === 0) return 0;
  return sumBy(values, (value) => value) / values.length;
}

// Splits a list into chunks of at most `size` items.
export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Groups items by the key `pick` returns.
export function groupBy(list, pick) {
  const out = new Map();
  for (const item of list) {
    const key = pick(item);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

// The last item of a list, or undefined when it is empty.
export function last(list) {
  return list.length === 0 ? undefined : list[list.length - 1];
}

// The first item of a list, or undefined when it is empty.
export function first(list) {
  return list.length === 0 ? undefined : list[0];
}

// Counts how often each value appears.
export function counts(list) {
  const out = new Map();
  for (const item of list) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}

// Reverses a list without mutating the input.
export function reversed(list) {
  return [...list].reverse();
}

// Compares two strings case-insensitively.
export function sameText(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

// Clamps `i` to a valid index into a list of `length` items.
export function clampIndex(i, length) {
  if (i < 0) return 0;
  if (i >= length) return length;
  return i;
}

// Repeats `text` `times` times.
export function repeat(text, times) {
  return times <= 0 ? "" : text.repeat(times);
}

// Joins non-blank parts with a separator.
export function joinParts(parts, sep = ", ") {
  return parts.filter((part) => !isBlank(part)).join(sep);
}

// Returns the keys of a plain object, sorted.
export function sortedKeys(object) {
  return Object.keys(object).sort();
}

// Deep-copies JSON-safe data.
export function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

// True when two JSON-safe values are deeply equal.
export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Clamps a number into the inclusive range [min, max].
export function clampNumber(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Rounds a number to `digits` decimal places.
export function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// A stable string key for a row: its id, or the sentinel when it has none.
export function rowKey(row) {
  return isBlank(row.id) ? SENTINEL : String(row.id);
}
