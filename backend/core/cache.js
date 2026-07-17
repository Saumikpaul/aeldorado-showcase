// core/cache.js — Tiny in-memory TTL cache
// Aeldorado by Solanacy Technologies
//
// Simple in-process cache for read-heavy, low-staleness-risk endpoints
// (e.g. published news posts). Absorbs repeat Firestore reads for
// identical queries within a short TTL window. Zero infra dependency
// (single instance, so plain in-process memory is fine — no Redis needed).
//
// Deliberately NOT used for anything that performs a write or where the
// caller needs to see a change reflected instantly. Read-only, dashboard/
// listing-style endpoints only.

const store = new Map(); // key -> { value, expiresAt }

/**
 * Get a cached value, or compute + cache it via `fn` if missing/expired.
 * @param {string} key - cache key, should include any query params that affect the result
 * @param {number} ttlMs - how long to keep the cached value
 * @param {() => Promise<any>} fn - producer, only called on cache miss
 */
export async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }
  const value = await fn();
  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/**
 * Drop all cached entries whose key starts with the given prefix.
 * Call this after a write that should be reflected immediately.
 */
export function invalidatePrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
