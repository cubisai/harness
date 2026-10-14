import { fmtPrice } from "./util.js";

export function receiptLine(item) {
  return `${item.name} x${item.qty}  ${fmtPrice(item.cents * item.qty)}`;
}
