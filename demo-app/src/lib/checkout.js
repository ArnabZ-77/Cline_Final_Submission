// checkout.js         BUG 10 wrong conditional (every item must be in stock)
export function canCheckout(cart) {
  if (cart.length === 0) return false;
  return cart.some((item) => item.inStock);
}
