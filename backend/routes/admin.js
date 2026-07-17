// routes/admin.js — Internal Admin Portal API
// Aeldorado by Solanacy Technologies
//
// Mounted at /v1/admin/* in server.js, behind BOTH dashboardAuth (Firebase
// token verification) AND requireSuperAdmin (hardcoded email gate). Every
// route here is implicitly locked to [REDACTED — admin email not included in public showcase] — see
// core/admin-auth.js for the enforcement. Do not add auth checks per-route;
// the router-level mount is the single source of truth so nothing can be
// added later and accidentally skip the gate.

import { Router } from "express";
import { FieldPath } from "firebase-admin/firestore";
import { sendError } from "../core/errors.js";
import { DEVELOPER_PLAN_EMAIL, TIER_LIMITS, isAllowedDeveloperEmail, getPaymentHistory } from "../core/billing.js";
import { getUserDoc } from "../core/user-manager.js";
import { getRequestLogs, getUsageAnalytics } from "../core/request-log.js";
import { logger } from "../core/logger.js";
import { cached, invalidatePrefix } from "../core/admin-cache.js";
import {
  createPost, updatePost, deletePost,
  getPostForAdmin, listPostsForAdmin, CATEGORIES,
} from "../core/news-manager.js";

export const adminRouter = Router();

/**
 * GET /v1/admin/whoami — Confirms admin session is valid.
 * Used by the admin frontend right after login to verify the gate passed
 * (if this 200s, requireSuperAdmin already let the request through).
 */
adminRouter.get("/admin/whoami", async (req, res) => {
  res.json({
    email: req.decodedToken.email,
    uid: req.userId,
    admin: true,
    meta: { powered_by: "Aeldorado by Solanacy" },
  });
});

/**
 * GET /v1/admin/overview — Top-level dashboard stats.
 * Total users by tier, total requests today, error rate, etc.
 *
 * Uses Firestore count() aggregation queries instead of downloading every
 * doc — a plain .get() on "users" or on today's request_logs re-reads and
 * transfers every field of every matching doc just to tally a number, which
 * gets slower (and more expensive) as those collections grow. count() runs
 * server-side and returns just the number.
 */
adminRouter.get("/admin/overview", async (req, res) => {
  try {
    const db = req.db;

    const payload = await cached("overview", 30_000, async () => {
      // Total users — cheap server-side count, no doc download.
      const totalUsersSnap = await db.collection("users").count().get();
      const totalUsers = totalUsersSnap.data().count;

      // Per-tier counts — one count() per known tier, run in parallel.
      // Still far cheaper than downloading every user doc: each count() reads
      // zero document fields, just an index scan.
      const tierKeys = Object.keys(TIER_LIMITS);
      const tierCountSnaps = await Promise.all(
        tierKeys.map((tier) => db.collection("users").where("tier", "==", tier).count().get())
      );
      const tierCounts = {};
      tierKeys.forEach((tier, i) => {
        const count = tierCountSnaps[i].data().count;
        if (count > 0) tierCounts[tier] = count;
      });

      const todayKey = new Date().toISOString().slice(0, 10);
      const todayLogsCol = db.collection("request_logs").where("dayKey", "==", todayKey);

      // Today's totals — count() for requests/success/errors (no doc reads),
      // but token totals genuinely need summing across docs, so that one still
      // downloads today's rows. Firestore's sum() aggregation isn't in this
      // admin SDK version yet, so this is the one query that scales with
      // today's traffic — acceptable since it resets daily and is bounded to
      // a single day, not the whole collection.
      const [totalSnap, successSnap, tokensSnap] = await Promise.all([
        todayLogsCol.count().get(),
        todayLogsCol.where("status", "==", "success").count().get(),
        todayLogsCol.select("tokens").get(),
      ]);

      const totalToday = totalSnap.data().count;
      const successCount = successSnap.data().count;
      const errorCount = totalToday - successCount;
      const totalTokens = tokensSnap.docs.reduce((sum, doc) => sum + (doc.data().tokens?.total || 0), 0);

      return {
        totalUsers,
        tierCounts,
        today: {
          requests: totalToday,
          success: successCount,
          errors: errorCount,
          totalTokens,
        },
        meta: { powered_by: "Aeldorado by Solanacy" },
      };
    });

    res.json(payload);
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * Resolve a named range keyword into [startISO, endISO) boundaries.
 * endISO is exclusive (i.e. "< endISO"), startISO inclusive ("&gt;= startISO").
 * "all_time" returns null bounds — caller should skip the date filter entirely.
 */
function getDateRange(range) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

  const todayStart = startOfDay(now);

  switch (range) {
    case "today":
      return { start: todayStart, end: addDays(todayStart, 1) };
    case "yesterday": {
      const y = addDays(todayStart, -1);
      return { start: y, end: todayStart };
    }
    case "this_week": {
      // Week starts Monday
      const dow = (now.getDay() + 6) % 7; // 0 = Monday
      const weekStart = addDays(todayStart, -dow);
      return { start: weekStart, end: addDays(todayStart, 1) };
    }
    case "last_week": {
      const dow = (now.getDay() + 6) % 7;
      const thisWeekStart = addDays(todayStart, -dow);
      const lastWeekStart = addDays(thisWeekStart, -7);
      return { start: lastWeekStart, end: thisWeekStart };
    }
    case "this_month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start, end: addDays(todayStart, 1) };
    }
    case "last_month": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start, end };
    }
    case "all_time":
    default:
      return { start: null, end: null };
  }
}

/**
 * GET /v1/admin/revenue — Revenue overview: MRR, paid-orders total for a
 * selectable date range, plan-wise breakdown, and recent failed payments.
 *
 * Query: ?range= one of today | yesterday | this_week | last_week |
 *        this_month | last_month | all_time (default: this_month)
 *
 * MRR here means "sum of price for every user currently on a paid,
 * non-expired tier" (a snapshot metric) — it does NOT change with the
 * range filter, since "recurring monthly revenue right now" isn't a
 * date-ranged concept. Everything else (paid orders total/count, the
 * Free-tier activation row) is scoped to the selected range so the UI
 * numbers stay internally consistent instead of mixing an all-time
 * figure against a this-month figure.
 *
 * Reads: one count() per paid tier (cheap) for MRR, plus range-bounded
 * queries on pending_orders for paid orders in range, Free activations
 * in range, and the last 20 failed orders (unscoped by range — recent
 * failures are useful regardless of the selected window).
 */
adminRouter.get("/admin/revenue", async (req, res) => {
  try {
    const db = req.db;
    const range = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "all_time"]
      .includes(req.query.range) ? req.query.range : "this_month";

    const payload = await cached(`revenue:${range}`, 30_000, async () => {
      const { start, end } = getDateRange(range);

      const paidTierKeys = Object.keys(TIER_LIMITS).filter(
        (t) => !TIER_LIMITS[t].restricted && TIER_LIMITS[t].price > 0
      );

      // ── MRR: current paid-tier user counts × price (range-independent) ──────
      const tierCountSnaps = await Promise.all(
        paidTierKeys.map((tier) => db.collection("users").where("tier", "==", tier).count().get())
      );
      const planBreakdown = paidTierKeys.map((tier, i) => {
        const count = tierCountSnaps[i].data().count;
        const price = TIER_LIMITS[tier].price;
        return {
          plan: tier,
          planName: TIER_LIMITS[tier].name,
          activeUsers: count,
          price,
          monthlyRevenue: count * price,
        };
      });
      const mrr = planBreakdown.reduce((sum, p) => sum + p.monthlyRevenue, 0);

      // ── Paid orders in the selected range (all plans, including free) ───────
      let paidOrdersQuery = db.collection("pending_orders").where("status", "==", "paid");
      if (start) paidOrdersQuery = paidOrdersQuery.where("paidAt", ">=", start.toISOString());
      if (end) paidOrdersQuery = paidOrdersQuery.where("paidAt", "<", end.toISOString());
      const paidOrdersSnap = await paidOrdersQuery.get();
      const paidOrders = paidOrdersSnap.docs.map((d) => d.data());

      const rangeTotal = paidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);
      const rangeCount = paidOrders.length;

      // ── Free tier: ₹1 one-time activation, not a recurring subscription ─────
      // Kept out of MRR (it's not "monthly recurring"), shown as its own
      // breakdown row scoped to the same range as everything else, sourced
      // from real paid orders (not activeUsers × listed price, since Free's
      // listed price is ₹0 while the real charge is the activationFee).
      const freeUserCountSnap = await db.collection("users").where("tier", "==", "free").count().get();
      const freeActiveUsers = freeUserCountSnap.data().count;
      const freeOrdersInRange = paidOrders.filter((o) => o.plan === "free");
      const freeActivationRevenue = freeOrdersInRange.reduce((sum, o) => sum + (o.amount || 0), 0);
      const freeBreakdown = {
        plan: "free",
        planName: TIER_LIMITS.free.name,
        activeUsers: freeActiveUsers,
        price: TIER_LIMITS.free.activationFee, // ₹1, one-time — not a recurring price
        activationCount: freeOrdersInRange.length, // activations paid within the selected range
        monthlyRevenue: freeActivationRevenue,      // revenue collected within the selected range
        oneTime: true,                              // flag so frontend can label it distinctly from MRR
      };
      planBreakdown.unshift(freeBreakdown);

      // ── Recent failed payments (last 20, unscoped by range) ─────────────────
      const failedSnap = await db.collection("pending_orders")
        .where("status", "==", "failed")
        .orderBy("createdAt", "desc")
        .limit(20)
        .get();

      const failedPayments = failedSnap.docs.map((doc) => {
        const d = doc.data();
        return {
          orderId: doc.id,
          userId: d.userId || null,
          plan: d.plan,
          planName: TIER_LIMITS[d.plan]?.name || d.plan,
          amount: d.amount || 0,
          failedAt: d.failedAt || d.createdAt,
          reason: d.failureReason || d.errorCode || null,
        };
      });

      return {
        range,
        mrr,
        paidInRange: { total: rangeTotal, orderCount: rangeCount },
        planBreakdown,
        failedPayments,
        meta: { powered_by: "Aeldorado by Solanacy" },
      };
    });

    res.json(payload);
  } catch (e) {
    if (e.message?.includes("index")) {
      logger.error("Admin revenue query needs a Firestore composite index", { error: e.message });
      return sendError(res, "SERVER_ERROR", "This query needs a Firestore index. Check server logs for the index-creation link.");
    }
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/admin/errors/recent — Last 20 failed request_logs across all
 * users, for the overview page's "recent errors" widget. Distinct from
 * /admin/logs (which is the full filterable log viewer) — this is a
 * fixed, cheap, no-params query meant to render instantly on page load.
 */
adminRouter.get("/admin/errors/recent", async (req, res) => {
  try {
    const db = req.db;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const snap = await db.collection("request_logs")
      .where("status", "==", "error")
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();

    const errors = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        userId: d.userId,
        agent: d.agent,
        model: d.model,
        provider: d.provider,
        errorCode: d.errorCode || "unknown",
        timestamp: d.timestamp,
      };
    });

    res.json({ errors, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    if (e.message?.includes("index")) {
      logger.error("Admin recent-errors query needs a Firestore index", { error: e.message });
      return sendError(res, "SERVER_ERROR", "This query needs a Firestore index. Check server logs for the index-creation link.");
    }
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/admin/users — Paginated list of all users.
 * Query params: limit (default 25, max 100), cursor (uid to start after),
 *               search (email prefix, case-insensitive)
 *
 * Search uses the emailLower field (lowercased on every login via
 * ensureUser) with a Firestore range query: `>= prefix` AND `< prefix+\uf8ff`.
 * This is a prefix match only (not substring/fuzzy) — "saum" matches
 * "[REDACTED — admin email not included in public showcase]" but "paul" alone won't. Users who haven't
 * logged in since this field was added won't have emailLower set yet and
 * are excluded from search results until their next login (self-healing,
 * no backfill script needed since ensureUser runs on every login).
 */
adminRouter.get("/admin/users", async (req, res) => {
  try {
    const db = req.db;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const cursor = req.query.cursor || null; // "<sortFieldValue>|<uid>", see below
    const search = (req.query.search || "").trim().toLowerCase();

    // Cursor encodes both the sort-field value and the doc id, so we can
    // resume pagination with startAfter(value, uid) directly — no need to
    // fetch the previous page's last document just to anchor the cursor
    // (that used to cost 1 extra read per page). orderBy(field).orderBy(id)
    // doesn't need its own composite index: Firestore's automatic per-field
    // index already carries the document id as an implicit tiebreaker, and
    // explicitly ordering by FieldPath.documentId() just makes that
    // tiebreaker usable as a cursor value instead of needing a snapshot.
    let sortValue = null;
    let sortUid = null;
    if (cursor) {
      const sep = cursor.lastIndexOf("|");
      if (sep > -1) {
        sortValue = cursor.slice(0, sep);
        sortUid = cursor.slice(sep + 1);
      }
    }

    let query;
    if (search) {
      // Prefix range query — requires orderBy on the same field being ranged.
      query = db.collection("users")
        .orderBy("emailLower")
        .orderBy(FieldPath.documentId())
        .startAt(search)
        .endAt(search + "\uf8ff")
        .limit(limit);
      if (sortValue !== null && sortUid) {
        query = query.startAfter(sortValue, sortUid);
      }
    } else {
      query = db.collection("users")
        .orderBy("createdAt", "desc")
        .orderBy(FieldPath.documentId())
        .limit(limit);
      if (sortValue !== null && sortUid) {
        query = query.startAfter(sortValue, sortUid);
      }
    }

    const snap = await query.get();
    const sortField = search ? "emailLower" : "createdAt";
    const users = snap.docs.map((doc) => {
      const d = doc.data();
      // A "developer" tier value in Firestore is only ever honored at
      // request time (core/billing.js checkSubscriptionValid) if the email
      // matches DEVELOPER_PLAN_EMAIL exactly — anyone else with this tier
      // stored is a stale/leftover value that gets force-downgraded to free
      // on their next request. Flag it here so the admin list is honest
      // about what's actually enforced vs. what's just sitting in the DB.
      const staleDeveloperTag = d.tier === "developer" && !isAllowedDeveloperEmail(d.email || "");
      return {
        uid: doc.id,
        email: d.email,
        displayName: d.displayName,
        tier: d.tier,
        staleDeveloperTag,
        freeActivated: d.freeActivated,
        createdAt: d.createdAt,
        lastLogin: d.lastLogin,
        subscriptionExpiry: d.subscriptionExpiry || null,
        suspended: d.suspended || false,
        _sortValue: d[sortField], // internal only, stripped before response
      };
    });

    const last = users[users.length - 1];
    const nextCursor = users.length === limit && last ? `${last._sortValue}|${last.uid}` : null;
    const cleanUsers = users.map(({ _sortValue, ...u }) => u);

    res.json({
      users: cleanUsers,
      nextCursor,
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    if (e.message?.includes("index")) {
      logger.error("Admin users search query needs a Firestore index", { error: e.message });
      return sendError(res, "SERVER_ERROR", "Search needs a Firestore index on emailLower. Check server logs for the index-creation link.");
    }
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/admin/access-log — Recent unauthorized admin access attempts.
 * Lets the real admin see who's been poking at /v1/admin/* without permission.
 */
adminRouter.get("/admin/access-log", async (req, res) => {
  try {
    const db = req.db;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const snap = await db
      .collection("admin_access_log")
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();

    const attempts = snap.docs.map((doc) => doc.data());
    res.json({ attempts, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/admin/users/:uid — Full detail for a single user.
 * Profile + effective tier + 28-day usage analytics summary.
 */
adminRouter.get("/admin/users/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const db = req.db;

    const userDoc = await getUserDoc(db, uid);
    if (!userDoc) return sendError(res, "USER_NOT_FOUND");

    const analytics = await getUsageAnalytics(db, uid, 28);

    // Only the counts are needed here (Profile tab shows numbers, not the
    // key list itself — that's the dedicated /keys route below). count()
    // aggregation queries are billed independent of how many keys match,
    // so this is 2 cheap reads regardless of how many keys the user has,
    // instead of downloading every key doc just to tally two numbers.
    const [totalKeysSnap, activeKeysSnap] = await Promise.all([
      db.collection("api_keys").where("userId", "==", uid).count().get(),
      db.collection("api_keys").where("userId", "==", uid).where("isActive", "==", true).count().get(),
    ]);
    const totalApiKeys = totalKeysSnap.data().count;
    const activeKeys = activeKeysSnap.data().count;

    const staleDeveloperTag = userDoc.tier === "developer" && !isAllowedDeveloperEmail(userDoc.email || "");

    res.json({
      user: {
        uid,
        email: userDoc.email,
        displayName: userDoc.displayName,
        tier: userDoc.tier,
        staleDeveloperTag,
        freeActivated: userDoc.freeActivated || false,
        suspended: userDoc.suspended || false,
        suspendedReason: userDoc.suspendedReason || null,
        suspendedAt: userDoc.suspendedAt || null,
        createdAt: userDoc.createdAt,
        lastLogin: userDoc.lastLogin,
        subscriptionExpiry: userDoc.subscriptionExpiry || null,
        lastPaymentAt: userDoc.lastPaymentAt || null,
        lastOrderId: userDoc.lastOrderId || null,
        activeApiKeys: activeKeys,
        totalApiKeys,
      },
      usage: analytics,
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * POST /v1/admin/users/:uid/tier — Change a user's tier.
 * Body: { tier: "free" | "starter" | "growth" | "pro" | "enterprise_t1" | "enterprise_t2" }
 * Cannot set "developer" — that stays strictly email-gated (core/billing.js).
 * Paid tiers get a fresh 28-day window from now; free/no-expiry tiers clear expiry.
 */
adminRouter.post("/admin/users/:uid/tier", async (req, res) => {
  try {
    const { uid } = req.params;
    const { tier } = req.body || {};
    const db = req.db;

    if (!tier || !TIER_LIMITS[tier]) {
      return sendError(res, "INVALID_REQUEST", `Invalid tier. Valid: ${Object.keys(TIER_LIMITS).filter(t => t !== "developer").join(", ")}`);
    }
    if (tier === "developer") {
      return sendError(res, "INSUFFICIENT_PERMISSION", "Developer plan is strictly email-gated and cannot be assigned manually.");
    }

    const userDoc = await getUserDoc(db, uid);
    if (!userDoc) return sendError(res, "USER_NOT_FOUND");

    const tierInfo = TIER_LIMITS[tier];
    const now = new Date();
    const updateData = {
      tier,
      updatedAt: now.toISOString(),
      adminTierOverrideBy: req.decodedToken.email,
      adminTierOverrideAt: now.toISOString(),
    };

    if (tier === "free") {
      updateData.subscriptionExpiry = null;
    } else if (tierInfo.billingDays) {
      updateData.subscriptionExpiry = new Date(now.getTime() + tierInfo.billingDays * 24 * 60 * 60 * 1000).toISOString();
      updateData.freeActivated = true;
    }

    await db.collection("users").doc(uid).update(updateData);

    logger.warn("Admin tier override", { uid, tier, admin: req.decodedToken.email });

    // Tier change moves counts that overview/revenue cache — don't let the
    // next dashboard load show stale numbers for up to 30s.
    invalidatePrefix("overview");
    invalidatePrefix("revenue:");

    res.json({ updated: true, uid, tier, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * POST /v1/admin/users/:uid/suspend — Suspend or unsuspend a user.
 * Body: { suspended: boolean, reason?: string }
 * Enforced at the single billing gate (core/billing.js checkSubscriptionValid),
 * which both the REST API pipeline and MCP auth route through — so this
 * blocks every request path, not just the dashboard.
 */
adminRouter.post("/admin/users/:uid/suspend", async (req, res) => {
  try {
    const { uid } = req.params;
    const { suspended, reason } = req.body || {};
    const db = req.db;

    if (typeof suspended !== "boolean") {
      return sendError(res, "INVALID_REQUEST", "suspended (boolean) is required.");
    }

    const userDoc = await getUserDoc(db, uid);
    if (!userDoc) return sendError(res, "USER_NOT_FOUND");

    const now = new Date().toISOString();
    const updateData = suspended
      ? {
          suspended: true,
          suspendedReason: reason || "Suspended by admin",
          suspendedAt: now,
          suspendedBy: req.decodedToken.email,
        }
      : {
          suspended: false,
          suspendedReason: null,
          unsuspendedAt: now,
          unsuspendedBy: req.decodedToken.email,
        };

    await db.collection("users").doc(uid).update(updateData);

    logger.warn(suspended ? "Admin suspended user" : "Admin unsuspended user", { uid, admin: req.decodedToken.email });

    res.json({ updated: true, uid, suspended, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * POST /v1/admin/users/:uid/force-logout — Revoke every active API key.
 * There's no server-side session store for API auth (it's bearer-key based),
 * so "force logout" means deactivating all live keys — any client using them
 * gets INVALID_API_KEY on its next call and must re-issue from the dashboard.
 */
adminRouter.post("/admin/users/:uid/force-logout", async (req, res) => {
  try {
    const { uid } = req.params;
    const db = req.db;

    const keysSnap = await db.collection("api_keys").where("userId", "==", uid).where("isActive", "==", true).get();

    if (keysSnap.empty) {
      return res.json({ revoked: 0, uid, meta: { powered_by: "Aeldorado by Solanacy" } });
    }

    const batch = db.batch();
    keysSnap.docs.forEach((doc) => {
      batch.update(doc.ref, { isActive: false, revokedBy: req.decodedToken.email, revokedAt: new Date().toISOString(), revokeReason: "admin_force_logout" });
    });
    await batch.commit();

    logger.warn("Admin force-logout", { uid, revokedCount: keysSnap.size, admin: req.decodedToken.email });

    res.json({ revoked: keysSnap.size, uid, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/admin/users/:uid/keys — Individual API key list for a user
 * (created date, last used, name, prefix, active/revoked status).
 * The overview/user-detail already shows an active/total count; this is
 * the drill-down for that count, and the source for single-key revoke.
 * Never returns rawKey — same rule as every other key-listing route.
 */
adminRouter.get("/admin/users/:uid/keys", async (req, res) => {
  try {
    const { uid } = req.params;
    const db = req.db;

    const snap = await db.collection("api_keys").where("userId", "==", uid).get();

    const keys = snap.docs
      .map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          name: d.name || null,
          keyPrefix: d.keyPrefix,
          scope: d.scope,
          isActive: d.isActive,
          isPlaygroundKey: !!d.isPlaygroundKey,
          isPublicFacing: !!d.isPublicFacing,
          createdAt: d.createdAt,
          lastUsed: d.lastUsed || null,
          revokedAt: d.revokedAt || null,
          revokedBy: d.revokedBy || null,
          revokeReason: d.revokeReason || null,
        };
      })
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    res.json({ keys, uid, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * POST /v1/admin/users/:uid/keys/:keyId/revoke — Revoke a single API key.
 * The scalpel to force-logout's hammer: use this when only one key is
 * compromised/stale instead of nuking every session the user has.
 * :keyId is the Firestore doc ID (== key hash, per keys.js doc(hash).set).
 */
adminRouter.post("/admin/users/:uid/keys/:keyId/revoke", async (req, res) => {
  try {
    const { uid, keyId } = req.params;
    const db = req.db;

    const ref = db.collection("api_keys").doc(keyId);
    const snap = await ref.get();

    if (!snap.exists) return sendError(res, "NOT_FOUND", "Key not found.");
    if (snap.data().userId !== uid) return sendError(res, "INVALID_REQUEST", "Key does not belong to this user.");
    if (!snap.data().isActive) return res.json({ alreadyRevoked: true, uid, keyId, meta: { powered_by: "Aeldorado by Solanacy" } });

    await ref.update({
      isActive: false,
      revokedBy: req.decodedToken.email,
      revokedAt: new Date().toISOString(),
      revokeReason: "admin_single_key_revoke",
    });

    logger.warn("Admin single-key revoke", { uid, keyId, admin: req.decodedToken.email });

    res.json({ revoked: true, uid, keyId, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/admin/users/:uid/logs — Per-user request log history (paginated).
 * Query params: limit (default 25, max 100), cursor (ISO timestamp)
 */
adminRouter.get("/admin/users/:uid/logs", async (req, res) => {
  try {
    const { uid } = req.params;
    const db = req.db;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const cursor = req.query.cursor || null;

    const { logs, hasMore, nextCursor } = await getRequestLogs(db, uid, { limit, startAfter: cursor });

    res.json({
      logs,
      nextCursor: hasMore ? nextCursor : null,
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/admin/users/:uid/payments — Per-user Cashfree payment/transaction history.
 * Query params: limit (default 10, max 50), cursor (ISO createdAt timestamp)
 */
adminRouter.get("/admin/users/:uid/payments", async (req, res) => {
  try {
    const { uid } = req.params;
    const db = req.db;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const cursor = req.query.cursor || null;

    const { history, hasMore, nextCursor } = await getPaymentHistory(db, uid, { limit, startAfter: cursor });

    res.json({
      payments: history,
      nextCursor: hasMore ? nextCursor : null,
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/admin/logs — Global request log viewer across all users.
 * Query params: limit (default 25, max 100), cursor (ISO timestamp),
 *               userId (filter), agent (filter), model (filter), status (filter)
 *
 * Firestore can only do range/orderBy on one inequality field at a time and
 * has no native OR/text search, so filters are applied as equality `where`
 * clauses stacked onto the base orderBy(timestamp) query — every filter here
 * is an exact match, not a partial/text search.
 */
adminRouter.get("/admin/logs", async (req, res) => {
  try {
    const db = req.db;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const cursor = req.query.cursor || null;
    const { userId, agent, model, status } = req.query;

    let query = db.collection("request_logs").orderBy("timestamp", "desc");

    if (userId) query = query.where("userId", "==", userId);
    if (agent) query = query.where("agent", "==", agent);
    if (model) query = query.where("model", "==", model);
    if (status) query = query.where("status", "==", status);

    if (cursor) query = query.startAfter(cursor);
    query = query.limit(limit + 1);

    const snap = await query.get();
    const docs = snap.docs.slice(0, limit);
    const hasMore = snap.docs.length > limit;

    const logs = docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        userId: d.userId,
        keyPrefix: d.keyPrefix,
        agent: d.agent,
        model: d.model,
        provider: d.provider,
        routing: d.routing,
        status: d.status,
        latencyMs: d.latencyMs,
        tokens: d.tokens,
        errorCode: d.errorCode || null,
        ip: d.ip,
        timestamp: d.timestamp,
      };
    });

    res.json({
      logs,
      nextCursor: hasMore && docs.length ? docs[docs.length - 1].data().timestamp : null,
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    if (e.message?.includes("index")) {
      logger.error("Admin logs query needs a Firestore composite index", { error: e.message });
      return sendError(res, "SERVER_ERROR", "This filter combination needs a Firestore index. Check server logs for the index-creation link.");
    }
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * ── Broadcasts ────────────────────────────────────────────────────────────
 * A message the admin sends to every logged-in user, shown as a dismissible
 * banner at the top of their dashboard. Stored in Firestore ("broadcasts"),
 * read once per session by the dashboard on login/register.
 *
 * Levels: "info" (blue), "warning" (amber), "critical" (red) — purely a
 * display hint for the banner color, no behavioral difference server-side.
 */

const BROADCAST_LEVELS = ["info", "warning", "critical"];

/**
 * GET /v1/admin/broadcasts — History of all broadcasts, newest first.
 */
adminRouter.get("/admin/broadcasts", async (req, res) => {
  try {
    const db = req.db;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);

    const snap = await db.collection("broadcasts").orderBy("createdAt", "desc").limit(limit).get();
    const broadcasts = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.json({ broadcasts, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * POST /v1/admin/broadcasts — Create and immediately activate a broadcast.
 * Body: { message: string, level?: "info"|"warning"|"critical", expiresInHours?: number }
 * expiresInHours is optional — omit for a broadcast that stays active until
 * manually deactivated.
 */
adminRouter.post("/admin/broadcasts", async (req, res) => {
  try {
    const db = req.db;
    const message = (req.body.message || "").trim();
    const level = BROADCAST_LEVELS.includes(req.body.level) ? req.body.level : "info";
    const expiresInHours = req.body.expiresInHours ? Number(req.body.expiresInHours) : null;

    if (!message) {
      return sendError(res, "VALIDATION_ERROR", "message is required.");
    }
    if (message.length > 500) {
      return sendError(res, "VALIDATION_ERROR", "message must be 500 characters or fewer.");
    }
    if (expiresInHours !== null && (!Number.isFinite(expiresInHours) || expiresInHours <= 0)) {
      return sendError(res, "VALIDATION_ERROR", "expiresInHours must be a positive number.");
    }

    const now = new Date();
    const doc = {
      message,
      level,
      active: true,
      createdAt: now.toISOString(),
      createdBy: req.decodedToken.email,
      expiresAt: expiresInHours ? new Date(now.getTime() + expiresInHours * 3600 * 1000).toISOString() : null,
      deactivatedAt: null,
    };

    const ref = await db.collection("broadcasts").add(doc);

    logger.info("Broadcast created", { id: ref.id, level, createdBy: doc.createdBy });
    res.json({ broadcast: { id: ref.id, ...doc }, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * POST /v1/admin/broadcasts/:id/deactivate — Retract a broadcast early.
 * Users who already loaded it keep seeing it until dismissed/refreshed —
 * this only stops it from being served to new page loads.
 */
adminRouter.post("/admin/broadcasts/:id/deactivate", async (req, res) => {
  try {
    const db = req.db;
    const ref = db.collection("broadcasts").doc(req.params.id);
    const snap = await ref.get();

    if (!snap.exists) {
      return sendError(res, "NOT_FOUND", "Broadcast not found.");
    }

    await ref.update({ active: false, deactivatedAt: new Date().toISOString() });

    logger.info("Broadcast deactivated", { id: req.params.id, by: req.decodedToken.email });
    res.json({ ok: true, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

// ── Newsroom CMS ─────────────────────────────────────────────────────────
// Anthropic-newsroom-style: admin authors Markdown posts here, public /news
// page (routes/news.js, publicCors, no auth) reads only status:"published".

/**
 * GET /v1/admin/news — List all posts (draft + published), newest first.
 */
adminRouter.get("/admin/news", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const posts = await listPostsForAdmin(req.db, { limit });
    res.json({ posts, categories: CATEGORIES, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "INTERNAL_ERROR", e.message);
  }
});

/**
 * GET /v1/admin/news/:slug — Fetch one post (any status) for editing.
 */
adminRouter.get("/admin/news/:slug", async (req, res) => {
  try {
    const post = await getPostForAdmin(req.db, req.params.slug);
    if (!post) return sendError(res, "AGENT_NOT_FOUND", "Post not found.");
    res.json({ post, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "INTERNAL_ERROR", e.message);
  }
});

/**
 * POST /v1/admin/news — Create a new post. Body: { title, excerpt, category,
 * coverImage, bodyMarkdown, publishNow }. Starts as draft unless publishNow.
 */
adminRouter.post("/admin/news", async (req, res) => {
  const { title, excerpt, category, coverImage, bodyMarkdown, publishNow } = req.body;

  if (!title || !String(title).trim()) {
    return sendError(res, "INVALID_REQUEST", "title is required.");
  }

  try {
    const post = await createPost(req.db, {
      title, excerpt, category, coverImage, bodyMarkdown,
      publishNow: !!publishNow,
      authorEmail: req.decodedToken.email,
    });
    invalidatePrefix("news:");
    res.status(201).json({ post, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    if (e.code === "INVALID_TITLE" || e.code === "SLUG_EXHAUSTED") {
      return sendError(res, "INVALID_REQUEST", e.message);
    }
    sendError(res, "INTERNAL_ERROR", e.message);
  }
});

/**
 * POST /v1/admin/news/:slug — Update a post (title, body, category, status, etc).
 * Setting status:"published" for the first time stamps publishedAt.
 */
adminRouter.post("/admin/news/:slug", async (req, res) => {
  try {
    const updated = await updatePost(req.db, req.params.slug, req.body || {});
    if (!updated) return sendError(res, "AGENT_NOT_FOUND", "Post not found.");
    invalidatePrefix("news:");
    res.json({ post: updated, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "INTERNAL_ERROR", e.message);
  }
});

/**
 * DELETE /v1/admin/news/:slug — Permanently delete a post.
 */
adminRouter.delete("/admin/news/:slug", async (req, res) => {
  try {
    const deleted = await deletePost(req.db, req.params.slug);
    if (!deleted) return sendError(res, "AGENT_NOT_FOUND", "Post not found.");
    invalidatePrefix("news:");
    res.json({ deleted: true, slug: req.params.slug, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch (e) {
    sendError(res, "INTERNAL_ERROR", e.message);
  }
});
