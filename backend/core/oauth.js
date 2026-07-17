// core/oauth.js — OAuth 2.0 Authorization Server for MCP
// Aeldorado by Solanacy Technologies
//
// Implements RFC 6749 (Authorization Code Grant), RFC 7636 (PKCE),
// and RFC 7591 (Dynamic Client Registration) — the subset required
// by MCP clients (Claude.ai, Claude Desktop, Cursor, etc.) to connect
// to /mcp without ever handling a raw Aeldorado API key.
//
// Collections used (Firestore):
//   oauth_clients   — registered OAuth clients (client_id, client_secret hash, redirect_uris)
//   oauth_codes     — short-lived authorization codes (10 min TTL), single-use
//   oauth_tokens    — issued access/refresh tokens, mapped to an underlying api_key hash

import crypto from "crypto";
import { logger } from "./logger.js";
import { generateApiKey } from "./auth.js";

const CODE_TTL_MS          = 10 * 60 * 1000;      // 10 minutes
const ACCESS_TOKEN_TTL_MS  = 60 * 60 * 1000;       // 1 hour
const REFRESH_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

function randomToken(prefix, bytes = 32) {
  return `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// ── Dynamic Client Registration (RFC 7591) ──────────────────────────────────
export async function registerClient(db, body) {
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    throw Object.assign(new Error("redirect_uris is required"), { status: 400 });
  }

  const clientId     = randomToken("aldo-client", 16);
  const clientSecret = randomToken("aldo-secret", 24);

  await db.collection("oauth_clients").doc(clientId).set({
    clientId,
    clientSecretHash: sha256(clientSecret),
    clientName:       body.client_name || "Unnamed MCP Client",
    redirectUris,
    grantTypes:       body.grant_types || ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethod: body.token_endpoint_auth_method || "client_secret_post",
    createdAt:        new Date().toISOString(),
  });

  return {
    client_id:                clientId,
    client_secret:            clientSecret,
    client_id_issued_at:      Math.floor(Date.now() / 1000),
    redirect_uris:            redirectUris,
    grant_types:              body.grant_types || ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: body.token_endpoint_auth_method || "client_secret_post",
  };
}

export async function getClient(db, clientId) {
  if (!clientId) return null;
  const doc = await db.collection("oauth_clients").doc(clientId).get();
  return doc.exists ? doc.data() : null;
}

export async function verifyClientSecret(db, clientId, clientSecret) {
  const client = await getClient(db, clientId);
  if (!client) return false;
  // Public clients (PKCE-only, no secret) are allowed for "none" auth method.
  if (client.tokenEndpointAuthMethod === "none") return true;
  if (!clientSecret) return false;
  return client.clientSecretHash === sha256(clientSecret);
}

// ── Authorization Code Issuance ─────────────────────────────────────────────
/**
 * Create a short-lived authorization code after the user has logged in
 * and approved the request. Binds the code to the user, client, redirect_uri,
 * and PKCE code_challenge so the token endpoint can verify everything.
 */
export async function createAuthCode(db, { clientId, redirectUri, userId, codeChallenge, codeChallengeMethod, scope }) {
  const code = randomToken("aldo-authcode", 32);
  const now  = Date.now();

  await db.collection("oauth_codes").doc(code).set({
    code,
    clientId,
    redirectUri,
    userId,
    codeChallenge:        codeChallenge || null,
    codeChallengeMethod:  codeChallengeMethod || null,
    scope:                scope || "mcp",
    createdAt:            now,
    expiresAt:            now + CODE_TTL_MS,
    used:                 false,
  });

  return code;
}

function verifyPkce(codeChallenge, codeChallengeMethod, codeVerifier) {
  if (!codeChallenge) return true; // PKCE not used by this client
  if (!codeVerifier) return false;

  if (codeChallengeMethod === "S256") {
    const hash = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    return hash === codeChallenge;
  }
  // "plain" method
  return codeVerifier === codeChallenge;
}

// ── Token Exchange: authorization_code grant ────────────────────────────────
export async function exchangeAuthCode(db, { code, clientId, redirectUri, codeVerifier }) {
  const ref  = db.collection("oauth_codes").doc(code);
  const snap = await ref.get();

  if (!snap.exists) {
    throw Object.assign(new Error("invalid_grant: code not found"), { status: 400, oauthError: "invalid_grant" });
  }

  const data = snap.data();

  if (data.used) {
    throw Object.assign(new Error("invalid_grant: code already used"), { status: 400, oauthError: "invalid_grant" });
  }
  if (Date.now() > data.expiresAt) {
    throw Object.assign(new Error("invalid_grant: code expired"), { status: 400, oauthError: "invalid_grant" });
  }
  if (data.clientId !== clientId) {
    throw Object.assign(new Error("invalid_grant: client mismatch"), { status: 400, oauthError: "invalid_grant" });
  }
  if (data.redirectUri !== redirectUri) {
    throw Object.assign(new Error("invalid_grant: redirect_uri mismatch"), { status: 400, oauthError: "invalid_grant" });
  }
  if (!verifyPkce(data.codeChallenge, data.codeChallengeMethod, codeVerifier)) {
    throw Object.assign(new Error("invalid_grant: PKCE verification failed"), { status: 400, oauthError: "invalid_grant" });
  }

  // Mark used immediately (single-use codes)
  await ref.update({ used: true });

  return issueTokenPair(db, { userId: data.userId, clientId, scope: data.scope });
}

// ── Token Exchange: refresh_token grant ─────────────────────────────────────
export async function exchangeRefreshToken(db, { refreshToken, clientId }) {
  const hash = sha256(refreshToken);
  const snap = await db.collection("oauth_tokens").where("refreshTokenHash", "==", hash).limit(1).get();

  if (snap.empty) {
    throw Object.assign(new Error("invalid_grant: refresh token not recognized"), { status: 400, oauthError: "invalid_grant" });
  }

  const doc  = snap.docs[0];
  const data = doc.data();

  if (data.clientId !== clientId) {
    throw Object.assign(new Error("invalid_grant: client mismatch"), { status: 400, oauthError: "invalid_grant" });
  }
  if (data.refreshExpiresAt && Date.now() > data.refreshExpiresAt) {
    throw Object.assign(new Error("invalid_grant: refresh token expired"), { status: 400, oauthError: "invalid_grant" });
  }

  // Revoke old token record, issue a fresh pair (rotation)
  await doc.ref.delete().catch(() => {});

  return issueTokenPair(db, { userId: data.userId, clientId, scope: data.scope, apiKeyHash: data.apiKeyHash });
}

// ── Core: mint access + refresh tokens, bound to an mcp-scoped API key ──────
async function issueTokenPair(db, { userId, clientId, scope, apiKeyHash }) {
  const keyHash = apiKeyHash || await ensureMcpApiKey(db, userId);

  const accessToken  = randomToken("aldo-at", 32);
  const refreshToken = randomToken("aldo-rt", 32);
  const now = Date.now();

  await db.collection("oauth_tokens").doc(sha256(accessToken)).set({
    accessTokenHash:  sha256(accessToken),
    refreshTokenHash: sha256(refreshToken),
    userId,
    clientId,
    scope,
    apiKeyHash: keyHash,
    createdAt:  now,
    expiresAt:  now + ACCESS_TOKEN_TTL_MS,
    refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
  });

  return {
    access_token:  accessToken,
    refresh_token: refreshToken,
    token_type:    "Bearer",
    expires_in:    Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope,
  };
}

/**
 * Find an existing active "mcp"/"all" scoped API key for this user, or
 * auto-create one named "MCP (OAuth)" if none exists yet.
 */
async function ensureMcpApiKey(db, userId) {
  const existing = await db.collection("api_keys")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .get();

  const mcpKey = existing.docs.find(d => {
    const scope = d.data().scope;
    return scope === "mcp" || scope === "all";
  });

  if (mcpKey) return mcpKey.id; // doc ID is the SHA-256 hash

  const { raw, hash } = generateApiKey();
  await db.collection("api_keys").doc(hash).set({
    userId,
    rawKey:          raw,
    keyPrefix:       raw.slice(0, 14),
    name:            "MCP (OAuth)",
    scope:           "mcp",
    tier:            "free",
    isActive:        true,
    projectId:        null,
    isPlaygroundKey: false,
    isPublicFacing:  false,
    createdAt:       new Date().toISOString(),
    lastUsed:        null,
    issuedViaOAuth:  true,
  });

  logger.info("Auto-created mcp-scoped API key via OAuth", { userId });
  return hash;
}

// ── Verify an OAuth access token presented to /mcp ──────────────────────────
/**
 * @returns {Promise<{ valid: boolean, apiKeyHash?: string, userId?: string }>}
 */
export async function verifyAccessToken(db, accessToken) {
  if (!accessToken) return { valid: false };

  const hash = sha256(accessToken);
  const doc  = await db.collection("oauth_tokens").doc(hash).get();
  if (!doc.exists) return { valid: false };

  const data = doc.data();
  if (Date.now() > data.expiresAt) return { valid: false, expired: true };

  return { valid: true, apiKeyHash: data.apiKeyHash, userId: data.userId };
}

export { CODE_TTL_MS, ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS };
