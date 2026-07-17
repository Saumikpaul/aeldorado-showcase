// core/project-manager.js — Project Management & Memory Gate
// Aeldorado by Solanacy Technologies
//
// Projects group multiple API keys under a shared identity.
// Memory is per-project (not per-key) and gated behind paid tiers.

import crypto from "crypto";
import { logger } from "./logger.js";

// Tiers that can use memory
const MEMORY_ALLOWED_TIERS = ["starter", "pro", "developer"];
const MAX_PROJECTS_PER_USER = 10;

/**
 * Generate a unique project ID.
 */
function generateProjectId() {
  return `proj_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * Check if a tier is allowed to use memory.
 * Free tier → always false (hard-gated server-side).
 */
export function canUseMemory(tier) {
  return MEMORY_ALLOWED_TIERS.includes(tier);
}

/**
 * Create a new project.
 *
 * @param {object} db
 * @param {string} userId
 * @param {string} name
 * @param {string} tier
 * @returns {Promise<{ projectId, name, memoryEnabled, tier }>}
 */
export async function createProject(db, userId, name, tier) {
  // Count existing projects
  const existingSnap = await db.collection("projects")
    .where("userId", "==", userId)
    .get();

  if (existingSnap.size >= MAX_PROJECTS_PER_USER) {
    throw Object.assign(new Error(`Maximum ${MAX_PROJECTS_PER_USER} projects per account.`), { code: "LIMIT_EXCEEDED" });
  }

  const projectId = generateProjectId();

  await db.collection("projects").doc(projectId).set({
    userId,
    name:          name || `Project ${existingSnap.size + 1}`,
    tier,
    memoryEnabled: false,   // OFF by default
    createdAt:     new Date().toISOString(),
    updatedAt:     new Date().toISOString(),
  });

  logger.info("Project created", { projectId, userId });

  return {
    projectId,
    name:          name || `Project ${existingSnap.size + 1}`,
    memoryEnabled: false,
    tier,
  };
}

/**
 * Get a project by ID, verifying ownership.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getProject(db, projectId, userId) {
  try {
    const snap = await db.collection("projects").doc(projectId).get();
    if (!snap.exists) return null;

    const data = snap.data();
    if (data.userId !== userId) return null;

    return { projectId: snap.id, ...data };
  } catch (e) {
    logger.error("getProject failed", { error: e.message, projectId });
    return null;
  }
}

/**
 * List all projects for a user.
 *
 * @param {object} db
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function listProjects(db, userId) {
  try {
    const snap = await db.collection("projects")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();

    return snap.docs.map(doc => ({ projectId: doc.id, ...doc.data() }));
  } catch (e) {
    logger.error("listProjects failed", { error: e.message, userId });
    return [];
  }
}

/**
 * Enable or disable memory for a project.
 * Free tier cannot enable — enforced here.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} userId
 * @param {string} tier
 * @param {boolean} enable
 * @returns {Promise<{ success: boolean, memoryEnabled: boolean, reason?: string }>}
 */
export async function setMemoryEnabled(db, projectId, userId, tier, enable) {
  if (enable && !canUseMemory(tier)) {
    return {
      success: false,
      memoryEnabled: false,
      reason: "Memory is not available on the free tier. Upgrade to Starter or Pro.",
    };
  }

  const project = await getProject(db, projectId, userId);
  if (!project) {
    return { success: false, memoryEnabled: false, reason: "Project not found." };
  }

  await db.collection("projects").doc(projectId).update({
    memoryEnabled: enable,
    updatedAt:     new Date().toISOString(),
  });

  logger.info("Memory toggled", { projectId, userId, enabled: enable });

  return { success: true, memoryEnabled: enable };
}

/**
 * Delete a project and its memory.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function deleteProject(db, projectId, userId) {
  const project = await getProject(db, projectId, userId);
  if (!project) return false;

  // Delete project doc
  await db.collection("projects").doc(projectId).delete();

  // Delete memory doc if exists
  await db.collection("project_memory").doc(projectId).delete().catch(() => {});

  logger.info("Project deleted", { projectId, userId });
  return true;
}

/**
 * Update project name.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} userId
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function updateProjectName(db, projectId, userId, name) {
  const project = await getProject(db, projectId, userId);
  if (!project) return false;

  await db.collection("projects").doc(projectId).update({
    name,
    updatedAt: new Date().toISOString(),
  });
  return true;
}
