// routes/chat.js — POST /v1/chat — Auto-Routing with Streaming + Conversation
// Aeldorado by Solanacy Technologies

import { Router } from "express";
import { apiPipeline, recordUsageAfterSuccess } from "../middleware/pipeline.js";
import { sendError }                  from "../core/errors.js";
import { createAIClient }             from "../core/ai-client.js";
import { orchestrate }                from "../agents/orchestrator.js";
import { getConversation, saveConversationTurn, buildContext, canCreateConversation } from "../core/conversation.js";
import { TIER_LIMITS } from "../core/billing.js";
import { logRequest }                 from "../core/request-log.js";
import { buildMemoryContext, extractAndSaveFacts, trackNonPlaygroundMessage } from "../core/memory.js";
import { canUseMemory }               from "../core/project-manager.js";
import crypto from "crypto";
import { logger } from "../core/logger.js";

export const chatRouter = Router();

const MAX_MESSAGE_LENGTH = 32_000;
const MEMORY_EXTRACT_AT  = 20; // Extract facts when conversation hits this many messages

// ── POST /v1/chat ────────────────────────────────────────────────────────────
chatRouter.post("/chat", ...apiPipeline(), async (req, res) => {
  const startTime = Date.now();

  // Check scope
  if (req.keyDoc.scope && req.keyDoc.scope !== "all" && req.keyDoc.scope !== "auto" && req.keyDoc.scope !== "mcp") {
    return sendError(res, "INSUFFICIENT_PERMISSION",
      `This API key is scoped to "${req.keyDoc.scope}" and cannot access auto-routing.`
    );
  }

  const { message, options, conversation_id, stream } = req.body;
  if (!message || typeof message !== "string") {
    return sendError(res, "INVALID_REQUEST", "\"message\" field is required.");
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return sendError(res, "MESSAGE_TOO_LONG");
  }

  // ── conversation_id gate: only playground keys can use it ─────────────────
  const isPlaygroundKey  = req.keyDoc?.isPlaygroundKey === true;
  const resolvedConvId   = isPlaygroundKey ? conversation_id : undefined;

  if (conversation_id && !isPlaygroundKey) {
    logger.warn("Non-playground key tried to use conversation_id — ignored", {
      userId: req.userId,
      keyPrefix: req.keyPrefix,
    });
  }

  // ── Detect calls originating from the Playground UI itself ────────────────
  // A non-playground key has no permission to use memory inside Playground —
  // memory for that key type is only valid for direct website/API usage.
  const isFromPlaygroundUI    = req.headers["x-aeldorado-source"] === "playground";
  const memoryBlockedInPg     = isFromPlaygroundUI && !isPlaygroundKey;

  // Public-facing keys (e.g. a customer support widget) only ever get
  // "public"-visibility facts — "internal" facts are never loaded into
  // their context at all, regardless of prompt instructions.
  const isPublicFacing = req.keyDoc?.isPublicFacing === true;

  // ── Memory: inject project memory context if enabled ──────────────────────
  const projectId      = req.keyDoc?.projectId || null;
  let   memoryContext  = "";
  let   memoryEnabled  = false;

  if (memoryBlockedInPg) {
    // Non-playground key used inside Playground — no memory access at all
  } else if (projectId && canUseMemory(req.tier)) {
    try {
      const projSnap = await req.db.collection("projects").doc(projectId).get();
      memoryEnabled  = projSnap.exists && projSnap.data().memoryEnabled === true;

      if (memoryEnabled) {
        memoryContext = await buildMemoryContext(req.db, projectId, {
          agentName:      "ceo",
          isPublicFacing,
        });
      }
    } catch (e) {
      logger.warn("Memory context fetch failed", { error: e.message, projectId });
    }
  } else if (projectId && !canUseMemory(req.tier)) {
    // Free tier tried to use memory via a keyed project — hard block
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

    // Multi-turn: load conversation context (playground keys only)
    const conv    = await getConversation(req.db, req.userId, resolvedConvId);
    const context = buildContext(conv.messages);

    // Build full message: [memory] + [conversation context] + current message
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

    // Run CEO orchestrator
    const result = await orchestrate({
      prompt:  fullMessage,
      ai,
      model:   req.model,
      options: options || {},
      memoryWrite: {
        db:        req.db,
        projectId: projectId,
        allowed:   !!(memoryEnabled && projectId && canUseMemory(req.tier) && !memoryBlockedInPg),
        agentName: "ceo",
        // Public-facing keys can only ever write "public" facts — never let
        // a customer-facing conversation create an "internal" memory entry.
        visibility: isPublicFacing ? "public" : "internal",
      },
    });

    // Record usage
    await recordUsageAfterSuccess(req);

    // Save conversation turn (playground keys only)
    let responseText = result.response_to_user || result.summary || "";
    if (typeof responseText !== "string") {
      responseText = JSON.stringify(responseText, null, 2);
    }

    if (isPlaygroundKey) {
      await saveConversationTurn(req.db, req.userId, conv.conversationId, message, responseText, "ceo");
    }

    // ── Auto memory extraction ────────────────────────────────────────────────
    let memoryExtracted = null;
    const extractOpts = {
      scope:      "agent:ceo",
      visibility: isPublicFacing ? "public" : "internal",
    };
    if (memoryBlockedInPg) {
      // Non-playground key in Playground — no memory write either
    } else if (memoryEnabled && projectId && isPlaygroundKey) {
      // Playground keys: extraction tied to tracked conversation turns
      const updatedConv = await getConversation(req.db, req.userId, conv.conversationId);
      if (updatedConv.messages.length >= MEMORY_EXTRACT_AT) {
        // Fire-and-forget — don't block the response
        extractAndSaveFacts(req.db, projectId, updatedConv.messages, ai, req.model, extractOpts)
          .then(r => {
            if (r.factsAdded > 0) {
              logger.info("Auto memory extraction", { projectId, ...r });
            }
          })
          .catch(e => logger.error("Auto extraction error", { error: e.message }));

        memoryExtracted = "triggered";
      }
    } else if (memoryEnabled && projectId && !isPlaygroundKey) {
      // Non-playground keys: stateless — track a rolling buffer and extract
      // every NON_PG_EXTRACT_AT messages, since there's no conversation_id.
      trackNonPlaygroundMessage(req.db, projectId, message, responseText)
        .then(({ shouldExtract, buffer }) => {
          if (shouldExtract) {
            extractAndSaveFacts(req.db, projectId, buffer, ai, req.model, extractOpts)
              .then(r => {
                if (r.factsAdded > 0) {
                  logger.info("Auto memory extraction (non-playground)", { projectId, ...r });
                }
              })
              .catch(e => logger.error("Auto extraction error", { error: e.message }));
          }
        })
        .catch(e => logger.error("trackNonPlaygroundMessage error", { error: e.message }));

      memoryExtracted = "pending";
    }

    // Log request — single "ceo" entry, with a per-sub-agent breakdown
    // (name + real latency each) attached when the CEO dispatched to
    // CFO/Sales/Support/Research/Marketing/Legal instead of answering directly.
    const elapsed = Date.now() - startTime;
    await logRequest(req.db, {
      userId:    req.userId,
      keyPrefix: req.keyPrefix,
      agent:     "ceo",
      model:     req.model || "default",
      provider:  req.provider,
      projectId: projectId,
      routing:   "auto",
      status:    "success",
      latencyMs: elapsed,
      tokens:    result.tokens || {},
      subAgents: result.subAgents || [],
      ip:        req.clientIP,
    });

    res.json({
      id:              `aldo_resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      object:          "chat.completion",
      created:         Math.floor(Date.now() / 1000),
      conversation_id: isPlaygroundKey ? conv.conversationId : null,
      agent:           result.agentUsed || "ceo",
      model:           req.model || "default",
      provider:        req.provider,
      response: {
        content:          responseText,
        thinking:         typeof result.thinking === "string" ? result.thinking : (result.thinking ? JSON.stringify(result.thinking) : null),
        impact:           result.impact || "LOW",
        agents_consulted: result.agentsConsulted || [],
      },
      memory: memoryEnabled ? {
        project_id:      projectId,
        active:           true,
        extracted:        memoryExtracted,
        manually_saved:   result.memorySaved || false,
        fact_remembered:  result.factRemembered || null,
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
        routing:            "auto",
        stateful:           isPlaygroundKey,
        powered_by:         "Aeldorado by Solanacy",
      },
    });
  } catch (e) {
    const elapsed = Date.now() - startTime;
    await logRequest(req.db, {
      userId:    req.userId,
      keyPrefix: req.keyPrefix,
      agent:     "ceo",
      model:     req.model || "default",
      provider:  req.provider,
      projectId: projectId,
      routing:   "auto",
      status:    "error",
      latencyMs: elapsed,
      errorCode: e.message,
      ip:        req.clientIP,
    });
    logger.error("Chat orchestration failed", { error: e.message, userId: req.userId });
    sendError(res, "AGENT_ERROR", e.message);
  } finally {
    req.decryptedApiKey = null;
  }
});
