// Adds up the numbers in a list, skipping anything that isn't a finite number.
export function sum(values) {
  let total = 0;
  for (const v of values) if (Number.isFinite(v)) total += v;
  return total;
}
