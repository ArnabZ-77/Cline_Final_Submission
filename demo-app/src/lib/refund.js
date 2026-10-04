// refund.js           BUG 04 wrong type conversion
export function calculateRefund(amountStr, feeStr) {
  const amount = Number(amountStr);
  const fee = Number(feeStr);
  if (Number.isNaN(amount) || Number.isNaN(fee)) {
    throw new RangeError(`invalid refund inputs: amount=${amountStr} fee=${feeStr}`);
  }
  return Math.round((amount - fee) * 100) / 100;
}
