// Parses CSV text into an array of rows (arrays of strings).
export function parseCsv(text) {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(","));
}
