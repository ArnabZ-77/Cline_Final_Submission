// total.js            BUG 01 null/undefined access
export function computeTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  return Math.round(total * 100) / 100;
}
