// routes/user.js — User Settings, IP Allowlist, Provider List, Dashboard Usage
// Aeldorado by Solanacy Technologies

import { Router } from "express";
import { ensureUser, getUserSettings, updateUserSettings, updateIPAllowlist } from "../core/user-manager.js";
import { listProviders }   from "../core/provider-detect.js";
import { sendError }       from "../core/errors.js";
import { getUsageStats }   from "../core/billing.js";

export const userRouter = Router();

/**
 * POST /v1/user/register — Register/ensure user exists (called on login).
 */
userRouter.post("/user/register", async (req, res) => {
  if (!req.decodedToken) return sendError(res, "AUTH_REQUIRED");
  try {
    const user = await ensureUser(req.db, req.decodedToken);
    res.json({
      uid:         user.uid,
      email:       user.email,
      displayName: user.displayName,
      tier:        user.tier,
      settings:    user.settings || {},
      createdAt:   user.createdAt,
    });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/user/usage — Dashboard usage stats (Firebase auth, by userId).
 * Returns rolling 5-hour/7-day/28-day counts and limits based on user tier.
 * Delegates to core/billing.js getUsageStats — the single source of truth
 * for usage windows, so dashboard and API enforcement never disagree.
 */
userRouter.get("/user/usage", async (req, res) => {
  if (!req.userId) return sendError(res, "AUTH_REQUIRED");
  try {
    const db     = req.db;
    const userId = req.userId;

    const userDoc = await db.collection("users").doc(userId).get();
    const tier    = userDoc.exists ? (userDoc.data().tier || "free") : "free";

    const stats = await getUsageStats(db, userId, tier);
    res.json(stats);
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/user/settings — Get user settings.
 */
userRouter.get("/user/settings", async (req, res) => {
  if (!req.userId) return sendError(res, "AUTH_REQUIRED");
  try {
    const settings = await getUserSettings(req.db, req.userId);
    res.json({ settings });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * PUT /v1/user/settings — Update user settings.
 */
userRouter.put("/user/settings", async (req, res) => {
  if (!req.userId) return sendError(res, "AUTH_REQUIRED");
  try {
    await updateUserSettings(req.db, req.userId, req.body.settings || {});
    res.json({ message: "Settings updated." });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * PUT /v1/user/ip-allowlist — Update IP allowlist.
 */
userRouter.put("/user/ip-allowlist", async (req, res) => {
  if (!req.userId) return sendError(res, "AUTH_REQUIRED");
  const { ips } = req.body;
  if (!Array.isArray(ips)) return sendError(res, "INVALID_REQUEST", "\"ips\" must be an array.");
  const validIPs = ips.filter(ip => typeof ip === "string" && ip.length > 0 && ip.length < 46);
  if (validIPs.length > 50) return sendError(res, "INVALID_REQUEST", "Maximum 50 IPs allowed.");
  try {
    await updateIPAllowlist(req.db, req.userId, validIPs);
    res.json({ message: "IP allowlist updated.", ips: validIPs, count: validIPs.length });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/providers — List all supported AI providers and models.
 */
userRouter.get("/providers", (req, res) => {
  res.json({ providers: listProviders() });
});

/**
 * GET /v1/user/broadcasts/active — Currently active admin broadcasts.
 * Fetched once per session by the dashboard on login. Filters out anything
 * expired even if it's still flagged active=true in Firestore, so a stale
 * expiresAt never lingers on screen just because nobody deactivated it.
 *
 * NOTE: where("active","==",true) + orderBy("createdAt","desc") needs a
 * Firestore composite index (active ASC, createdAt DESC) on "broadcasts".
 * The first time this runs, Firestore will throw with a direct link in the
 * error to auto-create it — until then this falls back to an unordered
 * equality-only query so the dashboard banner never breaks, just arrives
 * unsorted (harmless for the handful of active broadcasts expected at once).
 */
userRouter.get("/user/broadcasts/active", async (req, res) => {
  if (!req.userId) return sendError(res, "AUTH_REQUIRED");
  try {
    let docs;
    try {
      const snap = await req.db.collection("broadcasts")
        .where("active", "==", true)
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();
      docs = snap.docs;
    } catch (indexErr) {
      if (!indexErr.message?.includes("index")) throw indexErr;
      const snap = await req.db.collection("broadcasts").where("active", "==", true).limit(10).get();
      docs = snap.docs;
    }

    const now = Date.now();
    const broadcasts = docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((b) => !b.expiresAt || new Date(b.expiresAt).getTime() > now)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    res.json({ broadcasts });
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

