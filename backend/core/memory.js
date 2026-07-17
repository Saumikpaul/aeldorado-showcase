// core/memory.js — Project-based Persistent Memory
// Aeldorado by Solanacy Technologies
//
// Memory stores structured facts[] + a rolling summary per project.
// Raw conversation history is NOT stored here — only extracted insights.
// Token-efficient: only the facts/summary are injected into future calls.

import { logger } from "./logger.js";
import { FieldValue } from "firebase-admin/firestore";

const MAX_FACTS = 100;         // Hard cap per project
const SUMMARY_MAX_CHARS = 800; // Max chars for rolling summary in context

export const VALID_AGENTS = ["ceo", "cfo", "sales", "support", "research", "marketing", "legal"];

function normalizeScope(scope) {
  if (!scope || scope === "universal") return "universal";
  const agentName = scope.startsWith("agent:") ? scope.slice(6) : scope;
  return VALID_AGENTS.includes(agentName) ? `agent:${agentName}` : "universal";
}

function normalizeVisibility(visibility) {
  return visibility === "public" ? "public" : "internal"; // default: internal (safe)
}

/**
 * Build a memory context string to prepend to AI calls.
 * Filters facts by scope (universal + this agent's own facts) and by
 * visibility (public-facing keys never see "internal"-tagged facts).
 *
 * @param {object} db
 * @param {string} projectId
 * @param {object} opts
 * @param {string} [opts.agentName]      - e.g. "ceo", "support" — defaults to "ceo"
 * @param {boolean} [opts.isPublicFacing] - true = only "public" visibility facts allowed
 * @returns {Promise<string>}
 */
export async function buildMemoryContext(db, projectId, opts = {}) {
  const agentName       = opts.agentName || "ceo";
  const isPublicFacing  = opts.isPublicFacing === true;

  try {
    const snap = await db.collection("project_memory").doc(projectId).get();
    if (!snap.exists) return "";

    const data = snap.data();
    const allFacts = data.facts   || [];
    const summary   = data.summary || "";

    const scopedFacts = allFacts.filter(f => {
      const scope = normalizeScope(f.scope);
      const vis   = normalizeVisibility(f.visibility);
      const scopeMatches = scope === "universal" || scope === `agent:${agentName}`;
      const visMatches    = !isPublicFacing || vis === "public";
      return scopeMatches && visMatches;
    });

    if (scopedFacts.length === 0 && !summary) return "";

    let ctx = "\n\n[PROJECT MEMORY — recalled from past interactions]\n";

    // Summary is project-wide context — only include for non-public-facing
    // calls, since rolling summaries aren't tagged/scoped per-fact.
    if (summary && !isPublicFacing) {
      ctx += `Summary: ${summary}\n`;
    }

    if (scopedFacts.length > 0) {
      ctx += "Known facts:\n";
      scopedFacts.slice(-50).forEach((f, i) => {
        ctx += `  ${i + 1}. ${f.fact}\n`;
      });
    }

    ctx += "[END MEMORY]\n\n";
    return ctx;
  } catch (e) {
    logger.error("buildMemoryContext failed", { error: e.message, projectId });
    return "";
  }
}

/**
 * Detect explicit "remember this" intent in a single message and extract
 * the fact, for routes that don't already run an agent capable of detecting
 * it in their own JSON output (i.e. direct single-agent calls via
 * POST /v1/agent/:name, which don't go through the CEO orchestrator).
 *
 * Uses a cheap keyword pre-filter so the extra LLM call only fires when the
 * message plausibly contains a remember-intent, not on every message.
 *
 * @param {string} message
 * @param {object} ai
 * @param {string} model
 * @returns {Promise<string|null>} the extracted fact, or null if none
 */
const REMEMBER_KEYWORDS = /\b(remember|note this|note that|save this|don't forget|dont forget|keep in mind)\b/i;

export async function detectRememberIntent(message, ai, model) {
  if (!message || !REMEMBER_KEYWORDS.test(message)) return null;

  try {
    const prompt = `Does this message explicitly ask to remember/save/note a specific fact? If yes, extract the fact as a short atomic sentence. If no, or if it's just casual use of these words (not an actual remember-request), respond with null.

Message: "${message.slice(0, 2000)}"

Respond ONLY with JSON, no extra text:
{ "fact": "extracted fact, or null" }`;

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.1, maxOutputTokens: 150 },
    });

    const rawText = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed  = JSON.parse(cleaned);

    return typeof parsed.fact === "string" && parsed.fact.trim() && parsed.fact.toLowerCase() !== "null"
      ? parsed.fact.trim()
      : null;
  } catch (e) {
    logger.warn("detectRememberIntent failed", { error: e.message });
    return null;
  }
}


/**
 * Extract facts from a conversation turn and save to project memory.
 * Called automatically at MAX_TURNS (20) messages, or manually via /v1/memory/remember.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {Array}  messages   - Array of { role, content } pairs
 * @param {object} ai         - AI client (GoogleGenAI instance)
 * @param {string} model      - Model to use for extraction
 * @param {object} [opts]
 * @param {string} [opts.scope]      - "universal" or "agent:<name>" — default "universal"
 * @param {string} [opts.visibility] - "internal" or "public" — default "internal" (safe)
 * @returns {Promise<{ factsAdded: number, summary: string }>}
 */
export async function extractAndSaveFacts(db, projectId, messages, ai, model, opts = {}) {
  const scope      = normalizeScope(opts.scope);
  const visibility = normalizeVisibility(opts.visibility);

  if (!messages || messages.length === 0) {
    return { factsAdded: 0, summary: "" };
  }

  try {
    // Build a condensed transcript for extraction
    const transcript = messages
      .slice(-20) // last 20 messages max to keep tokens low
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    const extractionPrompt = `You are a memory extraction system. Analyze this conversation and extract:
1. Key facts, preferences, decisions, or context the user has shared
2. A brief rolling summary of what was discussed (max 2 sentences)

Respond ONLY in this exact JSON format, no extra text:
{
  "facts": ["fact 1", "fact 2", "fact 3"],
  "summary": "Two sentence summary here."
}

Rules:
- Facts should be atomic, specific, and reusable in future conversations
- Skip generic chat, keep only meaningful context
- Max 10 facts per extraction
- If nothing meaningful, return empty facts array

Conversation:
${transcript}`;

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: extractionPrompt }] }],
      config: { temperature: 0.1, maxOutputTokens: 500 },
    });

    const rawText = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Parse JSON — strip markdown fences if present
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    let extracted = { facts: [], summary: "" };

    try {
      extracted = JSON.parse(cleaned);
    } catch {
      logger.warn("Memory extraction: JSON parse failed", { projectId, rawText: rawText.slice(0, 200) });
      return { factsAdded: 0, summary: "" };
    }

    const newFacts  = (extracted.facts  || []).filter(f => typeof f === "string" && f.trim());
    const newSummary = typeof extracted.summary === "string" ? extracted.summary.slice(0, SUMMARY_MAX_CHARS) : "";

    if (newFacts.length === 0 && !newSummary) {
      return { factsAdded: 0, summary: "" };
    }

    // Build fact objects with timestamp
    const factObjects = newFacts.map(fact => ({
      fact:        fact.trim(),
      extractedAt: new Date().toISOString(),
      scope,
      visibility,
    }));

    // Merge into Firestore
    const memRef  = db.collection("project_memory").doc(projectId);
    const memSnap = await memRef.get();

    if (!memSnap.exists) {
      await memRef.set({
        projectId,
        facts:       factObjects,
        summary:     newSummary,
        lastUpdated: new Date().toISOString(),
        totalExtractions: 1,
      });
    } else {
      const existingFacts = memSnap.data().facts || [];

      // Deduplicate: skip facts already present (simple text match)
      const existingTexts = new Set(existingFacts.map(f => f.fact.toLowerCase()));
      const uniqueNew = factObjects.filter(f => !existingTexts.has(f.fact.toLowerCase()));

      // Enforce MAX_FACTS cap — drop oldest if needed
      const merged = [...existingFacts, ...uniqueNew];
      const trimmed = merged.length > MAX_FACTS ? merged.slice(merged.length - MAX_FACTS) : merged;

      await memRef.update({
        facts:            trimmed,
        summary:          newSummary || memSnap.data().summary,
        lastUpdated:      new Date().toISOString(),
        totalExtractions: FieldValue.increment(1),
      });
    }

    logger.info("Memory extracted", { projectId, factsAdded: factObjects.length, scope, visibility });
    return { factsAdded: factObjects.length, summary: newSummary };

  } catch (e) {
    logger.error("extractAndSaveFacts failed", { error: e.message, projectId });
    return { factsAdded: 0, summary: "" };
  }
}

/**
 * Track a message from a non-playground (stateless) key and trigger
 * extraction every NON_PG_EXTRACT_AT messages. Since these calls have no
 * conversation_id/multi-turn buffer, we keep a rolling buffer of recent
 * messages directly on the project_memory doc and extract from that.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} userMessage
 * @param {string} aiResponse
 * @returns {Promise<{ shouldExtract: boolean, buffer: Array }>}
 */
const NON_PG_EXTRACT_AT = 20;
const NON_PG_BUFFER_CAP = 20; // keep buffer aligned to extraction threshold

export async function trackNonPlaygroundMessage(db, projectId, userMessage, aiResponse) {
  try {
    const counterRef  = db.collection("project_memory_counters").doc(projectId);
    const counterSnap = await counterRef.get();

    const prevBuffer = counterSnap.exists ? (counterSnap.data().buffer || []) : [];
    const newBuffer = [
      ...prevBuffer,
      { role: "user", content: userMessage },
      { role: "assistant", content: aiResponse },
    ].slice(-NON_PG_BUFFER_CAP * 2);

    const shouldExtract = newBuffer.length >= NON_PG_EXTRACT_AT;

    if (shouldExtract) {
      // Reset buffer once we hand it off for extraction
      await counterRef.set({ buffer: [], lastExtractedAt: new Date().toISOString() });
    } else {
      await counterRef.set({ buffer: newBuffer }, { merge: true });
    }

    return { shouldExtract, buffer: newBuffer };
  } catch (e) {
    logger.error("trackNonPlaygroundMessage failed", { error: e.message, projectId });
    return { shouldExtract: false, buffer: [] };
  }
}


/**
 * Manually add a specific fact to project memory.
 * Used by POST /v1/memory/remember endpoint, the Fine Tune dashboard page,
 * and the orchestrator's in-chat remember-detection.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} fact
 * @param {object} [opts]
 * @param {string} [opts.scope]      - "universal" or "agent:<name>" — default "universal"
 * @param {string} [opts.visibility] - "internal" or "public" — default "internal" (safe)
 * @returns {Promise<boolean>}
 */
export async function addFactManually(db, projectId, fact, opts = {}) {
  const scope      = normalizeScope(opts.scope);
  const visibility = normalizeVisibility(opts.visibility);

  try {
    const factObj = {
      fact:        fact.trim(),
      extractedAt: new Date().toISOString(),
      manual:      true,
      scope,
      visibility,
    };

    const memRef  = db.collection("project_memory").doc(projectId);
    const memSnap = await memRef.get();

    if (!memSnap.exists) {
      await memRef.set({
        projectId,
        facts:            [factObj],
        summary:          "",
        lastUpdated:      new Date().toISOString(),
        totalExtractions: 0,
      });
    } else {
      const existingFacts = memSnap.data().facts || [];

      // Dedup check — same text AND same scope (a fact can exist once per
      // scope, e.g. a universal version and a support-only version differ)
      const exists = existingFacts.some(f =>
        f.fact.toLowerCase() === fact.toLowerCase() && normalizeScope(f.scope) === scope
      );
      if (exists) return false; // already known

      const merged  = [...existingFacts, factObj];
      const trimmed = merged.length > MAX_FACTS ? merged.slice(merged.length - MAX_FACTS) : merged;

      await memRef.update({
        facts:       trimmed,
        lastUpdated: new Date().toISOString(),
      });
    }

    logger.info("Fact added manually", { projectId, fact: fact.slice(0, 80), scope, visibility });
    return true;
  } catch (e) {
    logger.error("addFactManually failed", { error: e.message, projectId });
    return false;
  }
}

/**
 * Delete a single fact by its exact text + scope match.
 * Used by the Fine Tune dashboard page.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} fact
 * @param {string} [scope]
 * @returns {Promise<boolean>}
 */
export async function deleteFact(db, projectId, fact, scope) {
  try {
    const normScope = normalizeScope(scope);
    const memRef  = db.collection("project_memory").doc(projectId);
    const memSnap = await memRef.get();
    if (!memSnap.exists) return false;

    const existingFacts = memSnap.data().facts || [];
    const filtered = existingFacts.filter(f =>
      !(f.fact === fact && normalizeScope(f.scope) === normScope)
    );

    if (filtered.length === existingFacts.length) return false; // nothing matched

    await memRef.update({ facts: filtered, lastUpdated: new Date().toISOString() });
    logger.info("Fact deleted", { projectId, fact: fact.slice(0, 80), scope: normScope });
    return true;
  } catch (e) {
    logger.error("deleteFact failed", { error: e.message, projectId });
    return false;
  }
}

/**
 * Delete all memory for a project.
 *
 * @param {object} db
 * @param {string} projectId
 * @returns {Promise<boolean>}
 */
export async function clearMemory(db, projectId) {
  try {
    await db.collection("project_memory").doc(projectId).delete();
    logger.info("Memory cleared", { projectId });
    return true;
  } catch (e) {
    logger.error("clearMemory failed", { error: e.message, projectId });
    return false;
  }
}

/**
 * Get raw memory doc (for dashboard inspection).
 *
 * @param {object} db
 * @param {string} projectId
 * @returns {Promise<object|null>}
 */
export async function getMemory(db, projectId) {
  try {
    const snap = await db.collection("project_memory").doc(projectId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch {
    return null;
  }
}
