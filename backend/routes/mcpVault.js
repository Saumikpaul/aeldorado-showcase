// routes/mcpVault.js — MCP Agent Access Vault
// Aeldorado by Solanacy Technologies
//
// Allows users to enable MCP agent access by re-encrypting their provider
// keys with a server-side secret (MCP_SERVER_SECRET), so MCP tools can call
// agents without requiring the user's vault password at request time.
//
// Collection: mcp_vault/{userId}
//   providers: [{ name, ciphertext, iv, salt, tag }]  ← encrypted with MCP_SERVER_SECRET
//   enabledAt: ISO timestamp

import express from "express";
import { encrypt, decrypt } from "../core/encryption.js";
import { logger } from "../core/logger.js";

const MCP_SERVER_SECRET = process.env.MCP_SERVER_SECRET || null;

export const mcpVaultRouter = express.Router();

// ── GET /v1/mcp-vault/status ────────────────────────────────────────────────
// Returns whether MCP agent access is enabled for the current user
mcpVaultRouter.get("/mcp-vault/status", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const snap = await req.db.collection("mcp_vault").doc(userId).get();
    if (!snap.exists) {
      return res.json({ enabled: false });
    }

    const data = snap.data();
    const providerCount = (data.providers || []).length;
    return res.json({
      enabled: true,
      providerCount,
      enabledAt: data.enabledAt || null,
    });
  } catch (e) {
    logger.error("[MCP Vault] status error", { error: e.message });
    res.status(500).json({ error: "Internal error" });
  }
});

// ── POST /v1/mcp-vault/enable ───────────────────────────────────────────────
// Decrypts user's vault with their password, re-encrypts with MCP_SERVER_SECRET
mcpVaultRouter.post("/mcp-vault/enable", express.json(), async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    if (!MCP_SERVER_SECRET) {
      return res.status(500).json({ error: "MCP_SERVER_SECRET not configured on server." });
    }

    const { vaultPassword } = req.body || {};
    if (!vaultPassword) {
      return res.status(400).json({ error: "vaultPassword is required." });
    }

    // Load user's vault
    const vaultSnap = await req.db.collection("key_vault").doc(userId).get();
    if (!vaultSnap.exists || !(vaultSnap.data().providers || []).length) {
      return res.status(400).json({ error: "No provider keys in vault. Add at least one key first." });
    }

    const providers = vaultSnap.data().providers || [];

    // Decrypt each provider key with user's vault password, re-encrypt with MCP_SERVER_SECRET
    const mcpProviders = [];
    for (const p of providers) {
      let plainKey;
      try {
        plainKey = decrypt({
          ciphertext: p.ciphertext,
          iv: p.iv,
          salt: p.salt,
          tag: p.tag,
        }, vaultPassword);
      } catch {
        return res.status(400).json({
          error: "Incorrect vault password. Please try again.",
        });
      }

      const reEncrypted = encrypt(plainKey, MCP_SERVER_SECRET);
      mcpProviders.push({
        name: p.name,
        displayName: p.displayName,
        icon: p.icon,
        masked: p.masked,
        defaultModel: p.defaultModel || null,
        models: p.models || [],
        ciphertext: reEncrypted.ciphertext,
        iv: reEncrypted.iv,
        salt: reEncrypted.salt,
        tag: reEncrypted.tag,
      });
    }

    await req.db.collection("mcp_vault").doc(userId).set({
      providers: mcpProviders,
      enabledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    logger.info("[MCP Vault] Enabled", { userId, providerCount: mcpProviders.length });
    res.json({
      success: true,
      providerCount: mcpProviders.length,
      message: `MCP Agent Access enabled with ${mcpProviders.length} provider(s).`,
    });
  } catch (e) {
    logger.error("[MCP Vault] enable error", { error: e.message });
    res.status(500).json({ error: "Internal error" });
  }
});

// ── POST /v1/mcp-vault/sync ─────────────────────────────────────────────────
// Re-syncs if user updated their vault keys
mcpVaultRouter.post("/mcp-vault/sync", express.json(), async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    if (!MCP_SERVER_SECRET) {
      return res.status(500).json({ error: "MCP_SERVER_SECRET not configured on server." });
    }

    const { vaultPassword } = req.body || {};
    if (!vaultPassword) return res.status(400).json({ error: "vaultPassword is required." });

    const vaultSnap = await req.db.collection("key_vault").doc(userId).get();
    if (!vaultSnap.exists || !(vaultSnap.data().providers || []).length) {
      return res.status(400).json({ error: "No provider keys in vault." });
    }

    const providers = vaultSnap.data().providers || [];
    const mcpProviders = [];
    for (const p of providers) {
      let plainKey;
      try {
        plainKey = decrypt({ ciphertext: p.ciphertext, iv: p.iv, salt: p.salt, tag: p.tag }, vaultPassword);
      } catch {
        return res.status(400).json({ error: "Incorrect vault password." });
      }
      const re = encrypt(plainKey, MCP_SERVER_SECRET);
      mcpProviders.push({ name: p.name, displayName: p.displayName, icon: p.icon, masked: p.masked, defaultModel: p.defaultModel || null, models: p.models || [], ciphertext: re.ciphertext, iv: re.iv, salt: re.salt, tag: re.tag });
    }

    await req.db.collection("mcp_vault").doc(userId).set({ providers: mcpProviders, enabledAt: (await req.db.collection("mcp_vault").doc(userId).get()).data()?.enabledAt || new Date().toISOString(), updatedAt: new Date().toISOString() });

    logger.info("[MCP Vault] Synced", { userId, providerCount: mcpProviders.length });
    res.json({ success: true, providerCount: mcpProviders.length, message: `Synced ${mcpProviders.length} provider(s) successfully.` });
  } catch (e) {
    logger.error("[MCP Vault] sync error", { error: e.message });
    res.status(500).json({ error: "Internal error" });
  }
});

// ── DELETE /v1/mcp-vault/disable ────────────────────────────────────────────
// Removes MCP vault — agent calls will stop working until re-enabled
mcpVaultRouter.delete("/mcp-vault/disable", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    await req.db.collection("mcp_vault").doc(userId).delete();
    logger.info("[MCP Vault] Disabled", { userId });
    res.json({ success: true, message: "MCP Agent Access disabled." });
  } catch (e) {
    logger.error("[MCP Vault] disable error", { error: e.message });
    res.status(500).json({ error: "Internal error" });
  }
});
