/**
 * demo-app: a deliberately buggy Express shop.
 *
 * Errors are reported to PatchPilot by the capture middleware, which is registered after
 * the routes so it sees every thrown error, then a final handler answers 500.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchpilotMiddleware } from "../sdk/patchpilot-express.js";
import { computeTotal } from "./src/lib/total.js";
import { getUserCity } from "./src/lib/profile.js";
import { applyDiscount } from "./src/lib/discount.js";
import { calculateRefund } from "./src/lib/refund.js";
import { paginate } from "./src/lib/pagination.js";
import { chunk } from "./src/lib/chunk.js";
import { createUser, getUser } from "./src/lib/signup.js";
import { updateEmail } from "./src/lib/update.js";
import { isEligibleForFreeShipping } from "./src/lib/eligibility.js";
import { canCheckout } from "./src/lib/checkout.js";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_PORT || "5050");
const ENDPOINT = process.env.PATCHPILOT_ENDPOINT || "http://localhost:4747/api/incidents";
const REPO = process.env.PATCHPILOT_REPO || process.env.DEMO_REPO || "demo-app";

const app = express();
app.use(express.json({ limit: "1mb" }));

/** A thrown error inside a handler becomes `next(err)` and is reported. */
const wrap = (fn) => (req, res, next) => {
  try {
    fn(req, res, next);
  } catch (err) {
    next(err);
  }
};

app.get("/healthz", wrap((_req, res) => res.json({ ok: true })));

app.post(
  "/api/orders/total",
  wrap((req, res) => {
    const items = req.body?.items ?? [];
    res.json({ total: computeTotal(items) });
  })
);

app.get(
  "/api/users/:id/city",
  wrap((req, res) => {
    const user = JSON.parse(String(req.query.user ?? "{}"));
    res.json({ city: getUserCity(user) });
  })
);

app.post(
  "/api/orders/discount",
  wrap((req, res) => {
    const price = applyDiscount(req.body?.price, req.body?.discount);
    res.json({ price });
  })
);

app.get(
  "/api/orders/refund",
  wrap((req, res) => {
    res.json({ refund: calculateRefund(req.query.amount, req.query.fee) });
  })
);

app.get(
  "/api/catalog/page",
  wrap((req, res) => {
    const items = JSON.parse(String(req.query.items ?? "[]"));
    res.json({ items: paginate(items, Number(req.query.page ?? 0), Number(req.query.size ?? 10)) });
  })
);

app.get(
  "/api/catalog/chunk",
  wrap((req, res) => {
    const items = JSON.parse(String(req.query.items ?? "[]"));
    res.json({ chunks: chunk(items, Number(req.query.size ?? 2)) });
  })
);

app.post(
  "/api/users/signup",
  wrap((req, res) => {
    res.status(201).json(createUser(req.body ?? {}));
  })
);

app.post(
  "/api/users/:id/email",
  wrap((req, res) => {
    res.json(updateEmail(Number(req.params.id), req.body?.email));
  })
);

app.get(
  "/api/users/:id",
  wrap((req, res) => {
    res.json(getUser(Number(req.params.id)));
  })
);

app.post(
  "/api/billing/eligibility",
  wrap((req, res) => {
    const { orderTotal, isLoyaltyMember } = req.body ?? {};
    res.json({ eligible: isEligibleForFreeShipping(orderTotal, isLoyaltyMember) });
  })
);

app.post(
  "/api/billing/checkout",
  wrap((req, res) => {
    res.json({ canCheckout: canCheckout(req.body?.cart ?? []) });
  })
);

// Registered after the routes so it captures everything the routes throw.
app.use(patchpilotMiddleware({ endpoint: ENDPOINT, repo: REPO, root: APP_DIR }));

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message });
});

app.listen(PORT, (err) => {
  if (err) {
    console.error(`could not start on port ${PORT}: ${err.code ?? err.message}`);
    process.exit(1);
  }
  console.log(`demo-app listening on http://localhost:${PORT}`);
  console.log(`reporting crashes to ${ENDPOINT} as repo "${REPO}"`);
});
