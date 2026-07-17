// core/request-log.js — API Request Logging & Token Tracking
// Aeldorado by Solanacy Technologies
import { logger } from "./logger.js";
//
// Logs every API call with: agent, model, tokens, latency, status.
// Stored in Firestore "request_logs" collection for analytics.

/**
 * Log an API request.
 *
 * @param {object} db
 * @param {object} params
 */
export async function logRequest(db, {
  userId,
  keyPrefix,
  agent,
  model,
  provider,
  projectId = null,
  routing,        // "auto" or "direct"
  status,         // "success" or "error"
  latencyMs,
  tokens = {},
  errorCode = null,
  ip = null,
  // When the CEO orchestrator dispatches to sub-agents, this carries a
  // breakdown of which agents ran and each one's real wall-clock latency:
  // [{ agent: "cfo", latencyMs: 4210, status: "fulfilled" }, ...].
  // Stays empty for direct CEO answers and for direct (non-orchestrated)
  // agent calls, so a single "ceo" log entry can still show per-agent detail.
  subAgents = [],
}) {
  try {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);

    await db.collection("request_logs").add({
      userId,
      keyPrefix:   keyPrefix || null,
      agent:       agent || "unknown",
      model:       model || "unknown",
      provider:    provider || "unknown",
      projectId:   projectId || null,
      routing,
      status,
      latencyMs:   latencyMs || 0,
      tokens: {
        input:  tokens.inputTokens  || tokens.input  || 0,
        output: tokens.outputTokens || tokens.output || 0,
        total:  tokens.totalTokens  || tokens.total  || 0,
      },
      subAgents: Array.isArray(subAgents) ? subAgents.map(sa => ({
        agent:     sa.agent || "unknown",
        latencyMs: typeof sa.latencyMs === "number" ? sa.latencyMs : null,
        status:    sa.status || "unknown",
      })) : [],
      errorCode,
      ip,
      dayKey,
      timestamp: now.toISOString(),
    });
  } catch (e) {
    // Non-blocking — log failure should never break API
    logger.error("Request log failed", { error: e.message, userId });
  }
}

/**
 * Get request logs for a user (paginated).
 *
 * @param {object} db
 * @param {string} userId
 * @param {object} options
 * @returns {Promise<{ logs: Array, total: number }>}
 */
export async function getRequestLogs(db, userId, { limit = 15, startAfter = null, dayKey = null } = {}) {
  try {
    let query = db.collection("request_logs")
      .where("userId", "==", userId)
      .orderBy("timestamp", "desc");

    if (dayKey) {
      query = query.where("dayKey", "==", dayKey);
    }

    // Cursor pagination — startAfter is the ISO timestamp of the last doc
    // on the previous page. This keeps each page read to `limit` docs only,
    // instead of re-fetching everything from the start every time.
    if (startAfter) {
      query = query.startAfter(startAfter);
    }

    query = query.limit(limit + 1); // fetch one extra to know if there's a next page

    const snap = await query.get();
    const docs = snap.docs.slice(0, limit);
    const hasMore = snap.docs.length > limit;

    const logs = docs.map(doc => {
      const d = doc.data();
      return {
        id:        doc.id,
        agent:     d.agent,
        model:     d.model,
        provider:  d.provider,
        routing:   d.routing,
        status:    d.status,
        latencyMs: d.latencyMs,
        tokens:    d.tokens,
        subAgents: d.subAgents || [],
        timestamp: d.timestamp,
        keyPrefix: d.keyPrefix,
      };
    });

    const nextCursor = logs.length ? logs[logs.length - 1].timestamp : null;

    return { logs, total: logs.length, hasMore, nextCursor };
  } catch (e) {
    logger.error("Fetch request logs failed", { error: e.message, userId });
    return { logs: [], total: 0, hasMore: false, nextCursor: null };
  }
}

/**
 * Get aggregated usage analytics for a user.
 *
 * @param {object} db
 * @param {string} userId
 * @param {number} days - Number of days to look back
 * @returns {Promise<object>}
 */
export async function getUsageAnalytics(db, userId, days = 7) {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const snap = await db.collection("request_logs")
      .where("userId", "==", userId)
      .where("timestamp", ">=", since)
      .orderBy("timestamp", "asc")
      .limit(5000)
      .get();

    const dailyCalls     = {};
    const agentBreakdown = {};
    const modelBreakdown = {};
    const projectCalls   = {}; // projectId -> call count
    let totalTokens     = 0;
    let totalLatency    = 0;
    let totalCalls      = 0;
    let errorCount      = 0;

    snap.docs.forEach(doc => {
      const d = doc.data();
      const day = d.timestamp?.slice(0, 10);

      // Daily calls
      dailyCalls[day] = (dailyCalls[day] || 0) + 1;

      // Agent breakdown
      agentBreakdown[d.agent] = (agentBreakdown[d.agent] || 0) + 1;

      // Model breakdown (which AI models are actually being called)
      const modelKey = d.model || "unknown";
      modelBreakdown[modelKey] = (modelBreakdown[modelKey] || 0) + 1;

      // Project breakdown (which projects are most active)
      if (d.projectId) {
        projectCalls[d.projectId] = (projectCalls[d.projectId] || 0) + 1;
      }

      // Totals
      totalTokens  += d.tokens?.total || 0;
      totalLatency += d.latencyMs || 0;
      totalCalls++;
      if (d.status === "error") errorCount++;
    });

    // Resolve project names for the breakdown, ranked by call count
    const topProjectIds = Object.entries(projectCalls)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id);

    let topProjects = [];
    if (topProjectIds.length > 0) {
      const projDocs = await Promise.all(
        topProjectIds.map(id => db.collection("projects").doc(id).get())
      );
      topProjects = topProjectIds.map((id, i) => ({
        projectId: id,
        name:      projDocs[i].exists ? (projDocs[i].data().name || "Untitled") : "Deleted project",
        calls:     projectCalls[id],
      }));
    }

    // Top models, ranked by call count
    const topModels = Object.entries(modelBreakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([model, calls]) => ({ model, calls }));

    return {
      period:      `${days} days`,
      totalCalls,
      totalTokens,
      avgLatencyMs: totalCalls > 0 ? Math.round(totalLatency / totalCalls) : 0,
      errorRate:    totalCalls > 0 ? Math.round((errorCount / totalCalls) * 100) : 0,
      dailyCalls,
      agentBreakdown,
      modelBreakdown,
      topModels,
      topProjects,
    };
  } catch (e) {
    logger.error("Usage analytics failed", { error: e.message, userId });
    return { totalCalls: 0, totalTokens: 0, dailyCalls: {}, agentBreakdown: {}, modelBreakdown: {}, topModels: [], topProjects: [] };
  }
}
