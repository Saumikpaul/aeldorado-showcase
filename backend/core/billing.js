// core/billing.js — Subscription Billing & Usage Tracking
// Aeldorado by Solanacy Technologies
//
// - Tier definitions with 28-day subscription cycles
// - Developer plan STRICTLY locked to saumikpaul66@gmail.com
// - Subscription expiry enforcement
// - Usage tracking (rolling 5-hour / 7-day / 28-day windows — NOT calendar-based)

import { logger } from "./logger.js";
import { FieldValue } from "firebase-admin/firestore";

// ── DEVELOPER PLAN EMAIL GUARD ────────────────────────────────────────────────
// STRICTLY: Only this email can have the developer plan.
// Any other user with tier:"developer" in DB will be treated as "free".
export const DEVELOPER_PLAN_EMAIL = "saumikpaul66@gmail.com";

/**
 * Check if an email is allowed to use the developer plan.
 * @param {string} email
 * @returns {boolean}
 */
export function isAllowedDeveloperEmail(email) {
  return typeof email === "string" &&
    email.trim().toLowerCase() === DEVELOPER_PLAN_EMAIL.toLowerCase();
}

// ── Tier Definitions ──────────────────────────────────────────────────────────
/**
 * Subscription tier limits and pricing.
 *
 * NOTE: "daily" = rolling 5-hour window, "weekly" = rolling 7-day window,
 * "monthly" = rolling 28-day window. Field names kept as daily/weekly/monthly
 * for backward compatibility with routes/response shapes — but they are NOT
 * calendar-based anymore. Each window starts from the user's first request
 * in that window and expires exactly <duration> later. See getRollingWindows().
 *
 * ┌──────────────────┬──────────────────────┬────────┬────────┬─────────┐
 * │ Tier             │ Price                │ 5-hour │ 7-day  │ 28-day  │
 * ├──────────────────┼──────────────────────┼────────┼────────┼─────────┤
 * │ developer        │ ₹0 (locked to admin) │ ∞      │ ∞      │ ∞       │
 * │ free             │ ₹1 one-time activate │ 80     │ 1,000  │ 2,500   │
 * │ starter          │ ₹349/28 days         │ 250    │ 3,000  │ 7,500   │
 * │ growth           │ ₹599/28 days         │ 400    │ 5,500  │ 14,000  │
 * │ pro              │ ₹999/28 days         │ 550    │ 7,500  │ 18,500  │
 * │ enterprise_t1    │ ₹3,999/28 days       │ 1,500  │ 20,000 │ 45,000  │
 * │ enterprise_t2    │ ₹6,999/28 days       │ 3,000  │ 50,000 │ 125,000 │
 * └──────────────────┴──────────────────────┴────────┴────────┴─────────┘
 */
export const TIER_LIMITS = {
  // ── DEVELOPER PLAN — Strictly restricted to DEVELOPER_PLAN_EMAIL ──────────
  developer: {
    name:             "Developer",
    price:            0,
    activationFee:    0,
    billingDays:      null,        // Never expires
    daily:            Infinity,    // 5-hour window
    weekly:           Infinity,    // 7-day window
    monthly:          Infinity,    // 28-day window
    maxConversations: Infinity,
    restricted:       true,        // Cannot be assigned via billing — email guard only
  },

  free: {
    name:             "Free",
    price:            0,
    activationFee:    1,           // ₹1 one-time activation
    billingDays:      null,        // Free forever after activation
    daily:            80,          // 5-hour window
    weekly:           1_000,       // 7-day window
    monthly:          2_500,       // 28-day window
    maxConversations: 5,
  },

  starter: {
    name:             "Starter",
    price:            349,
    activationFee:    0,
    billingDays:      28,
    daily:            250,         // 5-hour window
    weekly:           3_000,       // 7-day window
    monthly:          7_500,       // 28-day window
    maxConversations: Infinity,
  },

  growth: {
    name:             "Growth",
    price:            599,
    activationFee:    0,
    billingDays:      28,
    daily:            400,         // 5-hour window
    weekly:           5_500,       // 7-day window
    monthly:          14_000,      // 28-day window
    maxConversations: Infinity,
  },

  pro: {
    name:             "Pro",
    price:            999,
    activationFee:    0,
    billingDays:      28,
    daily:            550,         // 5-hour window
    weekly:           7_500,       // 7-day window
    monthly:          18_500,      // 28-day window
    maxConversations: Infinity,
  },

  enterprise_t1: {
    name:             "Enterprise T1",
    price:            3_999,
    activationFee:    0,
    billingDays:      28,
    daily:            1_500,       // 5-hour window
    weekly:           20_000,      // 7-day window
    monthly:          45_000,      // 28-day window
    maxConversations: Infinity,
  },

  enterprise_t2: {
    name:             "Enterprise T2",
    price:            6_999,
    activationFee:    0,
    billingDays:      28,
    daily:            3_000,       // 5-hour window
    weekly:           50_000,      // 7-day window
    monthly:          125_000,     // 28-day window
    maxConversations: Infinity,
  },
};

// ── Rolling Window Helpers ─────────────────────────────────────────────────────
// Each usage window is NOT calendar-based. It starts on the user's first
// request and expires exactly <duration> later. When a window expires, the
// very next request starts a brand new window from that moment.
const WINDOW_5H_MS  = 5  * 60 * 60 * 1000;
const WINDOW_7D_MS  = 7  * 24 * 60 * 60 * 1000;
const WINDOW_28D_MS = 28 * 24 * 60 * 60 * 1000;

/**
 * Given a window's stored start timestamp (ISO string or null) and its
 * duration, determine whether the window is still active and how many
 * ms remain until it expires.
 *
 * @param {string|null} startIso - ISO timestamp the window began, or null/undefined
 * @param {number} durationMs
 * @param {number} now - current time in ms (Date.now())
 * @returns {{ active: boolean, msRemaining: number }}
 */
function getWindowState(startIso, durationMs, now) {
  if (!startIso) return { active: false, msRemaining: 0 };
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return { active: false, msRemaining: 0 };
  const elapsed = now - start;
  if (elapsed >= durationMs) return { active: false, msRemaining: 0 };
  return { active: true, msRemaining: durationMs - elapsed };
}

// ── Subscription Expiry ───────────────────────────────────────────────────────

/**
 * Check if a user's subscription is still valid.
 * - developer plan: always valid (email guard in auth)
 * - free plan: valid only if freeActivated === true
 * - paid plans: valid if subscriptionExpiry > now
 *
 * If expired, auto-downgrades user to "free" in Firestore.
 *
 * @param {object} db
 * @param {string} userId
 * @param {object} userData - User doc data (to avoid re-fetch)
 * @returns {Promise<{ valid: boolean, tier: string, reason?: string }>}
 */
export async function checkSubscriptionValid(db, userId, userData) {
  const tier  = userData?.tier  || "free";
  const email = userData?.email || "";

  // Admin suspension — checked before everything else, overrides all tiers
  // (including developer). Set/cleared via the admin portal (routes/admin.js).
  if (userData?.suspended === true) {
    return { valid: false, tier, reason: "account_suspended" };
  }

  // Developer plan — strictly email-gated
  if (tier === "developer") {
    if (!isAllowedDeveloperEmail(email)) {
      logger.warn("Developer plan access denied — email mismatch", { userId, email });
      // Force-downgrade this user
      await db.collection("users").doc(userId).update({
        tier:           "free",
        freeActivated:  false,
        downgradeReason: "developer_email_mismatch",
        downgradeAt:    new Date().toISOString(),
      }).catch(() => {});
      return { valid: false, tier: "free", reason: "developer_plan_restricted" };
    }
    return { valid: true, tier: "developer" };
  }

  // Free plan — requires one-time ₹1 activation
  if (tier === "free") {
    if (!userData?.freeActivated) {
      return { valid: false, tier: "free", reason: "free_plan_not_activated" };
    }
    return { valid: true, tier: "free" };
  }

  // Paid plans — check 28-day expiry
  const expiry = userData?.subscriptionExpiry;
  if (!expiry) {
    // No expiry set — downgrade to free
    await _downgradeToFree(db, userId, "no_expiry");
    return { valid: false, tier: "free", reason: "subscription_expired" };
  }

  const expiryDate = new Date(expiry);
  if (expiryDate <= new Date()) {
    // Expired — downgrade to free
    await _downgradeToFree(db, userId, "subscription_expired");
    logger.info("Subscription expired — downgraded to free", { userId, tier, expiry });
    return { valid: false, tier: "free", reason: "subscription_expired" };
  }

  return { valid: true, tier };
}

/**
 * Downgrade a user to free tier (without activation — they need to re-activate).
 * @private
 */
async function _downgradeToFree(db, userId, reason) {
  try {
    await db.collection("users").doc(userId).update({
      tier:                "free",
      freeActivated:       true,   // Keep free access — just lose paid features
      subscriptionExpiry:  null,
      previousTier:        null,
      downgradeReason:     reason,
      downgradeAt:         new Date().toISOString(),
    });
  } catch (e) {
    logger.error("Failed to downgrade user", { error: e.message, userId });
  }
}

/**
 * Activate/upgrade a user's subscription after successful payment.
 *
 * @param {object} db
 * @param {string} userId
 * @param {string} plan       - Tier key (e.g. "starter", "free")
 * @param {string} orderId    - Cashfree order ID
 * @param {string} paymentId  - Cashfree payment ID
 * @returns {Promise<void>}
 */
export async function activateSubscription(db, userId, plan, orderId, paymentId) {
  const tier   = TIER_LIMITS[plan];
  if (!tier) throw new Error(`Unknown plan: ${plan}`);
  if (tier.restricted) throw new Error("Developer plan cannot be activated via billing.");

  const now = new Date();
  let updateData = {
    tier:          plan,
    lastPaymentAt: now.toISOString(),
    lastOrderId:   orderId,
    lastPaymentId: paymentId,
    updatedAt:     now.toISOString(),
  };

  if (plan === "free") {
    // One-time activation — no expiry
    updateData.freeActivated      = true;
    updateData.subscriptionExpiry = null;
    updateData.freeActivatedAt    = now.toISOString();
  } else {
    // Paid plan — 28-day rolling window from now
    const expiry = new Date(now.getTime() + (tier.billingDays * 24 * 60 * 60 * 1000));
    updateData.subscriptionExpiry = expiry.toISOString();
    updateData.freeActivated      = true; // Paid users are always "activated"
  }

  await db.collection("users").doc(userId).update(updateData);

  // Record payment in billing history
  await db.collection("billing_history").add({
    userId,
    plan,
    orderId,
    paymentId,
    amount:    plan === "free" ? 1 : tier.price,
    paidAt:    now.toISOString(),
    expiresAt: updateData.subscriptionExpiry || null,
    status:    "paid",
  });

  logger.info("Subscription activated", { userId, plan, orderId });
}

// ── Batch Expiry Cleanup (for cron) ──────────────────────────────────────────
/**
 * Scan all users with paid tiers and downgrade expired ones.
 * Called by scripts/cron-cleanup.js.
 *
 * @param {object} db
 * @returns {Promise<number>} Count of downgraded users
 */
export async function downgradeExpiredSubscriptions(db) {
  const paidTiers = ["starter", "growth", "pro", "enterprise_t1", "enterprise_t2"];
  const now       = new Date().toISOString();
  let   count     = 0;

  try {
    // Find all paid-tier users whose subscription has expired
    for (const tier of paidTiers) {
      const snap = await db.collection("users")
        .where("tier", "==", tier)
        .where("subscriptionExpiry", "<=", now)
        .get();

      for (const doc of snap.docs) {
        await _downgradeToFree(db, doc.id, "subscription_expired_cron");
        count++;
        logger.info("Cron: Downgraded expired subscription", {
          userId: doc.id,
          tier,
          expiry: doc.data().subscriptionExpiry,
        });
      }
    }
  } catch (e) {
    logger.error("Expiry cleanup failed", { error: e.message });
  }

  return count;
}

// ── Usage Tracking ────────────────────────────────────────────────────────────

/**
 * Check if a user has remaining calls and return usage info.
 * Does NOT decrement — call `recordUsage()` after successful API call.
 *
 * Uses three independent rolling windows (5-hour / 7-day / 28-day), each
 * starting from the user's first request in that window — NOT calendar-based.
 *
 * @param {object} db
 * @param {string} userId
 * @param {string} tier
 * @returns {Promise<{ allowed: boolean, usage: object, limitType?: string }>}
 */
export async function checkUsage(db, userId, tier) {
  const limits = TIER_LIMITS[tier];
  if (!limits) return { allowed: false, usage: {}, limitType: "invalid_tier" };

  // Developer plan — unlimited
  if (limits.daily === Infinity) {
    return { allowed: true, usage: { daily: 0, weekly: 0, monthly: 0, tier } };
  }

  const now = Date.now();

  try {
    const usageRef  = db.collection("usage").doc(userId);
    const usageSnap = await usageRef.get();
    const data      = usageSnap.exists ? usageSnap.data() : {};

    const win5h  = getWindowState(data.dayStart   || data.dayKey,   WINDOW_5H_MS,  now);
    const win7d  = getWindowState(data.weekStart  || data.weekKey,  WINDOW_7D_MS,  now);
    const win28d = getWindowState(data.monthStart || data.monthKey, WINDOW_28D_MS, now);

    const daily   = win5h.active  ? (data.daily   || 0) : 0;
    const weekly  = win7d.active  ? (data.weekly  || 0) : 0;
    const monthly = win28d.active ? (data.monthly || 0) : 0;

    if (daily   >= limits.daily)   return { allowed: false, usage: { daily, weekly, monthly, tier }, limitType: "daily" };
    if (weekly  >= limits.weekly)  return { allowed: false, usage: { daily, weekly, monthly, tier }, limitType: "weekly" };
    if (monthly >= limits.monthly) return { allowed: false, usage: { daily, weekly, monthly, tier }, limitType: "monthly" };

    return {
      allowed: true,
      usage: {
        daily,
        weekly,
        monthly,
        dailyLimit:        limits.daily,
        weeklyLimit:       limits.weekly,
        monthlyLimit:      limits.monthly,
        dailyRemaining:    limits.daily   - daily,
        weeklyRemaining:   limits.weekly  - weekly,
        monthlyRemaining:  limits.monthly - monthly,
        dailyResetsInMs:   win5h.active  ? win5h.msRemaining  : null,
        weeklyResetsInMs:  win7d.active  ? win7d.msRemaining  : null,
        monthlyResetsInMs: win28d.active ? win28d.msRemaining : null,
        tier,
      },
    };
  } catch (e) {
    logger.error("Usage check failed", { error: e.message, userId });
    return tier === "free"
      ? { allowed: false, usage: {}, limitType: "error" }
      : { allowed: true,  usage: { tier } };
  }
}

/**
 * Record a successful API call — increment usage counters.
 *
 * Each of the three rolling windows (5-hour / 7-day / 28-day) is checked
 * independently: if the window has expired (or never started), a new window
 * begins now with count = 1. Otherwise the existing window's count is
 * incremented. Windows do NOT share a start time — a 7-day window keeps
 * running even if the 5-hour window resets in the meantime.
 *
 * @param {object} db
 * @param {string} userId
 */
export async function recordUsage(db, userId) {
  const nowIso = new Date().toISOString();
  const now    = Date.now();

  try {
    const usageRef  = db.collection("usage").doc(userId);
    const usageSnap = await usageRef.get();
    const data      = usageSnap.exists ? usageSnap.data() : {};

    let updateData = { lastCall: nowIso };

    const win5h  = getWindowState(data.dayStart   || data.dayKey,   WINDOW_5H_MS,  now);
    const win7d  = getWindowState(data.weekStart  || data.weekKey,  WINDOW_7D_MS,  now);
    const win28d = getWindowState(data.monthStart || data.monthKey, WINDOW_28D_MS, now);

    if (!win5h.active)  { updateData.dayStart   = nowIso; updateData.daily   = 1; }
    else                { updateData.daily      = FieldValue.increment(1); }

    if (!win7d.active)  { updateData.weekStart  = nowIso; updateData.weekly  = 1; }
    else                { updateData.weekly     = FieldValue.increment(1); }

    if (!win28d.active) { updateData.monthStart = nowIso; updateData.monthly = 1; }
    else                { updateData.monthly    = FieldValue.increment(1); }

    // Clear legacy calendar-key fields so old dayKey/weekKey/monthKey stop
    // being read once a window rolls over on the new schema.
    updateData.dayKey   = FieldValue.delete();
    updateData.weekKey  = FieldValue.delete();
    updateData.monthKey = FieldValue.delete();

    await usageRef.set(updateData, { merge: true });
  } catch (e) {
    logger.error("Usage recording failed", { error: e.message, userId });
  }
}

/**
 * Get full usage stats for a user (for /v1/usage and /v1/user/usage endpoints).
 *
 * @param {object} db
 * @param {string} userId
 * @param {string} tier
 * @returns {Promise<object>}
 */
export async function getUsageStats(db, userId, tier) {
  const limits      = TIER_LIMITS[tier];
  const { usage }   = await checkUsage(db, userId, tier);

  return {
    tier,
    tierName: limits?.name || tier,
    price:    limits?.price || 0,
    usage: {
      daily:   usage.daily   || 0,
      weekly:  usage.weekly  || 0,
      monthly: usage.monthly || 0,
    },
    limits: {
      daily:         limits?.daily   === Infinity ? "unlimited" : (limits?.daily   || 0),
      weekly:        limits?.weekly  === Infinity ? "unlimited" : (limits?.weekly  || 0),
      monthly:       limits?.monthly === Infinity ? "unlimited" : (limits?.monthly || 0),
      conversations: limits?.maxConversations === Infinity ? "unlimited" : (limits?.maxConversations ?? "unlimited"),
    },
    remaining: {
      daily:   limits?.daily   === Infinity ? "unlimited" : Math.max(0, (limits?.daily   || 0) - (usage.daily   || 0)),
      weekly:  limits?.weekly  === Infinity ? "unlimited" : Math.max(0, (limits?.weekly  || 0) - (usage.weekly  || 0)),
      monthly: limits?.monthly === Infinity ? "unlimited" : Math.max(0, (limits?.monthly || 0) - (usage.monthly || 0)),
    },
    resetsInMs: {
      daily:   usage.dailyResetsInMs   ?? null,
      weekly:  usage.weeklyResetsInMs  ?? null,
      monthly: usage.monthlyResetsInMs ?? null,
    },
    meta: { powered_by: "Aeldorado by Solanacy" },
  };
}

// Legacy compat
export function isDeveloperPlanActive() { return true; }

// ── Payment History (cursor-paginated, same pattern as getRequestLogs) ───────
/**
 * Fetch a user's paid/failed payment history from `pending_orders`, newest
 * first. Mirrors core/request-log.js getRequestLogs: fetch limit+1 to know
 * if there's a next page, cursor = ISO timestamp of last doc on prev page.
 *
 * @param {object} db
 * @param {string} userId
 * @param {object} options
 * @returns {Promise<{ history: Array, hasMore: boolean, nextCursor: string|null }>}
 */
export async function getPaymentHistory(db, userId, { limit = 3, startAfter = null } = {}) {
  try {
    let query = db.collection("pending_orders")
      .where("userId", "==", userId)
      .where("status", "in", ["paid", "failed"])
      .orderBy("createdAt", "desc");

    if (startAfter) {
      query = query.startAfter(startAfter);
    }

    query = query.limit(limit + 1); // fetch one extra to know if there's a next page

    const snap = await query.get();
    const docs = snap.docs.slice(0, limit);
    const hasMore = snap.docs.length > limit;

    const history = docs.map(doc => {
      const d = doc.data();
      return {
        orderId:       doc.id,
        plan:          d.plan,
        planName:      TIER_LIMITS[d.plan]?.name || d.plan,
        amount:        d.amount || 0,
        status:        d.status,
        transactionId: d.paymentId || null,
        date:          d.paidAt || d.failedAt || d.createdAt,
      };
    });

    const nextCursor = docs.length ? docs[docs.length - 1].data().createdAt : null;

    return { history, hasMore, nextCursor };
  } catch (e) {
    logger.error("Fetch payment history failed", { error: e.message, userId });
    return { history: [], hasMore: false, nextCursor: null };
  }
}
