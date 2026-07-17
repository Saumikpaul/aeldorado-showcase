// agents/orchestrator.js — CEO-led Multi-Agent Orchestrator
// Aeldorado by Solanacy Technologies
//
// The brain of Aeldorado: analyzes user messages, routes to optimal agent(s),
// runs them in parallel, synthesizes results.
// Uses the USER's API key (passed via ai client) — no server-side keys.

import { generateWithFallback } from "../core/retry.js";
import { safeExtractJSON }      from "../core/json-utils.js";
import { PROVIDER_MODELS }       from "./agent-utils.js";
import { logger } from "../core/logger.js";
import { addFactManually } from "../core/memory.js";
import crypto from "crypto";

// Agent runner imports (lazy-loaded to avoid circular deps)
let AGENT_RUNNERS = null;

async function getAgentRunners() {
  if (AGENT_RUNNERS) return AGENT_RUNNERS;
  const [cfo, sales, support, research, marketing, legal] = await Promise.all([
    import("./cfo.js"),
    import("./sales.js"),
    import("./support.js"),
    import("./research.js"),
    import("./marketing.js"),
    import("./legal.js"),
  ]);
  AGENT_RUNNERS = {
    cfo:       cfo.runCFOAgent,
    sales:     sales.runSalesAgent,
    support:   support.runSupportAgent,
    research:  research.runResearchAgent,
    marketing: marketing.runMarketingAgent,
    legal:     legal.runLegalAgent,
  };
  return AGENT_RUNNERS;
}

// ── CEO System Prompt (Generic Business Intelligence) ─────────────────────────
// [PROPRIETARY — REDACTED] This is the core orchestration prompt — the
// central IP of the multi-agent platform. It defines: routing rules (when
// to go single-agent vs multi-agent, max 3 agents per request, mandatory
// Research-agent inclusion whenever a task needs live/current data even if
// routed alongside a domain agent), memory-extraction detection (separate
// from routing — pulls out explicit "remember this" facts into a dedicated
// field), and a strict JSON output contract (thinking / agents /
// direct_response / remember / impact). Removed from this public copy.
const CEO_SYSTEM = `[REDACTED — proprietary orchestration prompt not included in public showcase]`;

// ── CEO Synthesis Prompt ──────────────────────────────────────────────────────
// [PROPRIETARY — REDACTED] Governs how multiple agents' outputs get merged
// into one coherent user-facing response. Notable rule preserved here: if
// the Legal agent's result includes a disclaimer field, that exact text
// must be carried into the synthesized response verbatim, even when other
// agent outputs are summarized/shortened.
const CEO_SYNTHESIS = `[REDACTED — proprietary synthesis prompt not included in public showcase]`;

// ── Run a single agent ────────────────────────────────────────────────────────
// Measures its own wall-clock time so the caller can report real per-agent
// latency (previously sub-agent calls had no timing captured at all).
async function runAgent(name, task, ai, model, options) {
  const runners = await getAgentRunners();
  const runner  = runners[name.toLowerCase()];
  const start   = Date.now();

  if (!runner) {
    return { summary: `Unknown agent: ${name}`, error: true, latencyMs: Date.now() - start };
  }

  try {
    const result = await runner({ task, ai, model, options });
    return { ...result, latencyMs: Date.now() - start };
  } catch (e) {
    return { summary: `Error: ${e.message}`, error: true, latencyMs: Date.now() - start };
  }
}

// ── Main Orchestration Function ───────────────────────────────────────────────
// memoryWrite: { db, projectId, allowed, agentName, visibility }
//   agentName  - caller's own scope label, e.g. "ceo" (default) — used when
//                CEO answers directly with no sub-agent routing.
//   visibility - "internal" (default) or "public", forced by the calling key type.
export async function orchestrate({ prompt, ai, model, options = {}, memoryWrite = null }) {
  // Build model fallback list based on provider
  const provider = ai.provider || "gemini";
  const fallbacks = PROVIDER_MODELS[provider] || PROVIDER_MODELS.gemini;
  const defaultModels = model ? [model, ...fallbacks.slice(0, 2)] : fallbacks;

  // Step 1: CEO analyzes and decides routing
  let parsed;
  try {
    const response = await generateWithFallback(ai, {
      models: defaultModels,
      config: {
        systemInstruction: CEO_SYSTEM,
        temperature: 0.3,
        maxOutputTokens: 2048,
      },
      contents: `User request: "${prompt}"\n\nAnalyze and decide which agents to use. Respond with JSON only.`,
      label: "CEO",
    });

    parsed = safeExtractJSON(response.text || "", {
      direct_response: "I processed your request.",
      agents: [],
      remember: null,
      impact: "LOW",
    });
  } catch (e) {
    logger.error("CEO routing analysis failed", { error: e.message });
    return {
      response_to_user: `I encountered an issue processing your request: ${e.message}`,
      agentUsed: "ceo",
      agentsConsulted: [],
      subAgents: [],
      impact: "LOW",
      thinking: null,
    };
  }

  const factToRemember = typeof parsed.remember === "string" ? parsed.remember.trim() : "";
  const hasAgents       = parsed.agents && parsed.agents.length > 0;
  // Scope: when CEO answers directly, the fact belongs to "agent:ceo".
  // When routed to sub-agent(s), it belongs to the first/primary agent —
  // a single remember-intent maps to one scope, the most relevant agent.
  const rememberScope = hasAgents
    ? `agent:${(parsed.agents[0].name || "ceo").toLowerCase()}`
    : `agent:${memoryWrite?.agentName || "ceo"}`;

  // Step 1.5: Memory write — independent of agent routing, single shared pool
  let memorySaved = false;
  if (factToRemember && memoryWrite && memoryWrite.allowed && memoryWrite.db && memoryWrite.projectId) {
    try {
      memorySaved = await addFactManually(memoryWrite.db, memoryWrite.projectId, factToRemember, {
        scope:      rememberScope,
        visibility: memoryWrite.visibility || "internal",
      });
    } catch (e) {
      logger.error("Orchestrator memory write failed", { error: e.message, projectId: memoryWrite.projectId });
      memorySaved = false;
    }
  }

  // Step 2: No agents needed — direct response
  if (!hasAgents) {
    let directResponse = parsed.direct_response || "Request processed.";
    // Safety net: if a remember was requested but not actually saved
    // (blocked, duplicate, or no project), don't let a stale/optimistic
    // direct_response imply it was stored.
    if (factToRemember && !memorySaved) {
      directResponse = memoryWrite && memoryWrite.allowed
        ? `${directResponse}\n\n(Note: that wasn't saved to memory — it may already be known, or saving failed.)`
        : `${directResponse}\n\n(Note: memory isn't available for this request, so nothing was saved.)`;
    }
    return {
      response_to_user: directResponse,
      agentUsed: "ceo",
      agentsConsulted: [],
      subAgents: [],
      impact: parsed.impact || "LOW",
      thinking: parsed.thinking || null,
      memorySaved,
      factRemembered: memorySaved ? factToRemember : null,
    };
  }

  // Step 3: Run agents in PARALLEL
  const agentPromises = parsed.agents.slice(0, 3).map(assignment =>
    runAgent(assignment.name, assignment.task, ai, model, options)
      .then(result => ({
        agent:  assignment.name,
        task:   assignment.task,
        result,
        status: "fulfilled",
      }))
      .catch(err => ({
        agent:  assignment.name,
        task:   assignment.task,
        result: { summary: `Error: ${err.message}`, error: true },
        status: "rejected",
      }))
  );

  const agentResults = await Promise.all(agentPromises);

  // Step 4: CEO synthesizes results
  try {
    const agentReports = agentResults.map(r =>
      `${r.agent.toUpperCase()}:\nTask: ${r.task}\nResult: ${JSON.stringify(r.result, null, 2)}`
    ).join("\n\n---\n\n");

    const memoryNote = memorySaved
      ? `\n\nNote: the fact "${factToRemember}" was just saved to memory — you may briefly confirm this to the user if relevant.`
      : "";

    const synthResponse = await generateWithFallback(ai, {
      models: defaultModels,
      config: {
        systemInstruction: CEO_SYNTHESIS,
        temperature: 0.3,
        maxOutputTokens: 4096,
      },
      contents: `Original request: "${prompt}"\n\nAgent reports:\n${agentReports}${memoryNote}\n\nSynthesize into a final response. JSON only.`,
      label: "CEO_SYNTHESIS",
    });

    const synthesis = safeExtractJSON(synthResponse.text || "", {
      response: "Analysis complete.",
      agents_used: agentResults.map(r => r.agent),
      impact: parsed.impact,
    });

    // Hard guarantee for the legal disclaimer, same reasoning as the
    // MCP call_agent fix: don't rely solely on the synthesis model to
    // remember to carry it forward (rule 5 above is a backstop, not the
    // primary mechanism). If Legal ran and returned a disclaimer, append
    // it in code whenever it isn't already present in the final text.
    const legalResult = agentResults.find(r => r.agent.toLowerCase() === "legal");
    if (legalResult && legalResult.result?.disclaimer && !synthesis.response.includes(legalResult.result.disclaimer)) {
      synthesis.response = `${synthesis.response}\n\n${legalResult.result.disclaimer}`;
    }

    return {
      response_to_user: synthesis.response,
      response_to_sau:  synthesis.response, // Backward compat
      summary:          synthesis.response,
      agentUsed:        "ceo",
      agentsConsulted:  synthesis.agents_used || agentResults.map(r => r.agent),
      // Per-agent timing breakdown — lets a single "ceo" log entry show
      // which sub-agents ran and how long each actually took.
      subAgents:        agentResults.map(r => ({
        agent:     r.agent,
        latencyMs: r.result?.latencyMs ?? null,
        status:    r.status,
      })),
      impact:           synthesis.impact || parsed.impact,
      thinking:         parsed.thinking || null,
      memorySaved,
      factRemembered: memorySaved ? factToRemember : null,
    };
  } catch (e) {
    // Synthesis failed — return raw agent results
    const fallback = agentResults.map(r =>
      `${r.agent}: ${r.result?.response || r.result?.resolution || r.result?.analysis || r.result?.summary || "Done"}`
    ).join("\n\n");

    return {
      response_to_user: `Here are the results:\n\n${fallback}`,
      response_to_sau:  fallback,
      agentUsed:        "ceo",
      agentsConsulted:  agentResults.map(r => r.agent),
      subAgents:        agentResults.map(r => ({
        agent:     r.agent,
        latencyMs: r.result?.latencyMs ?? null,
        status:    r.status,
      })),
      impact:           parsed.impact || "LOW",
      thinking:         parsed.thinking || null,
      memorySaved,
      factRemembered: memorySaved ? factToRemember : null,
    };
  }
}

