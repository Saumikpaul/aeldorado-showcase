// routes/billing.js — Cashfree Payment & Subscription Routes
// Aeldorado by Solanacy Technologies
//
// POST /v1/billing/create-order  — Create a Cashfree payment order
// POST /v1/billing/verify        — Verify payment after return (frontend poll)
// POST /v1/billing/webhook       — Cashfree webhook (HMAC-verified, no Firebase auth)
// GET  /v1/billing/status        — Current subscription status
// GET  /v1/billing/history       — Paid/failed payment history (paginated)

import { Router }    from "express";
import { sendError } from "../core/errors.js";
import { logger }    from "../core/logger.js";
import {
  createCashfreeOrder,
  getCashfreeOrder,
  getCashfreePayments,
  verifyCashfreeWebhook,
  generateOrderId,
} from "../core/cashfree.js";
import {
  TIER_LIMITS,
  activateSubscription,
  checkSubscriptionValid,
  isAllowedDeveloperEmail,
  getPaymentHistory,
} from "../core/billing.js";
import { getUserDoc } from "../core/user-manager.js";

export const billingRouter = Router();

// ── POST /v1/billing/create-order ────────────────────────────────────────────
/**
 * Create a Cashfree payment order for a subscription plan.
 * Requires Firebase auth (dashboard users only).
 *
 * Body: { plan: "free" | "starter" | "growth" | "pro" | "enterprise_t1" | "enterprise_t2" }
 */
billingRouter.post("/billing/create-order", async (req, res) => {
  if (!req.userId) return sendError(res, "AUTH_REQUIRED");

  const { plan } = req.body;

  // Validate plan
  if (!plan || !TIER_LIMITS[plan]) {
    return res.status(400).json({ error: { code: "invalid_plan", message: "Invalid plan specified." } });
  }

  // Developer plan cannot be purchased
  if (plan === "developer") {
    return res.status(403).json({ error: { code: "plan_restricted", message: "Developer plan is not available for purchase." } });
  }

  try {
    const userDoc = await getUserDoc(req.db, req.userId);
    if (!userDoc) return sendError(res, "AUTH_REQUIRED");

    const email = userDoc.email || "";
    const name  = userDoc.displayName || "Aeldorado User";

    // Determine amount
    const tier   = TIER_LIMITS[plan];
    const amount = plan === "free" ? tier.activationFee : tier.price; // ₹1 for free, full price for paid

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: { code: "invalid_amount", message: "Invalid plan amount." } });
    }

    // Check if free plan already activated
    if (plan === "free" && userDoc.freeActivated === true) {
      return res.status(400).json({ error: { code: "already_activated", message: "Free plan is already activated." } });
    }

    // Generate order
    const orderId = generateOrderId(req.userId, plan);

    // Store pending order in Firestore (to map orderId → userId on webhook)
    await req.db.collection("pending_orders").doc(orderId).set({
      userId:    req.userId,
      plan,
      amount,
      email,
      createdAt: new Date().toISOString(),
      status:    "pending",
    });

    // Create Cashfree order
    const cfOrder = await createCashfreeOrder({
      orderId,
      amount,
      customerName:  name,
      customerEmail: email,
      returnUrl:     `${process.env.FRONTEND_URL || "https://aeldorado.solanacy.in"}/app/${req.userId}/billing?order_id=${orderId}`,
      meta: { plan, userId: req.userId },
    });

    res.json({
      orderId,
      paymentSessionId: cfOrder.payment_session_id,
      amount,
      plan,
      planName:  tier.name,
      cfOrderId: cfOrder.order_id,
    });

  } catch (e) {
    logger.error("Create order failed", { error: e.message, userId: req.userId });
    sendError(res, "SERVER_ERROR", e.message);
  }
});

// ── POST /v1/billing/verify ───────────────────────────────────────────────────
/**
 * Verify a payment after the user returns from Cashfree checkout.
 * Frontend calls this after payment flow completes.
 *
 * Body: { orderId: string }
 */
billingRouter.post("/billing/verify", async (req, res) => {
  if (!req.userId) return sendError(res, "AUTH_REQUIRED");

  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: { code: "missing_order_id", message: "orderId is required." } });

  try {
    // Verify this order belongs to the authenticated user
    const pendingSnap = await req.db.collection("pending_orders").doc(orderId).get();
    if (!pendingSnap.exists) {
      return res.status(404).json({ error: { code: "order_not_found", message: "Order not found." } });
    }
    const pending = pendingSnap.data();
    if (pending.userId !== req.userId) {
      return res.status(403).json({ error: { code: "order_mismatch", message: "Order does not belong to this user." } });
    }

    // Fetch payment status from Cashfree
    const payments = await getCashfreePayments(orderId);
    const successPayment = payments.find(p => p.payment_status === "SUCCESS");

    if (!successPayment) {
      return res.json({ paid: false, status: payments[0]?.payment_status || "PENDING", orderId });
    }

    // Already processed?
    if (pending.status === "paid") {
      return res.json({ paid: true, plan: pending.plan, orderId, alreadyProcessed: true });
    }

    // Activate subscription
    await activateSubscription(
      req.db,
      req.userId,
      pending.plan,
      orderId,
      successPayment.cf_payment_id?.toString() || ""
    );

    // Mark order as paid
    await req.db.collection("pending_orders").doc(orderId).update({
      status:     "paid",
      paidAt:     new Date().toISOString(),
      paymentId:  successPayment.cf_payment_id?.toString() || "",
    });

    res.json({ paid: true, plan: pending.plan, planName: TIER_LIMITS[pending.plan]?.name, orderId });

  } catch (e) {
    logger.error("Payment verify failed", { error: e.message, userId: req.userId, orderId });
    sendError(res, "SERVER_ERROR", e.message);
  }
});

// ── POST /v1/billing/webhook ──────────────────────────────────────────────────
/**
 * Cashfree webhook — called by Cashfree on payment events.
 * No Firebase auth. Secured by HMAC-SHA256 signature verification.
 *
 * NOTE: This route needs raw body access — mounted before express.json()
 * via captureRawBody middleware in server.js.
 */
billingRouter.post("/billing/webhook", async (req, res) => {
  const signature = req.headers["x-webhook-signature"];
  const timestamp = req.headers["x-webhook-timestamp"];
  const rawBody   = req.rawBody || JSON.stringify(req.body);

  // ── Signature verification ────────────────────────────────────────────────
  if (!verifyCashfreeWebhook(rawBody, signature, timestamp)) {
    logger.warn("Webhook signature verification failed", { signature, timestamp });
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  let payload;
  try {
    payload = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
  } catch {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  const eventType = payload?.type;
  const data      = payload?.data;

  logger.info("Cashfree webhook received", { eventType });

  // ── Handle payment.success ────────────────────────────────────────────────
  if (eventType === "PAYMENT_SUCCESS_WEBHOOK" || eventType === "payment_success") {
    try {
      const orderId   = data?.order?.order_id;
      const paymentId = data?.payment?.cf_payment_id?.toString() || "";

      if (!orderId) {
        logger.warn("Webhook: missing order_id in payload");
        return res.json({ received: true });
      }

      const pendingSnap = await req.db.collection("pending_orders").doc(orderId).get();
      if (!pendingSnap.exists) {
        logger.warn("Webhook: order not found in pending_orders", { orderId });
        return res.json({ received: true });
      }

      const pending = pendingSnap.data();
      if (pending.status === "paid") {
        // Already processed (verify endpoint got there first) — idempotent OK
        return res.json({ received: true, note: "already_processed" });
      }

      // Activate subscription
      await activateSubscription(req.db, pending.userId, pending.plan, orderId, paymentId);

      // Mark order as paid
      await req.db.collection("pending_orders").doc(orderId).update({
        status:    "paid",
        paidAt:    new Date().toISOString(),
        paymentId,
      });

      logger.info("Webhook: subscription activated", { orderId, userId: pending.userId, plan: pending.plan });

    } catch (e) {
      logger.error("Webhook payment processing failed", { error: e.message });
      // Return 200 to Cashfree so it doesn't retry (we log for manual fix)
    }
  }

  // ── Handle payment.failed ─────────────────────────────────────────────────
  if (eventType === "PAYMENT_FAILED_WEBHOOK" || eventType === "payment_failed") {
    try {
      const orderId = data?.order?.order_id;
      if (orderId) {
        await req.db.collection("pending_orders").doc(orderId).update({
          status:   "failed",
          failedAt: new Date().toISOString(),
        }).catch(() => {});
        logger.info("Webhook: payment failed", { orderId });
      }
    } catch (e) {
      logger.error("Webhook failed payment handling error", { error: e.message });
    }
  }

  // Always respond 200 to Cashfree
  res.json({ received: true });
});

// ── GET /v1/billing/status ────────────────────────────────────────────────────
/**
 * Get the current user's subscription status.
 * Returns tier, expiry, activation status, and plan details.
 */
billingRouter.get("/billing/status", async (req, res) => {
  if (!req.userId) return sendError(res, "AUTH_REQUIRED");

  try {
    const userDoc = await getUserDoc(req.db, req.userId);
    if (!userDoc) return sendError(res, "AUTH_REQUIRED");

    const { valid, tier: effectiveTier, reason } = await checkSubscriptionValid(req.db, req.userId, userDoc);
    const tierInfo = TIER_LIMITS[effectiveTier] || TIER_LIMITS.free;

    res.json({
      tier:               effectiveTier,
      tierName:           tierInfo.name,
      price:              tierInfo.price,
      billingDays:        tierInfo.billingDays,
      subscriptionValid:  valid,
      subscriptionReason: reason || null,
      freeActivated:      userDoc.freeActivated || false,
      subscriptionExpiry: userDoc.subscriptionExpiry || null,
      lastPaymentAt:      userDoc.lastPaymentAt || null,
      lastOrderId:        userDoc.lastOrderId   || null,
      plans: Object.entries(TIER_LIMITS)
        .filter(([key]) => key !== "developer")
        .map(([key, t]) => ({
          id:           key,
          name:         t.name,
          price:        t.price,
          activationFee:t.activationFee || 0,
          billingDays:  t.billingDays,
          limits: {
            daily:   t.daily   === Infinity ? "unlimited" : t.daily,
            weekly:  t.weekly  === Infinity ? "unlimited" : t.weekly,
            monthly: t.monthly === Infinity ? "unlimited" : t.monthly,
          },
        })),
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    logger.error("Billing status failed", { error: e.message, userId: req.userId });
    sendError(res, "SERVER_ERROR", e.message);
  }
});

// ── GET /v1/billing/history ───────────────────────────────────────────────────
/**
 * Get the current user's payment history (paid/failed orders), paginated.
 * Cursor pagination, same pattern as GET /v1/logs.
 *
 * Query: ?limit=3&cursor=<ISO timestamp of last doc on prev page>
 */
billingRouter.get("/billing/history", async (req, res) => {
  if (!req.userId) return sendError(res, "AUTH_REQUIRED");

  const limit     = Math.min(parseInt(req.query.limit) || 3, 20);
  const startAfter = req.query.cursor || null;

  try {
    const result = await getPaymentHistory(req.db, req.userId, { limit, startAfter });
    res.json({ ...result, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    logger.error("Billing history failed", { error: e.message, userId: req.userId });
    sendError(res, "SERVER_ERROR", e.message);
  }
});
