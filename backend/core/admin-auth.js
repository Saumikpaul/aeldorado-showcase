// core/admin-auth.js — Super Admin Access Guard
// Aeldorado by Solanacy Technologies
//
// HARD SECURITY BOUNDARY for the internal admin portal (admin.aeldorado.solanacy.in).
// Only DEVELOPER_PLAN_EMAIL ([REDACTED — admin email not included in public showcase]) may pass this gate.
//
// This is intentionally NOT reused/derived from tier data in Firestore — tier
// is user-editable state and must never be the source of truth for admin
// access. The allowed email is a hardcoded constant, checked against the
// server-side-verified Firebase decoded token only. There is no client input
// (body, query, header) that can influence this decision.
//
// Every admin route MUST be wrapped by requireSuperAdmin. It is applied once
// at the router-mount level in server.js so no individual route can be added
// later and accidentally skip the check.

import { logger } from "./logger.js";
import { DEVELOPER_PLAN_EMAIL } from "./billing.js";
import { getClientIP } from "./anti-abuse.js";

/**
 * Log an unauthorized admin access attempt to Firestore for audit/alerting.
 * Fire-and-forget — never blocks the response.
 *
 * @param {object} db
 * @param {object} params
 */
function logUnauthorizedAttempt(db, { uid, email, ip, path, reason }) {
  const entry = {
    uid: uid || null,
    email: email || null,
    ip: ip || "unknown",
    path: path || null,
    reason,
    timestamp: new Date().toISOString(),
  };

  logger.warn("Blocked unauthorized admin access attempt", entry);

  if (!db) return;
  db.collection("admin_access_log")
    .add(entry)
    .catch((e) => logger.error("Failed to write admin_access_log", { error: e.message }));
}

/**
 * requireSuperAdmin — hard gate for every /v1/admin/* route.
 *
 * Must run AFTER dashboardAuth (so req.decodedToken / req.userId are set from
 * a server-verified Firebase ID token — never trust anything client-supplied).
 *
 * On failure: always 403, always logged, always includes a redirect target
 * so the admin frontend can send the browser back to the public app. The
 * redirect is a UX convenience only — the actual security boundary is this
 * 403 response itself, enforced identically whether the caller is a browser
 * or a raw API client.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
export function requireSuperAdmin(req, res, next) {
  // This is mounted at the "/v1" level (see server.js) alongside sibling
  // routers like mcpVaultRouter that share the same base path but must NOT
  // be admin-gated. Express runs this middleware for every "/v1/*" request
  // before adminRouter ever gets a chance to match a sub-route, so without
  // this guard requireSuperAdmin was blocking non-admin routes (e.g.
  // /v1/mcp-vault/enable) for every user except DEVELOPER_PLAN_EMAIL.
  // Bail out immediately for anything that isn't actually an admin route.
  if (!req.path.startsWith("/admin")) {
    return next();
  }

  const decoded = req.decodedToken;
  const ip = getClientIP(req);

  if (!decoded) {
    // Should not happen if dashboardAuth ran first, but fail closed regardless.
    logUnauthorizedAttempt(req.db, {
      ip,
      path: req.originalUrl,
      reason: "no_decoded_token",
    });
    return res.status(403).json({
      error: { code: "forbidden", message: "Admin access denied." },
      redirect: "https://aeldorado.solanacy.in",
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  }

  const email = (decoded.email || "").trim().toLowerCase();
  const isAdmin = decoded.email_verified !== false &&
    email === DEVELOPER_PLAN_EMAIL.toLowerCase();

  if (!isAdmin) {
    logUnauthorizedAttempt(req.db, {
      uid: decoded.uid,
      email: decoded.email,
      ip,
      path: req.originalUrl,
      reason: "email_mismatch",
    });
    return res.status(403).json({
      error: { code: "forbidden", message: "Admin access denied." },
      redirect: "https://aeldorado.solanacy.in",
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  }

  next();
}
