// core/auth.js — API Key Authentication & Firebase Auth
// Aeldorado by Solanacy Technologies
//
// Dual auth system:
// 1. Firebase Auth (dashboard login) — Google Sign-in + Email/Password
// 2. API Key Auth (API calls) — "aldo-live-xxxxx" format, SHA-256 hashed in storage

import crypto from "crypto";
import { logger } from "./logger.js";

// API key prefix — all public keys start with this
const KEY_PREFIX = "aldo-live-";

/**
 * Generate a new API key with the Aeldorado format.
 * Format: aldo-live-{48 random hex chars}
 *
 * @returns {{ raw: string, hash: string, prefix: string }}
 *   raw    — The full key (shown to user ONCE, never stored)
 *   hash   — SHA-256 hash (stored in Firestore)
 *   prefix — First 14 chars for display ("aldo-live-xxxx")
 */
export function generateApiKey() {
  const random = crypto.randomBytes(24).toString("hex"); // 48 hex chars
  const raw    = `${KEY_PREFIX}${random}`;
  const hash   = hashApiKey(raw);
  const prefix = raw.slice(0, 14);

  return { raw, hash, prefix };
}

/**
 * Hash an API key with SHA-256 for storage/lookup.
 *
 * @param {string} rawKey
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function hashApiKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Validate API key format.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isValidKeyFormat(key) {
  if (!key || typeof key !== "string") return false;
  return key.startsWith(KEY_PREFIX) && key.length === KEY_PREFIX.length + 48;
}

/**
 * Extract API key from Authorization header.
 * Supports: "Bearer aldo-live-xxx..."
 *
 * @param {import("express").Request} req
 * @returns {string | null}
 */
export function extractApiKey(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  if (authHeader.startsWith("Bearer ")) {
    const key = authHeader.slice(7).trim();
    return isValidKeyFormat(key) ? key : null;
  }

  return null;
}

/**
 * Verify an API key against Firestore.
 * Looks up the SHA-256 hash in the api_keys collection.
 *
 * @param {object} db   - Firestore instance
 * @param {string} rawKey
 * @returns {Promise<{ valid: boolean, userId?: string, tier?: string, keyDoc?: object }>}
 */
export async function verifyApiKey(db, rawKey) {
  const hash = hashApiKey(rawKey);

  try {
    const doc = await db.collection("api_keys").doc(hash).get();
    if (!doc.exists) return { valid: false };

    const data = doc.data();
    if (!data.isActive) return { valid: false };

    // Update last used timestamp (fire-and-forget)
    doc.ref.update({ lastUsed: new Date().toISOString() }).catch(() => {});

    return {
      valid:   true,
      userId:  data.userId,
      tier:    data.tier,
      keyDoc:  data,
    };
  } catch (e) {
    logger.error("API key verification failed", { error: e.message });
    return { valid: false };
  }
}

/**
 * Verify Firebase ID token from Authorization header.
 * Used for dashboard endpoints (not API calls).
 *
 * @param {object} adminAuth - Firebase Admin Auth instance
 * @param {import("express").Request} req
 * @returns {Promise<object | null>} Decoded token or null
 */
export async function verifyFirebaseToken(adminAuth, req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7).trim();
  // Skip if it's an API key (starts with aldo-live-)
  if (token.startsWith(KEY_PREFIX)) return null;

  try {
    return await adminAuth.verifyIdToken(token);
  } catch {
    return null;
  }
}

/**
 * Verify an API key by its precomputed SHA-256 hash (used by the OAuth layer,
 * which resolves an access token to a stored key hash without ever handling
 * the raw key).
 *
 * @param {object} db
 * @param {string} keyHash
 * @returns {Promise<{ valid: boolean, userId?: string, tier?: string, keyDoc?: object }>}
 */
export async function verifyApiKeyHash(db, keyHash) {
  try {
    const doc = await db.collection("api_keys").doc(keyHash).get();
    if (!doc.exists) return { valid: false };

    const data = doc.data();
    if (!data.isActive) return { valid: false };

    doc.ref.update({ lastUsed: new Date().toISOString() }).catch(() => {});

    return {
      valid:  true,
      userId: data.userId,
      tier:   data.tier,
      keyDoc: data,
    };
  } catch (e) {
    logger.error("API key hash verification failed", { error: e.message });
    return { valid: false };
  }
}

/**
 * Mask an API key for display.
 * Shows: "aldo-live-xxxx••••••xx"
 *
 * @param {string} prefix - The stored key prefix
 * @returns {string}
 */
export function maskKey(prefix) {
  return `${prefix}${"•".repeat(30)}`;
}
