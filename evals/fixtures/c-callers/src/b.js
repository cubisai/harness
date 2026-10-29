import { greet } from "./greet.js";

export function banner(name) {
  return greet(name).toUpperCase();
}
