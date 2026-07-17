// core/cashfree.js — Cashfree Payment Gateway Client
// Aeldorado by Solanacy Technologies
//
// Handles: order creation, payment status fetch, webhook HMAC verification.
// Uses Cashfree PG API v2022-09-01 (production).

import crypto from "crypto";
import { logger } from "./logger.js";

// ── Config ────────────────────────────────────────────────────────────────────
const CF_APP_ID    = process.env.CASHFREE_APP_ID;
const CF_SECRET    = process.env.CASHFREE_SECRET_KEY;
const CF_ENV       = process.env.CASHFREE_ENV || "production";
const CF_BASE      = CF_ENV === "production"
  ? "https://api.cashfree.com/pg"
  : "https://sandbox.cashfree.com/pg";
const CF_VERSION   = "2023-08-01";

// ── Internal request helper ───────────────────────────────────────────────────
async function cfRequest(method, path, body = null) {
  if (!CF_APP_ID || !CF_SECRET) {
    throw new Error("Cashfree credentials not configured. Set CASHFREE_APP_ID and CASHFREE_SECRET_KEY.");
  }

  const headers = {
    "Content-Type":    "application/json",
    "x-api-version":   CF_VERSION,
    "x-client-id":     CF_APP_ID,
    "x-client-secret": CF_SECRET,
  };

  const opts = { method, headers };
  if (body && method !== "GET") opts.body = JSON.stringify(body);

  const res = await fetch(`${CF_BASE}${path}`, opts);
  const data = await res.json();

  if (!res.ok) {
    logger.error("Cashfree API error", { status: res.status, data, path });
    throw new Error(data?.message || `Cashfree error ${res.status}`);
  }

  return data;
}

// ── Create Order ──────────────────────────────────────────────────────────────
/**
 * Create a Cashfree payment order.
 *
 * @param {object} params
 * @param {string} params.orderId        - Unique order ID (our internal ID)
 * @param {number} params.amount         - Amount in INR (e.g. 349)
 * @param {string} params.customerName
 * @param {string} params.customerEmail
 * @param {string} params.customerPhone  - Required by Cashfree (use placeholder if missing)
 * @param {string} params.returnUrl      - Frontend redirect after payment
 * @param {object} params.meta           - Extra metadata stored in order_meta
 * @returns {Promise<object>}            - Cashfree order object (includes payment_session_id)
 */
export async function createCashfreeOrder({ orderId, amount, customerName, customerEmail, customerPhone, returnUrl, meta = {} }) {
  const payload = {
    order_id:       orderId,
    order_amount:   amount,
    order_currency: "INR",
    customer_details: {
      customer_id:    customerEmail.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50),
      customer_name:  customerName  || "Aeldorado User",
      customer_email: customerEmail,
      customer_phone: customerPhone || "9999999999", // Cashfree requires phone
    },
    order_meta: {
      return_url:   returnUrl,
      notify_url:   `${process.env.API_BASE_URL || "https://api.aeldorado.solanacy.in"}/v1/billing/webhook`,
      ...meta,
    },
    order_note: `Aeldorado subscription — ${meta.plan || "free"}`,
  };

  logger.info("Creating Cashfree order", { orderId, amount, plan: meta.plan });
  return await cfRequest("POST", "/orders", payload);
}

// ── Fetch Order Details ───────────────────────────────────────────────────────
/**
 * Fetch order + payment status from Cashfree.
 *
 * @param {string} orderId
 * @returns {Promise<object>}
 */
export async function getCashfreeOrder(orderId) {
  return await cfRequest("GET", `/orders/${orderId}`);
}

// ── Fetch Payments for Order ─────────────────────────────────────────────────
/**
 * Get all payment attempts for a given order.
 *
 * @param {string} orderId
 * @returns {Promise<Array>}
 */
export async function getCashfreePayments(orderId) {
  const data = await cfRequest("GET", `/orders/${orderId}/payments`);
  return Array.isArray(data) ? data : [];
}

// ── Webhook Signature Verification ───────────────────────────────────────────
/**
 * Verify Cashfree webhook signature (HMAC-SHA256).
 * Cashfree sends:
 *   x-webhook-signature  — base64(HMAC-SHA256(timestamp + rawBody, secret))
 *   x-webhook-timestamp  — Unix timestamp string
 *
 * @param {string} rawBody      - Raw request body string (before JSON.parse)
 * @param {string} signature    - Value of x-webhook-signature header
 * @param {string} timestamp    - Value of x-webhook-timestamp header
 * @returns {boolean}
 */
export function verifyCashfreeWebhook(rawBody, signature, timestamp) {
  if (!CF_SECRET || !signature || !timestamp) return false;

  try {
    const payload  = timestamp + rawBody;
    const expected = crypto
      .createHmac("sha256", CF_SECRET)
      .update(payload)
      .digest("base64");

    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch (e) {
    logger.error("Webhook signature verification failed", { error: e.message });
    return false;
  }
}

// ── Generate Internal Order ID ────────────────────────────────────────────────
/**
 * Generate a unique Cashfree-compatible order ID.
 * Format: ALD_<userId_prefix>_<timestamp>_<random>
 *
 * @param {string} userId
 * @param {string} plan
 * @returns {string}
 */
export function generateOrderId(userId, plan) {
  const prefix    = userId.slice(0, 8);
  const timestamp = Date.now();
  const random    = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ALD_${prefix}_${plan}_${timestamp}_${random}`;
}
