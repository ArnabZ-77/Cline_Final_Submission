/**
 * The bug catalog the benchmark and the demo tooling share.
 *
 * - `source: "crash"`  — the bug throws in production; `crash.call(mod)` reproduces it.
 * - `source: "manual"` — the bug never throws; it is filed as a plain-English report.
 * - `golden`           — file name under `benchmark/golden/`, or null when the correct
 *                        outcome is "needs human" (the request contradicts an existing
 *                        test and must be escalated, not implemented).
 */

const json = (v) => JSON.stringify(v);

export const BUGS = [
  {
    id: "01",
    name: "total",
    category: "null-safety",
    file: "src/lib/total.js",
    golden: "01-total.test.js",
    source: "crash",
    crash: {
      call: (mod) =>
        mod.computeTotal([
          { price: 10, quantity: 2 },
          null,
          { price: 5, quantity: 1 },
        ]),
    },
    request: {
      method: "POST",
      path: "/api/orders/total",
      body: {
        items: [
          { price: 10, quantity: 2 },
          null,
          { price: 5, quantity: 1 },
        ],
      },
    },
    check: (status, body) => ({
      ok: status === 200 && body?.total === 25,
      got: `status ${status} total=${json(body?.total)}`,
      want: "200 total=25",
    }),
  },
  {
    id: "02",
    name: "profile",
    category: "null-safety",
    file: "src/lib/profile.js",
    golden: "02-profile.test.js",
    source: "crash",
    crash: { call: (mod) => mod.getUserCity({ name: "Rahul" }) },
    request: {
      method: "GET",
      path: "/api/users/1/city",
      query: { user: json({ name: "Rahul" }) },
    },
    check: (status, body) => ({
      ok: status === 200 && body?.city === undefined,
      got: `status ${status} body=${json(body)}`,
      want: "200 with city undefined",
    }),
  },
  {
    id: "03",
    name: "discount",
    category: "wrong-type-conversion",
    file: "src/lib/discount.js",
    golden: "03-discount.test.js",
    source: "manual",
    description:
      'Customers who type a fractional discount such as 12.5% are charged as if they entered 12%. ' +
      'applyDiscount(100, "12.5") should be 87.5, but we get 88. The percentage must keep its decimals.',
    request: { method: "POST", path: "/api/orders/discount", body: { price: 100, discount: "12.5" } },
    check: (status, body) => ({
      ok: status === 200 && body?.price === 87.5,
      got: `status ${status} price=${json(body?.price)}`,
      want: "200 price=87.5",
    }),
  },
  {
    id: "04",
    name: "refund",
    category: "wrong-type-conversion",
    file: "src/lib/refund.js",
    golden: "04-refund.test.js",
    source: "crash",
    crash: { call: (mod) => mod.calculateRefund("$19.99", "0") },
    request: { method: "GET", path: "/api/orders/refund", query: { amount: "$19.99", fee: "0" } },
    check: (status, body) => ({
      ok: status === 200 && body?.refund === 19.99,
      got: `status ${status} refund=${json(body?.refund)}`,
      want: "200 refund=19.99",
    }),
  },
  {
    id: "05",
    name: "pagination",
    category: "off-by-one",
    file: "src/lib/pagination.js",
    golden: "05-pagination.test.js",
    source: "manual",
    description:
      "The catalog page is one item short. Asking for page 0 with size 3 from [1,2,3,4,5,6] returns [1,2] " +
      "instead of [1,2,3]. Every page should hold exactly `size` items.",
    request: {
      method: "GET",
      path: "/api/catalog/page",
      query: { items: json([1, 2, 3, 4, 5, 6]), page: "0", size: "3" },
    },
    check: (status, body) => ({
      ok: status === 200 && json(body?.items) === json([1, 2, 3]),
      got: `status ${status} items=${json(body?.items)}`,
      want: `200 items=${json([1, 2, 3])}`,
    }),
  },
  {
    id: "06",
    name: "chunk",
    category: "off-by-one",
    file: "src/lib/chunk.js",
    golden: "06-chunk.test.js",
    source: "manual",
    description:
      "chunk([1,2,3,4], 2) returns [[1,2]] and loses the rest of the list. It should return [[1,2],[3,4]].",
    request: {
      method: "GET",
      path: "/api/catalog/chunk",
      query: { items: json([1, 2, 3, 4]), size: "2" },
    },
    check: (status, body) => ({
      ok: status === 200 && json(body?.chunks) === json([[1, 2], [3, 4]]),
      got: `status ${status} chunks=${json(body?.chunks)}`,
      want: `200 chunks=${json([[1, 2], [3, 4]])}`,
    }),
  },
  {
    id: "07",
    name: "signup",
    category: "missing-validation",
    file: "src/lib/signup.js",
    golden: "07-signup.test.js",
    source: "manual",
    description:
      "Signup accepts garbage. POSTing an empty email creates a user anyway; an address like " +
      '"not-an-email" is stored too. createUser must reject an empty or malformed email address.',
    request: { method: "POST", path: "/api/users/signup", body: { name: "Bad", email: "" } },
    check: (status) => ({ ok: status >= 400, got: `status ${status}`, want: "status >= 400" }),
  },
  {
    id: "08",
    name: "update",
    category: "missing-validation",
    file: "src/lib/update.js",
    golden: "08-update.test.js",
    source: "manual",
    description:
      "Changing an email address validates nothing. POSTing an empty body stores the literal text " +
      '"undefined" as the address. updateEmail must reject a missing or malformed email.',
    setup: {
      method: "POST",
      path: "/api/users/signup",
      body: { name: "Asha", email: "asha@example.com" },
    },
    request: { method: "POST", path: "/api/users/{id}/email", body: {} },
    check: (status) => ({ ok: status >= 400, got: `status ${status}`, want: "status >= 400" }),
  },
  {
    id: "09",
    name: "eligibility",
    category: "wrong-conditional",
    file: "src/lib/eligibility.js",
    golden: "09-eligibility.test.js",
    source: "manual",
    description:
      "Free shipping is being given to non-members with a big order. The policy is: order total >= $50 " +
      "AND the customer is a loyalty member. isEligibleForFreeShipping(500, false) must be false.",
    request: {
      method: "POST",
      path: "/api/billing/eligibility",
      body: { orderTotal: 500, isLoyaltyMember: false },
    },
    check: (status, body) => ({
      ok: status === 200 && body?.eligible === false,
      got: `status ${status} eligible=${json(body?.eligible)}`,
      want: "200 eligible=false",
    }),
  },
  {
    id: "10",
    name: "checkout",
    category: "wrong-conditional",
    file: "src/lib/checkout.js",
    golden: "10-checkout.test.js",
    source: "manual",
    description:
      "A cart with one out-of-stock item can still check out. Every item must be in stock, so " +
      "canCheckout([{inStock:true},{inStock:false}]) must be false.",
    request: {
      method: "POST",
      path: "/api/billing/checkout",
      body: { cart: [{ inStock: true }, { inStock: false }] },
    },
    check: (status, body) => ({
      ok: status === 200 && body?.canCheckout === false,
      got: `status ${status} canCheckout=${json(body?.canCheckout)}`,
      want: "200 canCheckout=false",
    }),
  },
  {
    id: "11",
    name: "conflict",
    category: "conflicting-request",
    file: "src/lib/checkout.js",
    golden: null,
    expect: "needs_human",
    source: "manual",
    description:
      "Product wants a placeholder order: an empty cart must be allowed to check out, so " +
      "canCheckout([]) should return true. Please change canCheckout to allow it.",
    request: null,
    check: null,
  },
];

/** Bugs PatchPilot is supposed to fix; the denominator of the fix rate. */
export const FIXABLE_BUGS = BUGS.filter((b) => b.expect !== "needs_human");

export function findBug(idOrPrefix) {
  const needle = String(idOrPrefix).toLowerCase();
  return BUGS.find((b) => b.id === needle || b.id.startsWith(needle) || b.name === needle);
}

export function selectBugs(prefix) {
  if (!prefix) return BUGS;
  const found = findBug(prefix);
  return found ? [found] : [];
}

