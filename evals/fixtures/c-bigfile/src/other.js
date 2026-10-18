// A separate module the fix should not touch.
export function region(row) {
  return row.region ?? "unknown";
}
