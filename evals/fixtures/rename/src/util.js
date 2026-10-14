// Formats a price in cents as dollars.
export function fmtPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
