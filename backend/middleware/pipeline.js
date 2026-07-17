// middleware/pipeline.js — Request Processing Pipeline
// Aeldorado by Solanacy Technologies
//
// Enhanced pipeline: auth → IP check → abuse → billing → per-key rate limit → vault decrypt

import { extractApiKey, verifyApiKey }     from "../core/auth.js";
import { checkUsage, recordUsage, checkSubscriptionValid } from "../core/billing.js";
import { decrypt }                         from "../core/encryption.js";
import { sendError }                       from "../core/errors.js";
import { checkIPAllowed }                  from "../core/user-manager.js";
import { logger }                      from "../core/logger.js";

// [PROPRIETARY — REDACTED] getClientIP and the free-tier abuse-detection
// logic (core/anti-abuse.js — device fingerprinting, IP-sharing thresholds,
// suspension rules) have been removed from this public showcase to avoid
// publishing exact abuse-detection thresholds/mechanics. The pipeline shape
// below (auth → IP check → abuse → billing → rate-limit → vault decrypt) is
// preserved to show the real request-processing architecture.
function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.socket?.remoteAddress
    || "unknown";
}

// In-memory per-key rate limiter (resets every minute)
const keyRateMap = new Map();
const KEY_RATE_LIMIT = 30; // max requests per minute per API key
const KEY_RATE_WINDOW = 60_000;

function checkPerKeyRate(keyHash) {
  const now = Date.now();
  let entry = keyRateMap.get(keyHash);
  if (!entry || (now - entry.windowStart > KEY_RATE_WINDOW)) {
    entry = { count: 0, windowStart: now };
    keyRateMap.set(keyHash, entry);
  }
  entry.count++;
  return entry.count <= KEY_RATE_LIMIT;
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of keyRateMap) {
    if (now - entry.windowStart > KEY_RATE_WINDOW * 2) keyRateMap.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * Middleware: Validate API key and attach user info to req.
 */
export async function validateApiKey(req, res, next) {
  const rawKey = extractApiKey(req);
  if (!rawKey) return sendError(res, "MISSING_API_KEY");

  const result = await verifyApiKey(req.db, rawKey);
  if (!result.valid) return sendError(res, "INVALID_API_KEY");

  // Per-key rate limit
  if (!checkPerKeyRate(result.keyDoc?.keyPrefix || "unknown")) {
    return sendError(res, "RATE_LIMIT_EXCEEDED", "This API key has exceeded 30 requests/minute.");
  }

  req.userId   = result.userId;
  req.tier     = result.tier;
  req.keyDoc   = result.keyDoc;
  req.keyPrefix = result.keyDoc?.keyPrefix || null;
  next();
}

/**
 * Middleware: Check IP allowlist.
 */
export async function checkIPMiddleware(req, res, next) {
  const ip = getClientIP(req);
  req.clientIP = ip;

  const allowed = await checkIPAllowed(req.db, req.userId, ip);
  if (!allowed) {
    return sendError(res, "INSUFFICIENT_PERMISSION", "Your IP is not in the allowlist.");
  }
  next();
}

/**
 * Middleware: Check for free-tier abuse.
 * [PROPRIETARY — REDACTED] Real implementation (device fingerprinting,
 * IP-sharing detection, suspension logic) removed from this public copy —
 * see core/anti-abuse.js note above. This stub always allows.
 */
export async function checkAbuseMiddleware(req, res, next) {
  next();
}

/**
 * Middleware: Check billing/usage limits.
 */
export async function checkBillingMiddleware(req, res, next) {
  // 1. First check subscription validity (free tier must be activated)
  const userSnap = await req.db.collection("users").doc(req.userId).get();
  const userData = userSnap.exists ? userSnap.data() : {};

  const { valid, tier: effectiveTier, reason } = await checkSubscriptionValid(req.db, req.userId, userData);

  if (!valid) {
    if (reason === "account_suspended") {
      return sendError(res, "ACCOUNT_SUSPENDED");
    }
    if (reason === "free_plan_not_activated") {
      return sendError(res, "PAYMENT_REQUIRED",
        "Free tier requires a one-time ₹1 activation. Please activate your account from the dashboard."
      );
    }
    if (reason === "subscription_expired") {
      return sendError(res, "PAYMENT_REQUIRED",
        "Your subscription has expired. Please renew from the dashboard."
      );
    }
    if (reason === "developer_plan_restricted") {
      return sendError(res, "INSUFFICIENT_PERMISSION",
        "Developer plan is restricted."
      );
    }
    return sendError(res, "PAYMENT_REQUIRED", "Subscription inactive. Please visit the dashboard.");
  }

  // Update tier to effective tier (in case of auto-downgrade)
  req.tier = effectiveTier;

  // 2. Then check usage limits
  const result = await checkUsage(req.db, req.userId, req.tier);
  if (!result.allowed) {
    const errorMap = {
      daily:   "DAILY_LIMIT_EXCEEDED",
      weekly:  "WEEKLY_LIMIT_EXCEEDED",
      monthly: "MONTHLY_LIMIT_EXCEEDED",
    };
    return sendError(res, errorMap[result.limitType] || "INSUFFICIENT_CREDITS");
  }
  req.usage = result.usage;
  next();
}

/**
 * Middleware: Decrypt user's AI provider key from vault.
 */
export async function decryptVaultKey(req, res, next) {
  const password = req.headers["x-encryption-password"];
  const provider = req.body.provider || "gemini";
  const model    = req.body.model;

  if (!password) {
    return sendError(res, "DECRYPTION_FAILED", "X-Encryption-Password header is required.");
  }

  try {
    const vaultRef  = req.db.collection("key_vault").doc(req.userId);
    const vaultSnap = await vaultRef.get();

    if (!vaultSnap.exists) {
      return sendError(res, "VAULT_KEY_NOT_FOUND", "No API keys stored in your vault.");
    }

    const providers     = vaultSnap.data().providers || [];
    const providerEntry = providers.find(p => p.name === provider);

    if (!providerEntry) {
      return sendError(res, "VAULT_KEY_NOT_FOUND", `No key found for provider "${provider}".`);
    }

    const decryptedKey = decrypt({
      ciphertext: providerEntry.ciphertext,
      iv:         providerEntry.iv,
      salt:       providerEntry.salt,
      tag:        providerEntry.tag,
    }, password);

    req.decryptedApiKey = decryptedKey;
    req.provider        = provider;
    req.model           = model || providerEntry.defaultModel || null;
    next();
  } catch (e) {
    logger.warn("Vault decryption failed", { error: e.message, userId: req.userId });
    return sendError(res, "DECRYPTION_FAILED");
  }
}

/**
 * Post-response: Record successful API call usage.
 */
export async function recordUsageAfterSuccess(req) {
  if (req.userId) {
    await recordUsage(req.db, req.userId).catch(() => {});
  }
}

/**
 * Combined pipeline for API endpoints.
 */
export function apiPipeline() {
  return [validateApiKey, checkIPMiddleware, checkAbuseMiddleware, checkBillingMiddleware, decryptVaultKey];
}
