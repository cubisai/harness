import { capitalize } from "./text.js";

// Title-cases a phrase, word by word.
export function titleCase(phrase) {
  return phrase.split(" ").map(capitalize).join(" ");
}
