// js/api.js — API Client for Aeldorado Backend
// Aeldorado by Solanacy Technologies

import { API_BASE } from "./config.js";

let authToken = null;
let refreshTokenFn = null;

export function setAuthToken(token) { authToken = token; }
export function setTokenRefresher(fn) { refreshTokenFn = fn; }

async function request(method, path, body = null, extraHeaders = {}, _isRetry = false) {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const opts = { method, headers };
  if (body && method !== "GET") opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);

  if (!res.ok) {
    let errorCode = null;
    let errorDetail = `API Error ${res.status}`;
    const cloned = res.clone();
    try {
      const data = await cloned.json();
      errorCode = data.error?.code;
      errorDetail = data.error?.message || data.error?.detail || errorDetail;
    } catch (e) {
      const text = await res.text();
      if (text) errorDetail += `: ${text}`;
    }

    // Stale Firebase ID token: refresh once and retry transparently.
    if (res.status === 401 && !_isRetry && errorCode === "invalid_auth_token" && refreshTokenFn) {
      const refreshed = await refreshTokenFn().catch(() => false);
      if (refreshed) return request(method, path, body, extraHeaders, true);
    }

    throw new Error(errorDetail);
  }

  if (res.status === 204) return null;
  return await res.json();
}

// ── Keys ──────────────────────────────────────────────────
export const generateApiKey = (name, scope, projectId = null, isPlayground = false, isPublicFacing = false) =>
  request("POST", "/v1/keys/generate", { name, scope, project_id: projectId, is_playground: isPlayground, is_public_facing: isPublicFacing });
export const revokeApiKey   = (keyPrefix)   => request("POST", "/v1/keys/revoke", { keyPrefix });
export const deleteApiKey   = (keyPrefix)   => request("POST", "/v1/keys/revoke", { keyPrefix }); // alias
export const updateApiKey   = (keyPrefix, scope, projectId, isPublicFacing) => request("POST", "/v1/keys/update", {
  keyPrefix,
  ...(scope          !== undefined ? { scope }                          : {}),
  ...(projectId      !== undefined ? { project_id: projectId }          : {}),
  ...(isPublicFacing  !== undefined ? { is_public_facing: isPublicFacing } : {}),
});
export const listApiKeys    = ()            => request("GET",  "/v1/keys/list");
export const revealApiKey  = (keyPrefix)   => request("POST", "/v1/keys/reveal", { keyPrefix });


// ── Usage ─────────────────────────────────────────────────
export const getUsage          = () => request("GET", "/v1/user/usage");  // Firebase auth
export const getUsageLegacy    = () => request("GET", "/v1/usage");       // API key auth


// ── Vault ─────────────────────────────────────────────────
export const storeVaultKey  = (apiKey, password, provider, defaultModel) => request("POST", "/v1/vault/store", { apiKey, password, provider, defaultModel });
export const listVaultKeys  = ()         => request("GET",    "/v1/vault/list");
export const removeVaultKey = (provider) => request("DELETE", "/v1/vault/remove", { provider });
export const verifyVaultKey = (provider, password) => request("POST", "/v1/vault/verify", { provider, password });
export const updateVaultModel = (provider, defaultModel) => request("PUT", "/v1/vault/update-model", { provider, defaultModel });

// ── Logs & Analytics (NEW) ────────────────────────────────
export const getRequestLogs    = (limit = 5, day = null, cursor = null) => {
  let path = `/v1/logs?limit=${limit}`;
  if (day) path += `&day=${day}`;
  if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
  return request("GET", path);
};
export const getUsageAnalytics = (days = 7) => request("GET", `/v1/analytics?days=${days}`);

// ── User (NEW) ────────────────────────────────────────────
export const registerUser     = ()         => request("POST", "/v1/user/register");
export const getUserSettings  = ()         => request("GET",  "/v1/user/settings");
export const updateSettings   = (settings) => request("PUT",  "/v1/user/settings", { settings });
export const updateIPAllowlist = (ips)     => request("PUT",  "/v1/user/ip-allowlist", { ips });
export const getActiveBroadcasts = ()      => request("GET",  "/v1/user/broadcasts/active");

// ── Providers (NEW) ───────────────────────────────────────
export const getProviders = () => request("GET", "/v1/providers");

// ── Projects ──────────────────────────────────────────────
export const createProject       = (name)               => request("POST",   "/v1/projects/create",        { name });
export const listProjects        = ()                   => request("GET",    "/v1/projects/list");
export const getProjectDetails   = (projectId)          => request("GET",    `/v1/projects/${projectId}`);
export const updateProjectName   = (projectId, name)    => request("POST",   "/v1/projects/update",        { projectId, name });
export const deleteProject       = (projectId)          => request("DELETE", "/v1/projects/delete",        { projectId });
export const toggleProjectMemory = (projectId, enable)  => request("POST",   "/v1/projects/memory/toggle", { projectId, enable });
export const clearProjectMemory  = (projectId)          => request("DELETE", "/v1/projects/memory/clear",  { projectId });

// ── Memory (dashboard inspect) ────────────────────────────
export const getProjectMemory    = (projectId)          => request("GET",    `/v1/memory/${projectId}`);

// ── Memory Fine Tune (per-agent manual facts) ─────────────
export const addMemoryFact    = (projectId, fact, scope, visibility) =>
  request("POST", "/v1/memory/manual-add", { project_id: projectId, fact, scope, visibility });
export const deleteMemoryFact = (projectId, fact, scope) =>
  request("POST", "/v1/memory/manual-delete", { project_id: projectId, fact, scope });

// ── Playground ────────────────────────────────────────────
export async function sendPlaygroundRequest(apiKeyRaw, encPassword, agent, message, model, provider, conversationId) {
  const path = agent === "chat" ? "/v1/chat" : `/v1/agent/${agent}`;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKeyRaw}`,
    "X-Encryption-Password": encPassword,
  };
  const body = { message, provider: provider || "gemini" };
  if (model) body.model = model;
  if (conversationId) body.conversation_id = conversationId;

  const res = await fetch(`${API_BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  
  if (!res.ok) {
    let errorDetail = `Playground Error ${res.status}`;
    try {
      const errData = await res.json();
      errorDetail = errData.error?.message || errData.error?.detail || errorDetail;
    } catch(e) {
      const text = await res.text();
      if (text) errorDetail += `: ${text}`;
    }
    throw new Error(errorDetail);
  }
  
  return await res.json();
}

// ── Billing & Subscriptions ────────────────────────────────────────────────
export const getBillingStatus   = ()       => request("GET",  "/v1/billing/status");
export const createOrder        = (plan)   => request("POST", "/v1/billing/create-order", { plan });
export const verifyPayment      = (orderId)=> request("POST", "/v1/billing/verify", { orderId });
export const getBillingHistory  = (limit = 3, cursor = null) => {
  let path = `/v1/billing/history?limit=${limit}`;
  if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
  return request("GET", path);
};

// ── MCP Vault ──────────────────────────────────────────────────────────────
export const getMcpVaultStatus  = ()             => request("GET",    "/v1/mcp-vault/status");
export const enableMcpVault     = (vaultPassword)=> request("POST",   "/v1/mcp-vault/enable",  { vaultPassword });
export const syncMcpVault       = (vaultPassword)=> request("POST",   "/v1/mcp-vault/sync",    { vaultPassword });
export const disableMcpVault    = ()             => request("DELETE",  "/v1/mcp-vault/disable");
