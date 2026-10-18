import { titleCase } from "./labels.js";

// Normalizes a heading for display.
export function formatTitle(phrase) {
  return titleCase(phrase.trim());
}
