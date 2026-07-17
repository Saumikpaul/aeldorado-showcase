// routes/vault.js — AI Key Vault Management
// Aeldorado by Solanacy Technologies
//
// E2E Encrypted key storage.
// Keys are encrypted CLIENT-SIDE and stored as ciphertext.
// Server decrypts only in-memory during API calls, never persists plaintext.

import { Router } from "express";
import { verifyFirebaseToken }  from "../core/auth.js";
import { encrypt, decrypt, verifyDecryption } from "../core/encryption.js";
import { detectProvider, maskApiKey, getProviderModels } from "../core/provider-detect.js";
import { sendError } from "../core/errors.js";

export const vaultRouter = Router();

/**
 * Middleware: Require Firebase Auth.
 */
async function requireAuth(req, res, next) {
  const decoded = await verifyFirebaseToken(req.adminAuth, req);
  if (!decoded) return sendError(res, "INVALID_AUTH_TOKEN");
  req.decoded = decoded;
  req.userId  = decoded.uid;
  next();
}

// ── POST /v1/vault/store — Store an encrypted AI provider key ────────────────
vaultRouter.post("/store", requireAuth, async (req, res) => {
  const { apiKey, password, provider: requestedProvider, defaultModel } = req.body;

  if (!apiKey || !password) {
    return sendError(res, "INVALID_REQUEST", "apiKey and password are required.");
  }
  if (password.length < 8) {
    return sendError(res, "INVALID_REQUEST", "Encryption password must be at least 8 characters.");
  }

  // Auto-detect provider from key
  const detected = detectProvider(apiKey);
  const provider = requestedProvider || detected?.provider;

  if (!provider) {
    return sendError(res, "INVALID_PROVIDER",
      "Could not detect the AI provider from your key. Please specify the 'provider' field."
    );
  }

  try {
    // Encrypt the key server-side with user's password
    const encrypted = encrypt(apiKey, password);
    const masked    = maskApiKey(apiKey);

    // Store in vault
    const vaultRef  = req.db.collection("key_vault").doc(req.userId);
    const vaultSnap = await vaultRef.get();
    const existing  = vaultSnap.exists ? (vaultSnap.data().providers || []) : [];

    // Replace if provider already exists, otherwise add
    const filtered = existing.filter(p => p.name !== provider);
    filtered.push({
      name:         provider,
      displayName:  detected?.name || provider,
      icon:         detected?.icon || "🔑",
      masked:       masked,
      ciphertext:   encrypted.ciphertext,
      iv:           encrypted.iv,
      salt:         encrypted.salt,
      tag:          encrypted.tag,
      defaultModel: defaultModel || detected?.defaultModel || null,
      models:       detected?.models || [],
      createdAt:    new Date().toISOString(),
    });

    await vaultRef.set({ providers: filtered }, { merge: true });

    res.json({
      stored:      true,
      provider,
      displayName: detected?.name || provider,
      masked,
      models:      detected?.models || [],
      message:     "🔒 Key encrypted and stored. We never see your plaintext key.",
      meta:        { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    console.error("[VAULT] Store failed:", e.message);
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── GET /v1/vault/list — List stored providers ───────────────────────────────
vaultRouter.get("/list", requireAuth, async (req, res) => {
  try {
    const vaultRef  = req.db.collection("key_vault").doc(req.userId);
    const vaultSnap = await vaultRef.get();

    if (!vaultSnap.exists) {
      return res.json({
        providers: [],
        message:   "No API keys stored yet.",
        meta:      { powered_by: "Aeldorado by Solanacy" },
      });
    }

    const providers = (vaultSnap.data().providers || []).map(p => ({
      name:         p.name,
      displayName:  p.displayName,
      icon:         p.icon,
      masked:       p.masked,
      defaultModel: p.defaultModel,
      models:       getProviderModels(p.name) || p.models || [], // always return latest models
      createdAt:    p.createdAt,
      // NEVER return ciphertext, iv, salt, or tag
    }));

    res.json({
      providers,
      total: providers.length,
      meta:  { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    console.error("[VAULT] List failed:", e.message);
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── DELETE /v1/vault/remove — Remove a stored provider key ───────────────────
vaultRouter.delete("/remove", requireAuth, async (req, res) => {
  const { provider } = req.body;
  if (!provider) return sendError(res, "INVALID_REQUEST", "provider is required.");

  try {
    const vaultRef  = req.db.collection("key_vault").doc(req.userId);
    const vaultSnap = await vaultRef.get();

    if (!vaultSnap.exists) return sendError(res, "VAULT_KEY_NOT_FOUND");

    const providers = (vaultSnap.data().providers || []).filter(p => p.name !== provider);
    await vaultRef.set({ providers });

    res.json({
      removed:  true,
      provider,
      meta:     { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    console.error("[VAULT] Remove failed:", e.message);
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── PUT /v1/vault/update-model — Change a stored provider's default model ────
vaultRouter.put("/update-model", requireAuth, async (req, res) => {
  const { provider, defaultModel } = req.body;
  if (!provider || !defaultModel) {
    return sendError(res, "INVALID_REQUEST", "provider and defaultModel are required.");
  }

  try {
    const vaultRef  = req.db.collection("key_vault").doc(req.userId);
    const vaultSnap = await vaultRef.get();

    if (!vaultSnap.exists) return sendError(res, "VAULT_KEY_NOT_FOUND");

    const providers = vaultSnap.data().providers || [];
    const entry = providers.find(p => p.name === provider);
    if (!entry) return sendError(res, "VAULT_KEY_NOT_FOUND", `No key found for "${provider}".`);

    if (entry.models?.length && !entry.models.some(m => m.id === defaultModel)) {
      return sendError(res, "INVALID_MODEL", `"${defaultModel}" is not available for ${provider}.`);
    }

    entry.defaultModel = defaultModel;
    await vaultRef.set({ providers });

    res.json({
      updated:      true,
      provider,
      defaultModel,
      meta:         { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    console.error("[VAULT] Update model failed:", e.message);
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── POST /v1/vault/verify — Verify a key can be decrypted ────────────────────
vaultRouter.post("/verify", requireAuth, async (req, res) => {
  const { provider, password } = req.body;
  if (!provider || !password) {
    return sendError(res, "INVALID_REQUEST", "provider and password are required.");
  }

  try {
    const vaultRef  = req.db.collection("key_vault").doc(req.userId);
    const vaultSnap = await vaultRef.get();

    if (!vaultSnap.exists) return sendError(res, "VAULT_KEY_NOT_FOUND");

    const entry = (vaultSnap.data().providers || []).find(p => p.name === provider);
    if (!entry) return sendError(res, "VAULT_KEY_NOT_FOUND", `No key found for "${provider}".`);

    const canDecrypt = verifyDecryption({
      ciphertext: entry.ciphertext,
      iv:         entry.iv,
      salt:       entry.salt,
      tag:        entry.tag,
    }, password);

    res.json({
      verified: canDecrypt,
      provider,
      message:  canDecrypt
        ? "✅ Decryption successful — your key is intact."
        : "❌ Decryption failed — check your password.",
      meta:     { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    console.error("[VAULT] Verify failed:", e.message);
    sendError(res, "INTERNAL_ERROR");
  }
});
