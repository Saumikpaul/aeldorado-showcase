// core/user-manager.js — User Registration & Tier Management
// Aeldorado by Solanacy Technologies
//
// Auto-creates/updates user records in Firestore on login.
// Developer plan strictly locked to DEVELOPER_PLAN_EMAIL.
// New users default to "free" tier (require ₹1 activation).

import { logger } from "./logger.js";
import { isAllowedDeveloperEmail, DEVELOPER_PLAN_EMAIL } from "./billing.js";

/**
 * Ensure a user exists in Firestore. Creates if new, updates lastLogin if existing.
 * Developer plan guard: if any non-admin user has tier:"developer", it is corrected.
 *
 * @param {object} db
 * @param {object} decoded - Firebase decoded ID token
 * @returns {Promise<object>} User document data
 */
export async function ensureUser(db, decoded) {
  const uid   = decoded.uid;
  const email = decoded.email || "";
  const ref   = db.collection("users").doc(uid);

  try {
    const snap = await ref.get();

    if (snap.exists) {
      const data = snap.data();

      // ── Developer plan email guard ──────────────────────────────────────────
      // If someone somehow has the developer tier but isn't the allowed email,
      // immediately correct it. This is a strict security measure.
      if (data.tier === "developer" && !isAllowedDeveloperEmail(email)) {
        logger.warn("Developer plan access revoked on login — email mismatch", { uid, email });
        await ref.update({
          tier:           "free",
          freeActivated:  false,
          downgradeReason: "developer_email_mismatch",
          downgradeAt:    new Date().toISOString(),
        }).catch(() => {});
        return { ...data, tier: "free", freeActivated: false };
      }

      // Update last login (fire-and-forget)
      ref.update({
        lastLogin:   new Date().toISOString(),
        displayName: decoded.name    || data.displayName,
        email:       email           || data.email,
        emailLower:  (email || data.email || "").toLowerCase(),
        photoURL:    decoded.picture || data.photoURL,
      }).catch(() => {});

      return data;
    }

    // ── New user — determine initial tier ─────────────────────────────────────
    // Admin email gets developer plan automatically.
    // Everyone else starts as free (not activated — needs ₹1 payment).
    const isAdmin    = isAllowedDeveloperEmail(email);
    const initialTier = isAdmin ? "developer" : "free";

    const userData = {
      uid,
      email:          email || null,
      emailLower:     (email || "").toLowerCase(),
      displayName:    decoded.name || email?.split("@")[0] || "User",
      photoURL:       decoded.picture || null,
      tier:           initialTier,
      freeActivated:  isAdmin,      // Admin is pre-activated; others must pay ₹1
      createdAt:      new Date().toISOString(),
      lastLogin:      new Date().toISOString(),
      subscriptionExpiry: null,
      settings: {
        defaultProvider:    "gemini",
        defaultModel:       null,
        ipAllowlist:        [],
        emailNotifications: true,
      },
    };

    await ref.set(userData);
    logger.info("New user created", { email, userId: uid, tier: initialTier, isAdmin });
    return userData;
  } catch (e) {
    logger.error("ensureUser failed", { error: e.message, userId: uid });
    return { uid, tier: "free", freeActivated: false };
  }
}

/**
 * Get user tier — with developer plan email guard.
 * Returns the effective tier (corrected if developer plan misused).
 *
 * @param {object} db
 * @param {string} userId
 * @returns {Promise<string>}
 */
export async function getUserTier(db, userId) {
  try {
    const snap = await db.collection("users").doc(userId).get();
    if (!snap.exists) return "free";

    const data  = snap.data();
    const tier  = data.tier  || "free";
    const email = data.email || "";

    // Developer plan guard
    if (tier === "developer" && !isAllowedDeveloperEmail(email)) {
      logger.warn("getUserTier: Developer plan blocked for non-admin", { userId, email });
      return "free";
    }

    return tier;
  } catch {
    return "free";
  }
}

/**
 * Get full user document.
 *
 * @param {object} db
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getUserDoc(db, userId) {
  try {
    const snap = await db.collection("users").doc(userId).get();
    return snap.exists ? snap.data() : null;
  } catch {
    return null;
  }
}

/**
 * Get user settings.
 */
export async function getUserSettings(db, userId) {
  try {
    const snap = await db.collection("users").doc(userId).get();
    return snap.exists ? (snap.data().settings || {}) : {};
  } catch {
    return {};
  }
}

/**
 * Update user settings.
 */
export async function updateUserSettings(db, userId, settings) {
  try {
    await db.collection("users").doc(userId).update({ settings });
    return true;
  } catch (e) {
    logger.error("Settings update failed", { error: e.message, userId });
    return false;
  }
}

/**
 * Update user IP allowlist.
 */
export async function updateIPAllowlist(db, userId, ipList) {
  try {
    await db.collection("users").doc(userId).update({ "settings.ipAllowlist": ipList });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an IP is allowed for this user.
 * Empty allowlist = all IPs allowed.
 */
export async function checkIPAllowed(db, userId, ip) {
  try {
    const snap = await db.collection("users").doc(userId).get();
    if (!snap.exists) return true;
    const allowlist = snap.data()?.settings?.ipAllowlist || [];
    if (allowlist.length === 0) return true;
    return allowlist.includes(ip);
  } catch {
    return true; // Fail open
  }
}
