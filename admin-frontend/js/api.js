// js/api.js — Admin Portal API Client
// Aeldorado by Solanacy Technologies

import { API_BASE, PUBLIC_APP_URL } from "./config.js";
import { getToken, signOutAndRedirect } from "./auth.js";

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (res.status === 403 || res.status === 401) {
    const body = await res.json().catch(() => ({}));
    // Server said no — never keep showing admin UI. Sign out immediately.
    await signOutAndRedirect(body.redirect || PUBLIC_APP_URL);
    throw new Error("Admin access denied");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `Request failed: ${res.status}`);
  }

  return res.json();
}

export const adminApi = {
  whoami:    () => request("/v1/admin/whoami"),
  overview:  () => request("/v1/admin/overview"),
  revenue:   (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/v1/admin/revenue${qs ? `?${qs}` : ""}`);
  },
  recentErrors: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/v1/admin/errors/recent${qs ? `?${qs}` : ""}`);
  },
  users:     (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/v1/admin/users${qs ? `?${qs}` : ""}`);
  },
  accessLog: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/v1/admin/access-log${qs ? `?${qs}` : ""}`);
  },
  userDetail:   (uid) => request(`/v1/admin/users/${encodeURIComponent(uid)}`),
  userLogs:     (uid, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/v1/admin/users/${encodeURIComponent(uid)}/logs${qs ? `?${qs}` : ""}`);
  },
  userPayments: (uid, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/v1/admin/users/${encodeURIComponent(uid)}/payments${qs ? `?${qs}` : ""}`);
  },
  userKeys:     (uid) => request(`/v1/admin/users/${encodeURIComponent(uid)}/keys`),
  revokeKey:    (uid, keyId) => request(`/v1/admin/users/${encodeURIComponent(uid)}/keys/${encodeURIComponent(keyId)}/revoke`, {
    method: "POST",
  }),
  setTier:      (uid, tier) => request(`/v1/admin/users/${encodeURIComponent(uid)}/tier`, {
    method: "POST",
    body: JSON.stringify({ tier }),
  }),
  setSuspended: (uid, suspended, reason) => request(`/v1/admin/users/${encodeURIComponent(uid)}/suspend`, {
    method: "POST",
    body: JSON.stringify({ suspended, reason }),
  }),
  forceLogout:  (uid) => request(`/v1/admin/users/${encodeURIComponent(uid)}/force-logout`, {
    method: "POST",
  }),
  logs: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/v1/admin/logs${qs ? `?${qs}` : ""}`);
  },
  broadcasts:       (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/v1/admin/broadcasts${qs ? `?${qs}` : ""}`);
  },
  createBroadcast:  (message, level, expiresInHours) => request(`/v1/admin/broadcasts`, {
    method: "POST",
    body: JSON.stringify({ message, level, expiresInHours: expiresInHours || undefined }),
  }),
  deactivateBroadcast: (id) => request(`/v1/admin/broadcasts/${encodeURIComponent(id)}/deactivate`, {
    method: "POST",
  }),
  newsList:   (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/v1/admin/news${qs ? `?${qs}` : ""}`);
  },
  newsGet:    (slug) => request(`/v1/admin/news/${encodeURIComponent(slug)}`),
  newsCreate: (post) => request(`/v1/admin/news`, {
    method: "POST",
    body: JSON.stringify(post),
  }),
  newsUpdate: (slug, patch) => request(`/v1/admin/news/${encodeURIComponent(slug)}`, {
    method: "POST",
    body: JSON.stringify(patch),
  }),
  newsDelete: (slug) => request(`/v1/admin/news/${encodeURIComponent(slug)}`, {
    method: "DELETE",
  }),
};
