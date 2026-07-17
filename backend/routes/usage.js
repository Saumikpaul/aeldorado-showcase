// routes/usage.js — GET /v1/usage — Usage Stats & Limits
// Aeldorado by Solanacy Technologies

import { Router } from "express";
import { extractApiKey, verifyApiKey } from "../core/auth.js";
import { getUsageStats }              from "../core/billing.js";
import { sendError }                  from "../core/errors.js";
import { logger }                     from "../core/logger.js";

export const usageRouter = Router();

// ── GET /v1/usage ────────────────────────────────────────────────────────────
usageRouter.get("/usage", async (req, res) => {
  const rawKey = extractApiKey(req);
  if (!rawKey) return sendError(res, "MISSING_API_KEY");

  const result = await verifyApiKey(req.db, rawKey);
  if (!result.valid) return sendError(res, "INVALID_API_KEY");

  try {
    const stats = await getUsageStats(req.db, result.userId, result.tier);
    res.json(stats);
  } catch (e) {
    logger.error("Usage stats fetch failed", { error: e.message, userId: result.userId });
    sendError(res, "INTERNAL_ERROR");
  }
});
