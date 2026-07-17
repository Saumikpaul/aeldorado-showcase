// core/admin-cache.js — Tiny in-memory TTL cache for admin-panel reads
// Aeldorado by Solanacy Technologies
//
// The admin panel is a human clicking between Overview/Users/Revenue and
// often bouncing right back — each of those hits re-runs the same Firestore
// reads seconds apart with identical results. This cache absorbs that churn
// with zero staleness risk worth worrying about (admin stats don't need
// sub-minute freshness) and zero infra dependency (single Render instance,
// so plain in-process memory is fine — no Redis needed).
//
// Deliberately NOT used for anything that performs a write or that the
// admin needs to see change instantly after their own action (e.g. right
// after suspending a user). Read-only, informational, dashboard-style
// endpoints only.

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
 * Call this after an admin write that should be reflected immediately
 * (e.g. after changing a user's tier, invalidate "overview:" so the next
 * Overview load isn't showing a stale tier count).
 */
export function invalidatePrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
