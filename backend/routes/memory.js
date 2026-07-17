// routes/memory.js — Manual Memory Management (Public API)
// Aeldorado by Solanacy Technologies
//
// POST /v1/memory/remember — manually save a fact to project memory
// GET  /v1/memory/:projectId — inspect memory (requires Firebase auth)

import { Router } from "express";
import { apiPipeline }        from "../middleware/pipeline.js";
import { verifyFirebaseToken } from "../core/auth.js";
import { sendError }          from "../core/errors.js";
import { canUseMemory }       from "../core/project-manager.js";
import { addFactManually, getMemory, clearMemory, deleteFact, VALID_AGENTS } from "../core/memory.js";

export const memoryRouter = Router();

// ── Dashboard auth middleware ─────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const decoded = await verifyFirebaseToken(req.adminAuth, req);
  if (!decoded) return sendError(res, "INVALID_AUTH_TOKEN");
  req.decoded = decoded;
  req.userId  = decoded.uid;
  next();
}

// ── POST /v1/memory/remember — API-key authenticated (public) ─────────────────
// Saves a fact to the project memory pool.
// Requires the key to have a projectId attached, and project memory enabled.
memoryRouter.post("/remember", ...apiPipeline(), async (req, res) => {
  const { fact, project_id } = req.body;

  if (!fact || typeof fact !== "string" || !fact.trim()) {
    return sendError(res, "INVALID_REQUEST", "\"fact\" field is required (non-empty string).");
  }
  if (!project_id) {
    return sendError(res, "INVALID_REQUEST", "\"project_id\" is required.");
  }

  // Memory is gated behind paid tiers
  if (!canUseMemory(req.tier)) {
    return sendError(res, "INSUFFICIENT_PERMISSION",
      "Memory requires Starter or Pro tier. Upgrade to use this endpoint."
    );
  }

  try {
    // Verify the key belongs to this project
    const projectIdOnKey = req.keyDoc?.projectId || null;
    if (projectIdOnKey !== project_id) {
      return sendError(res, "INSUFFICIENT_PERMISSION",
        "This API key is not associated with the specified project."
      );
    }

    // Check project exists and memory is enabled
    const projSnap = await req.db.collection("projects").doc(project_id).get();
    if (!projSnap.exists || projSnap.data().userId !== req.userId) {
      return sendError(res, "AGENT_NOT_FOUND", "Project not found.");
    }
    if (!projSnap.data().memoryEnabled) {
      return sendError(res, "INSUFFICIENT_PERMISSION",
        "Memory is disabled for this project. Enable it via the dashboard."
      );
    }

    const added = await addFactManually(req.db, project_id, fact.trim());

    res.json({
      remembered: true,
      duplicate:  !added,
      fact:       fact.trim(),
      project_id,
      meta:       { powered_by: "Aeldorado by Solanacy" },
    });
  } catch {
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── POST /v1/memory/manual-add — Dashboard auth (Fine Tune page) ─────────────
// Add a fact with explicit scope (universal or per-agent) and visibility.
memoryRouter.post("/manual-add", requireAuth, async (req, res) => {
  const { project_id, fact, scope, visibility } = req.body;

  if (!fact || typeof fact !== "string" || !fact.trim()) {
    return sendError(res, "INVALID_REQUEST", "\"fact\" field is required (non-empty string).");
  }
  if (!project_id) {
    return sendError(res, "INVALID_REQUEST", "\"project_id\" is required.");
  }
  if (scope && scope !== "universal" && !VALID_AGENTS.includes(scope.replace(/^agent:/, ""))) {
    return sendError(res, "INVALID_REQUEST",
      `Invalid scope. Use "universal" or one of: ${VALID_AGENTS.map(a => `agent:${a}`).join(", ")}`
    );
  }
  if (visibility && !["internal", "public"].includes(visibility)) {
    return sendError(res, "INVALID_REQUEST", "visibility must be \"internal\" or \"public\".");
  }

  try {
    const projSnap = await req.db.collection("projects").doc(project_id).get();
    if (!projSnap.exists || projSnap.data().userId !== req.userId) {
      return sendError(res, "AGENT_NOT_FOUND", "Project not found.");
    }

    const added = await addFactManually(req.db, project_id, fact.trim(), { scope, visibility });

    res.json({
      added,
      duplicate: !added,
      fact:      fact.trim(),
      scope:     scope || "universal",
      visibility: visibility || "internal",
      project_id,
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch {
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── POST /v1/memory/manual-delete — Dashboard auth (Fine Tune page) ──────────
memoryRouter.post("/manual-delete", requireAuth, async (req, res) => {
  const { project_id, fact, scope } = req.body;

  if (!fact || !project_id) {
    return sendError(res, "INVALID_REQUEST", "\"fact\" and \"project_id\" are required.");
  }

  try {
    const projSnap = await req.db.collection("projects").doc(project_id).get();
    if (!projSnap.exists || projSnap.data().userId !== req.userId) {
      return sendError(res, "AGENT_NOT_FOUND", "Project not found.");
    }

    const deleted = await deleteFact(req.db, project_id, fact, scope);

    res.json({
      deleted,
      project_id,
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch {
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── GET /v1/memory/:projectId — Dashboard auth (admin) ───────────────────────
memoryRouter.get("/:projectId", requireAuth, async (req, res) => {
  const { projectId } = req.params;

  try {
    // Verify ownership via projects collection
    const projSnap = await req.db.collection("projects").doc(projectId).get();
    if (!projSnap.exists || projSnap.data().userId !== req.userId) {
      return sendError(res, "AGENT_NOT_FOUND", "Project not found.");
    }

    const mem = await getMemory(req.db, projectId);

    if (!mem) {
      return res.json({
        projectId,
        facts:            [],
        summary:          null,
        lastUpdated:      null,
        totalExtractions: 0,
        validAgents:      VALID_AGENTS,
        meta:             { powered_by: "Aeldorado by Solanacy" },
      });
    }

    res.json({
      projectId,
      facts:            mem.facts            || [],
      summary:          mem.summary          || null,
      lastUpdated:      mem.lastUpdated      || null,
      totalExtractions: mem.totalExtractions || 0,
      validAgents:      VALID_AGENTS,
      meta:             { powered_by: "Aeldorado by Solanacy" },
    });
  } catch {
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── DELETE /v1/memory/:projectId — Clear memory (dashboard) ──────────────────
memoryRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const { projectId } = req.params;

  try {
    const projSnap = await req.db.collection("projects").doc(projectId).get();
    if (!projSnap.exists || projSnap.data().userId !== req.userId) {
      return sendError(res, "AGENT_NOT_FOUND", "Project not found.");
    }

    await clearMemory(req.db, projectId);

    res.json({
      cleared:   true,
      projectId,
      meta:      { powered_by: "Aeldorado by Solanacy" },
    });
  } catch {
    sendError(res, "INTERNAL_ERROR");
  }
});
