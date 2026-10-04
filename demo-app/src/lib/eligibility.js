// eligibility.js      BUG 09 wrong conditional (policy: >= $50 AND loyalty member)
export function isEligibleForFreeShipping(orderTotal, isLoyaltyMember) {
  return orderTotal >= 50 || isLoyaltyMember;
}
