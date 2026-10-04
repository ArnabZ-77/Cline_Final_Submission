// discount.js         BUG 03 wrong type conversion
export function parseDiscountPercent(raw) {
  const pct = parseInt(raw, 10);
  if (Number.isNaN(pct) || pct < 0 || pct > 100) {
    throw new RangeError(`invalid discount percent: ${raw}`);
  }
  return pct;
}

export function applyDiscount(price, discountRaw) {
  const pct = parseDiscountPercent(discountRaw);
  return Math.round(price * (1 - pct / 100) * 100) / 100;
}
