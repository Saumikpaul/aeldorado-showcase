// routes/agents.js — POST /v1/agent/:name — Direct Agent with Conversation + Logging
// Aeldorado by Solanacy Technologies

import { Router } from "express";
import { apiPipeline, recordUsageAfterSuccess } from "../middleware/pipeline.js";
import { sendError }       from "../core/errors.js";
import { createAIClient }  from "../core/ai-client.js";
import { getConversation, saveConversationTurn, buildContext, canCreateConversation } from "../core/conversation.js";
import { TIER_LIMITS } from "../core/billing.js";
import { logRequest }      from "../core/request-log.js";
import crypto from "crypto";
import { logger } from "../core/logger.js";
import { buildMemoryContext, addFactManually, detectRememberIntent } from "../core/memory.js";
import { canUseMemory } from "../core/project-manager.js";

import { runCEOAgent }       from "../agents/ceo.js";
import { runCFOAgent }       from "../agents/cfo.js";
import { runSalesAgent }     from "../agents/sales.js";
import { runSupportAgent }   from "../agents/support.js";
import { runResearchAgent }  from "../agents/research.js";
import { runMarketingAgent } from "../agents/marketing.js";
import { runLegalAgent }     from "../agents/legal.js";

export const agentsRouter = Router();

const AGENT_RUNNERS = {
  ceo:       runCEOAgent,
  cfo:       runCFOAgent,
  sales:     runSalesAgent,
  support:   runSupportAgent,
  research:  runResearchAgent,
  marketing: runMarketingAgent,
  legal:     runLegalAgent,
};

const MAX_MESSAGE_LENGTH = 32_000;

agentsRouter.post("/agent/:name", ...apiPipeline(), async (req, res) => {
  const startTime = Date.now();
  const agentName = (req.params.name || "").toLowerCase().trim();

  const runner = AGENT_RUNNERS[agentName];
  if (!runner) {
    return sendError(res, "AGENT_NOT_FOUND",
      `Agent "${agentName}" not found. Available: ${Object.keys(AGENT_RUNNERS).join(", ")}`
    );
  }

  // Check scope
  const scope = req.keyDoc.scope;
  if (scope && scope !== "all" && scope !== "mcp" && scope !== `agent:${agentName}`) {
    return sendError(res, "INSUFFICIENT_PERMISSION",
      `This API key is scoped to "${scope}" and cannot access the ${agentName} agent.`
    );
  }

  const { message, options, conversation_id } = req.body;
  if (!message || typeof message !== "string") {
    return sendError(res, "INVALID_REQUEST", "\"message\" field is required.");
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return sendError(res, "MESSAGE_TOO_LONG");
  }

  // ── conversation_id gate: only playground keys can use it ─────────────────
  const isPlaygroundKey = req.keyDoc?.isPlaygroundKey === true;
  const resolvedConvId  = isPlaygroundKey ? conversation_id : undefined;

  // Same Playground-source detection as /v1/chat — non-playground keys get
  // no memory access at all when used inside the Playground UI.
  const isFromPlaygroundUI = req.headers["x-aeldorado-source"] === "playground";
  const memoryBlockedInPg  = isFromPlaygroundUI && !isPlaygroundKey;
  const isPublicFacing     = req.keyDoc?.isPublicFacing === true;

  const projectId = req.keyDoc?.projectId || null;
  let memoryContext = "";
  let memoryEnabled = false;

  if (!memoryBlockedInPg && projectId && canUseMemory(req.tier)) {
    try {
      const projSnap = await req.db.collection("projects").doc(projectId).get();
      memoryEnabled  = projSnap.exists && projSnap.data().memoryEnabled === true;
      if (memoryEnabled) {
        memoryContext = await buildMemoryContext(req.db, projectId, {
          agentName: agentName,
          isPublicFacing,
        });
      }
    } catch (e) {
      logger.warn("Memory context fetch failed", { error: e.message, projectId });
    }
  } else if (!memoryBlockedInPg && projectId && !canUseMemory(req.tier)) {
    return sendError(res, "INSUFFICIENT_PERMISSION",
      "Memory features require Starter or Pro tier. Upgrade to enable project memory."
    );
  }

  try {
    const ai = createAIClient(req.provider, req.decryptedApiKey);

    // ── New-conversation gate: free tier capped at maxConversations ──────────
    if (isPlaygroundKey && !resolvedConvId) {
      const limits = TIER_LIMITS[req.tier];
      const { allowed, active } = await canCreateConversation(req.db, req.userId, limits?.maxConversations);
      if (!allowed) {
        return sendError(res, "CONVERSATION_LIMIT_REACHED",
          `You have ${active} active conversation(s) (limit ${limits.maxConversations} on the ${limits.name} plan). Delete one or wait for it to expire.`
        );
      }
    }

    // Multi-turn context
    const conv = await getConversation(req.db, req.userId, resolvedConvId);
    const context = buildContext(conv.messages);
    let fullMessage;
    if (memoryContext && context) {
      fullMessage = memoryContext + context + `\nCurrent message: ${message}`;
    } else if (memoryContext) {
      fullMessage = memoryContext + message;
    } else if (context) {
      fullMessage = context + `\nCurrent message: ${message}`;
    } else {
      fullMessage = message;
    }

    const result = await runner({
      task:    fullMessage,
      rawMessage: message,
      ai,
      model:   req.model,
      options: options || {},
    });

    await recordUsageAfterSuccess(req);

    // Save conversation turn
    let responseText = result.response || result.resolution || result.analysis || result.summary || "";
    if (typeof responseText !== "string") {
      responseText = JSON.stringify(responseText, null, 2);
    }
    if (isPlaygroundKey) {
      await saveConversationTurn(req.db, req.userId, conv.conversationId, message, responseText, agentName);
    }

    // Memory write: detect explicit remember-intent in the user's message,
    // scoped to this specific agent (e.g. "agent:support").
    let memorySaved = false;
    let factRemembered = null;
    if (memoryEnabled && projectId && !memoryBlockedInPg) {
      try {
        const fact = await detectRememberIntent(message, ai, req.model);
        if (fact) {
          memorySaved = await addFactManually(req.db, projectId, fact, {
            scope:      `agent:${agentName}`,
            visibility: isPublicFacing ? "public" : "internal",
          });
          if (memorySaved) factRemembered = fact;
        }
      } catch (e) {
        logger.error("Direct-agent memory write failed", { error: e.message, projectId, agentName });
      }
    }

    const elapsed = Date.now() - startTime;

    // Log request
    await logRequest(req.db, {
      userId:    req.userId,
      keyPrefix: req.keyPrefix,
      agent:     agentName,
      model:     req.model || "default",
      provider:  req.provider,
      projectId: projectId,
      routing:   "direct",
      status:    "success",
      latencyMs: elapsed,
      tokens:    result.tokens || {},
      ip:        req.clientIP,
    });

    res.json({
      id:              `aldo_resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      object:          "agent.completion",
      created:         Math.floor(Date.now() / 1000),
      conversation_id: isPlaygroundKey ? conv.conversationId : null,
      agent:           agentName,
      model:           req.model || "default",
      provider:        req.provider,
      response: {
        content: responseText,
        data:    result.data || null,
      },
      memory: memoryEnabled ? {
        project_id:      projectId,
        active:          true,
        manually_saved:  memorySaved,
        fact_remembered: factRemembered,
      } : null,
      usage: {
        calls_current_window:  req.usage?.daily || 0,       // 5-hour rolling window
        calls_remaining_window: req.usage?.dailyRemaining || "unlimited",
        window_resets_in_ms:   req.usage?.dailyResetsInMs ?? null,
        calls_today:           req.usage?.daily || 0,        // deprecated alias, kept for backward-compat
        calls_remaining_daily: req.usage?.dailyRemaining || "unlimited", // deprecated alias
        tier:                  req.tier,
        tokens:                result.tokens || null,
      },
      meta: {
        processing_time_ms: elapsed,
        routing:            "direct",
        agent:              agentName,
        powered_by:         "Aeldorado by Solanacy",
      },
    });
  } catch (e) {
    const elapsed = Date.now() - startTime;
    await logRequest(req.db, {
      userId:    req.userId,
      keyPrefix: req.keyPrefix,
      agent:     agentName,
      model:     req.model || "default",
      provider:  req.provider,
      projectId: projectId,
      routing:   "direct",
      status:    "error",
      latencyMs: elapsed,
      errorCode: e.message,
      ip:        req.clientIP,
    });
    console.error(`[AGENT:${agentName}] Error:`, e.message);
    sendError(res, "AGENT_ERROR", e.message);
  } finally {
    req.decryptedApiKey = null;
  }
});
