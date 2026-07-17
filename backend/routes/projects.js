// routes/projects.js — Project Management
// Aeldorado by Solanacy Technologies
//
// Projects group API keys under a shared memory pool.
// All routes require Firebase auth (dashboard only).

import { Router } from "express";
import { verifyFirebaseToken } from "../core/auth.js";
import { sendError }          from "../core/errors.js";
import {
  createProject,
  getProject,
  listProjects,
  deleteProject,
  updateProjectName,
  setMemoryEnabled,
  canUseMemory,
} from "../core/project-manager.js";
import { clearMemory, getMemory } from "../core/memory.js";

export const projectsRouter = Router();

// ── Middleware: Firebase Auth ─────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const decoded = await verifyFirebaseToken(req.adminAuth, req);
  if (!decoded) return sendError(res, "INVALID_AUTH_TOKEN");
  req.decoded = decoded;
  req.userId  = decoded.uid;
  next();
}

// ── Helper: resolve user tier from Firestore ──────────────────────────────────
async function getUserTier(db, userId) {
  try {
    const snap = await db.collection("users").doc(userId).get();
    return snap.exists ? (snap.data().tier || "free") : "free";
  } catch {
    return "free";
  }
}

// ── POST /v1/projects/create ──────────────────────────────────────────────────
projectsRouter.post("/create", requireAuth, async (req, res) => {
  const { name } = req.body;

  try {
    const tier    = await getUserTier(req.db, req.userId);
    const project = await createProject(req.db, req.userId, name, tier);

    res.status(201).json({
      ...project,
      memoryAvailable: canUseMemory(tier),
      note: canUseMemory(tier)
        ? "Memory is available for this tier. Enable it via /v1/projects/memory/toggle."
        : "Memory requires Starter or Pro tier.",
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch (e) {
    if (e.code === "LIMIT_EXCEEDED") {
      return sendError(res, "INVALID_REQUEST", e.message);
    }
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── GET /v1/projects/list ─────────────────────────────────────────────────────
projectsRouter.get("/list", requireAuth, async (req, res) => {
  try {
    const projects = await listProjects(req.db, req.userId);

    res.json({
      projects,
      total: projects.length,
      meta:  { powered_by: "Aeldorado by Solanacy" },
    });
  } catch {
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── GET /v1/projects/:projectId ───────────────────────────────────────────────
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const { projectId } = req.params;

  try {
    const project = await getProject(req.db, projectId, req.userId);
    if (!project) return sendError(res, "AGENT_NOT_FOUND", "Project not found.");

    // Attach memory doc stats if memory is enabled
    let memoryStats = null;
    if (project.memoryEnabled) {
      const mem = await getMemory(req.db, projectId);
      if (mem) {
        memoryStats = {
          factCount:        mem.facts?.length || 0,
          lastUpdated:      mem.lastUpdated || null,
          totalExtractions: mem.totalExtractions || 0,
          summaryPreview:   mem.summary ? mem.summary.slice(0, 120) + "..." : null,
        };
      }
    }

    res.json({
      ...project,
      memoryStats,
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch {
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── POST /v1/projects/update ──────────────────────────────────────────────────
projectsRouter.post("/update", requireAuth, async (req, res) => {
  const { projectId, name } = req.body;

  if (!projectId || !name) {
    return sendError(res, "INVALID_REQUEST", "projectId and name are required.");
  }

  try {
    const updated = await updateProjectName(req.db, projectId, req.userId, name);
    if (!updated) return sendError(res, "AGENT_NOT_FOUND", "Project not found.");

    res.json({ updated: true, projectId, name, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch {
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── DELETE /v1/projects/delete ────────────────────────────────────────────────
projectsRouter.delete("/delete", requireAuth, async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return sendError(res, "INVALID_REQUEST", "projectId is required.");

  try {
    const deleted = await deleteProject(req.db, projectId, req.userId);
    if (!deleted) return sendError(res, "AGENT_NOT_FOUND", "Project not found.");

    res.json({ deleted: true, projectId, meta: { powered_by: "Aeldorado by Solanacy" } });
  } catch {
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── POST /v1/projects/memory/toggle ──────────────────────────────────────────
// Enable or disable memory for a project.
// Free tier: hard-blocked server-side.
projectsRouter.post("/memory/toggle", requireAuth, async (req, res) => {
  const { projectId, enable } = req.body;

  if (!projectId || typeof enable !== "boolean") {
    return sendError(res, "INVALID_REQUEST", "projectId and enable (boolean) are required.");
  }

  try {
    const tier   = await getUserTier(req.db, req.userId);
    const result = await setMemoryEnabled(req.db, projectId, req.userId, tier, enable);

    if (!result.success) {
      return sendError(res, "INSUFFICIENT_PERMISSION", result.reason);
    }

    res.json({
      projectId,
      memoryEnabled: result.memoryEnabled,
      ...(enable ? { disclaimer: "Enabling memory may increase token usage per call." } : {}),
      meta: { powered_by: "Aeldorado by Solanacy" },
    });
  } catch {
    sendError(res, "INTERNAL_ERROR");
  }
});

// ── DELETE /v1/projects/memory/clear ─────────────────────────────────────────
// Wipe all memory for a project (keeps project itself intact).
projectsRouter.delete("/memory/clear", requireAuth, async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return sendError(res, "INVALID_REQUEST", "projectId is required.");

  try {
    const project = await getProject(req.db, projectId, req.userId);
    if (!project) return sendError(res, "AGENT_NOT_FOUND", "Project not found.");

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
