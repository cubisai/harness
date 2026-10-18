import { greet } from "./greet.js";

export function email(name) {
  return `${greet(name)} Welcome aboard.`;
}
