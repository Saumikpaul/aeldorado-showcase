// routes/keys.js — API Key Management
// Aeldorado by Solanacy Technologies
//
// API keys support SCOPING:
// - scope: "auto"       → Only works on POST /v1/chat (auto-routing, higher token usage)
// - scope: "agent:cfo"  → Only works on POST /v1/agent/cfo (specific agent, lower tokens)
// - scope: "all"        → Works on all /v1 endpoints (auto + all agents)

import { Router } from "express";
import { generateApiKey, verifyFirebaseToken } from "../core/auth.js";
import { sendError } from "../core/errors.js";

export const keysRouter = Router();

// Valid agent scopes
const VALID_AGENTS = ["ceo", "cfo", "sales", "support", "research", "marketing", "legal"];
const VALID_SCOPES = ["all", "auto", "mcp", ...VALID_AGENTS.map(a => `agent:${a}`)];

// Estimated token consumption info per scope
const SCOPE_INFO = {
  all: {
    description: "Full access — auto-routing + all agents",
    estimatedTokens: "Variable (2,000–15,000 per call)",
    note: "Auto-routing via CEO may consult multiple agents, consuming more tokens.",
  },
  auto: {
    description: "Auto-routing only (POST /v1/chat)",
    estimatedTokens: "~5,000–15,000 per call",
    note: "CEO analyzes your message, routes to 1-3 agents, synthesizes results. Higher token usage.",
  },
  mcp: {
    description: "Full MCP (Model Context Protocol) access — all agents + dashboard operations",
    estimatedTokens: "Variable (1,000–15,000 per call)",
    note: "For AI clients (Claude Desktop, Cursor, VS Code). Full platform access via MCP protocol.",
  },
};
// Agent-specific scopes
for (const agent of VALID_AGENTS) {
  SCOPE_INFO[`agent:${agent}`] = {
    description: `Direct access to ${agent.toUpperCase()} agent only`,
    estimatedTokens: "~1,000–4,000 per call",
    note: "Single agent call — most token-efficient option.",
  };
}

/**
 * Middleware: Require Firebase Auth token (dashboard access).
 */
async function requireAuth(req, res, next) {
  const decoded = await verifyFirebaseToken(req.adminAuth, req);
  if (!decoded) return sendError(res, "INVALID_AUTH_TOKEN");
  req.decoded = decoded;
  req.userId  = decoded.uid;
  next();
}

// ── POST /v1/keys/generate — Generate a new API key ─────────────────────────
keysRouter.post("/generate", requireAuth, async (req, res) => {
  const { name, scope, project_id, is_playground, is_public_facing } = req.body;
  const userId = req.userId;

  // Validate scope
  const keyScope = scope || "all";
  if (!VALID_SCOPES.includes(keyScope)) {
    return sendError(res, "INVALID_REQUEST", `Invalid scope "${scope}". Valid: ${VALID_SCOPES.join(", ")}`);
  }

  try {
    // Check existing key count (max 10 per user)
    const existingSnap = await req.db.collection("api_keys")
      .where("userId", "==", userId)
      .get();

    const activeKeysCount = existingSnap.docs.filter(doc => doc.data().isActive === true).length;

    if (activeKeysCount >= 10) {
      return sendError(res, "INVALID_REQUEST", "Maximum 10 active API keys per account.");
    }

    // Get user's tier
    const userSnap = await req.db.collection("users").doc(userId).get();
    const tier = userSnap.exists ? (userSnap.data().tier || "free") : "free";

    // Validate project_id if provided
    if (project_id) {
      const projSnap = await req.db.collection("projects").doc(project_id).get();
      if (!projSnap.exists || projSnap.data().userId !== userId) {
        return sendError(res, "INVALID_REQUEST", "Project not found or does not belong to you.");
      }
    }

    // is_playground: only for playground keys, enables conversation_id / 24hr history
    const isPlaygroundKey = is_playground === true;

    // is_public_facing: for customer-facing widgets — memory reads/writes are
    // restricted to "public"-visibility facts only, never "internal" ones.
    // A key cannot be both playground AND public-facing.
    const isPublicFacing = is_public_facing === true && !isPlaygroundKey;

    // Generate key
    const { raw, hash, prefix } = generateApiKey();

    // Store in Firestore (hash as document ID for O(1) lookup)
    await req.db.collection("api_keys").doc(hash).set({
      userId,
      rawKey:          raw,
      keyPrefix:       prefix,
      name:            name || `Key ${existingSnap.size + 1}`,
      scope:           keyScope,
      tier,
      isActive:        true,
      projectId:       project_id || null,
      isPlaygroundKey: isPlaygroundKey,
      isPublicFacing:  isPublicFacing,
      createdAt:       new Date().toISOString(),
      lastUsed:        null,
    });

    // Return full key ONCE — it will never be shown again
    res.status(201).json({
      key:              raw,
      name:             name || `Key ${existingSnap.size + 1}`,
      prefix:           prefix,
      scope:            keyScope,
      scopeInfo:        SCOPE_INFO[keyScope],
      tier,
      project_id:       project_id || null,
      is_playground:    isPlaygroundKey,
      is_public_facing: isPublicFacing,
      warning:          "Save this key now — it will never be shown again.",
      meta:             { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    console.error("[KEYS] Generation failed:", e.message);
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── POST /v1/keys/revoke — Hard delete an API key from DB ────────────────────
keysRouter.post("/revoke", requireAuth, async (req, res) => {
  const { keyPrefix } = req.body;
  if (!keyPrefix) return sendError(res, "INVALID_REQUEST", "keyPrefix is required.");

  try {
    const snap = await req.db.collection("api_keys")
      .where("userId", "==", req.userId)
      .where("keyPrefix", "==", keyPrefix)
      .limit(1)
      .get();

    if (snap.empty) return sendError(res, "INVALID_API_KEY", "No key found with that prefix.");

    // Hard delete — DB theke puropoluri remove
    await snap.docs[0].ref.delete();

    res.json({
      deleted: true,
      prefix:  keyPrefix,
      meta:    { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    console.error("[KEYS] Delete failed:", e.message);
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── POST /v1/keys/update — Update an API key scope and/or project ──────────
keysRouter.post("/update", requireAuth, async (req, res) => {
  const { keyPrefix, scope, project_id, is_public_facing } = req.body;

  if (!keyPrefix) {
    return sendError(res, "INVALID_REQUEST", "keyPrefix is required.");
  }
  if (!scope && project_id === undefined && is_public_facing === undefined) {
    return sendError(res, "INVALID_REQUEST", "At least one of scope, project_id, or is_public_facing is required.");
  }
  if (scope && !VALID_SCOPES.includes(scope)) {
    return sendError(res, "INVALID_REQUEST", `Invalid scope. Valid scopes: ${VALID_SCOPES.join(", ")}`);
  }

  try {
    const snap = await req.db.collection("api_keys")
      .where("userId", "==", req.userId)
      .where("keyPrefix", "==", keyPrefix)
      .where("isActive", "==", true)
      .limit(1)
      .get();

    if (snap.empty) {
      return sendError(res, "INVALID_API_KEY", "No active key found with that prefix.");
    }

    const existing = snap.docs[0].data();

    // Validate project_id ownership if provided and not null
    if (project_id) {
      const projSnap = await req.db.collection("projects").doc(project_id).get();
      if (!projSnap.exists || projSnap.data().userId !== req.userId) {
        return sendError(res, "INVALID_REQUEST", "Project not found or does not belong to you.");
      }
    }

    // A key can't be both a playground key and public-facing
    if (is_public_facing === true && existing.isPlaygroundKey) {
      return sendError(res, "INVALID_REQUEST", "Playground keys cannot be marked public-facing.");
    }

    const updatePayload = {};
    if (scope)                   updatePayload.scope     = scope;
    if (project_id !== undefined) updatePayload.projectId = project_id || null; // null = unlink
    if (is_public_facing !== undefined) updatePayload.isPublicFacing = is_public_facing === true;

    await snap.docs[0].ref.update(updatePayload);

    res.json({
      updated:          true,
      prefix:           keyPrefix,
      scope:            scope      || existing.scope,
      project_id:       project_id !== undefined ? (project_id || null) : existing.projectId,
      is_public_facing: is_public_facing !== undefined ? (is_public_facing === true) : (existing.isPublicFacing || false),
    });
  } catch (e) {
    console.error("[KEYS] Update failed:", e.message);
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── GET /v1/keys/list — List user's API keys (masked) ────────────────────────
keysRouter.get("/list", requireAuth, async (req, res) => {
  try {
    const snap = await req.db.collection("api_keys").where("userId", "==", req.userId).get();

    const keys = snap.docs.map(doc => {
      const d = doc.data();
      return {
        rawKey:          null,  // Not returned in list for security — use POST /v1/keys/reveal
        prefix:          d.keyPrefix,
        name:            d.name,
        scope:           d.scope,
        scopeInfo:       SCOPE_INFO[d.scope],
        tier:            d.tier,
        projectId:       d.projectId       || null,
        isPlaygroundKey: d.isPlaygroundKey  || false,
        isPublicFacing:  d.isPublicFacing   || false,
        createdAt:       d.createdAt,
        lastUsed:        d.lastUsed        || null,
      };
    });

    res.json({
      keys,
      total:      keys.length,
      active:     keys.length,
      scopeGuide: SCOPE_INFO,
      meta:       { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    console.error("[KEYS] List failed:", e.message);
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── POST /v1/keys/reveal — Return raw key for a given prefix ─────────────────
keysRouter.post("/reveal", requireAuth, async (req, res) => {
  const { keyPrefix } = req.body;
  if (!keyPrefix) return sendError(res, "INVALID_REQUEST", "keyPrefix is required.");

  try {
    const snap = await req.db.collection("api_keys")
      .where("userId", "==", req.userId)
      .where("keyPrefix", "==", keyPrefix)
      .limit(1)
      .get();

    if (snap.empty) return sendError(res, "INVALID_API_KEY", "No key found with that prefix.");

    res.json({
      rawKey: snap.docs[0].data().rawKey,
      prefix: keyPrefix,
      meta:   { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    sendError(res, "INTERNAL_ERROR");
  }
});

