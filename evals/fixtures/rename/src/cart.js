import { fmtPrice } from "./util.js";

export function cartTotal(items) {
  const cents = items.reduce((n, i) => n + i.cents * i.qty, 0);
  return fmtPrice(cents);
}
