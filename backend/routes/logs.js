// routes/logs.js — GET /v1/logs + GET /v1/analytics
// Aeldorado by Solanacy Technologies

import { Router } from "express";
import { getRequestLogs, getUsageAnalytics } from "../core/request-log.js";
import { sendError } from "../core/errors.js";

export const logsRouter = Router();

/**
 * GET /v1/logs — Get request logs (paginated).
 * Requires Firebase Auth token (dashboard only).
 */
logsRouter.get("/logs", async (req, res) => {
  if (!req.userId) return sendError(res, "AUTH_REQUIRED");

  const limit      = Math.min(parseInt(req.query.limit) || 5, 50);
  const dayKey      = req.query.day || null;
  const startAfter  = req.query.cursor || null; // ISO timestamp of last doc on prev page

  try {
    const result = await getRequestLogs(req.db, req.userId, { limit, dayKey, startAfter });
    res.json(result);
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});

/**
 * GET /v1/analytics — Get usage analytics (charts data).
 * Requires Firebase Auth token (dashboard only).
 */
logsRouter.get("/analytics", async (req, res) => {
  if (!req.userId) return sendError(res, "AUTH_REQUIRED");

  const days = Math.min(parseInt(req.query.days) || 7, 30);

  try {
    const analytics = await getUsageAnalytics(req.db, req.userId, days);
    analytics.meta = { powered_by: "Aeldorado by Solanacy" };
    res.json(analytics);
  } catch (e) {
    sendError(res, "SERVER_ERROR", e.message);
  }
});
