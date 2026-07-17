// core/anti-abuse.js — Free Tier Abuse Prevention
// Aeldorado by Solanacy Technologies
//
// Protects the free tier from abuse:
// - IP rate limiting: 2+ free accounts on same IP → 48h suspension
// - Device fingerprinting via request headers
// - Suspension tracking in Firestore

/**
 * Generate a device fingerprint from request headers.
 * Not cryptographically strong, but sufficient for abuse detection.
 *
 * @param {import("express").Request} req
 * @returns {string} Fingerprint hash
 */
export function getDeviceFingerprint(req) {
  const components = [
    req.headers["user-agent"] || "",
    req.headers["accept-language"] || "",
    req.headers["accept-encoding"] || "",
    req.headers["sec-ch-ua"] || "",
    req.headers["sec-ch-ua-platform"] || "",
  ];
  // Simple hash — not crypto-grade, just for grouping
  let hash = 0;
  const str = components.join("|");
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Get client IP from request, handling proxies.
 *
 * @param {import("express").Request} req
 * @returns {string}
 */
export function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.headers["x-real-ip"]
    || req.socket?.remoteAddress
    || "unknown";
}

/**
 * Check if a free-tier user is flagged for abuse.
 * Implements: If 2+ free accounts share an IP → flag & suspend 48h.
 *
 * @param {object} db     - Firestore instance
 * @param {string} userId
 * @param {string} tier
 * @param {import("express").Request} req
 * @returns {Promise<{ allowed: boolean, reason?: string, suspendedUntil?: string }>}
 */
export async function checkAbuse(db, userId, tier, req) {
  // Only enforce on free tier
  if (tier !== "free") return { allowed: true };

  const ip          = getClientIP(req);
  const fingerprint = getDeviceFingerprint(req);

  try {
    // 1. Check if this user is already suspended
    const flagRef  = db.collection("abuse_flags").doc(userId);
    const flagSnap = await flagRef.get();

    if (flagSnap.exists) {
      const flag = flagSnap.data();
      if (flag.suspendedUntil) {
        const until = new Date(flag.suspendedUntil);
        if (until > new Date()) {
          return {
            allowed: false,
            reason: "Account suspended due to policy violation.",
            suspendedUntil: flag.suspendedUntil,
          };
        }
        // Suspension expired — clear flag
        await flagRef.delete();
      }
    }

    // 2. Record this user's IP usage
    const ipRef = db.collection("ip_tracking").doc(ip);
    const ipSnap = await ipRef.get();
    const ipData = ipSnap.exists ? ipSnap.data() : { users: {} };

    // Add/update this user
    ipData.users[userId] = {
      fingerprint,
      lastSeen: new Date().toISOString(),
    };

    // Count unique FREE-tier users on this IP
    const uniqueUsers = Object.keys(ipData.users);

    if (uniqueUsers.length >= 2) {
      // Flag all free users on this IP
      const suspendedUntil = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      for (const uid of uniqueUsers) {
        await db.collection("abuse_flags").doc(uid).set({
          ip,
          fingerprint: ipData.users[uid].fingerprint,
          flaggedAt: new Date().toISOString(),
          suspendedUntil,
          reason: "Multiple free accounts detected on same IP.",
        });
      }

      console.warn(`[ABUSE] IP ${ip} flagged — ${uniqueUsers.length} free accounts. Suspended 48h.`);

      return {
        allowed: false,
        reason: "Account suspended due to policy violation.",
        suspendedUntil,
      };
    }

    // Save IP tracking data
    await ipRef.set(ipData, { merge: true });

    return { allowed: true };
  } catch (e) {
    console.error("[ABUSE] Check failed:", e.message);
    // Fail open — don't block legitimate users due to internal errors
    return { allowed: true };
  }
}
