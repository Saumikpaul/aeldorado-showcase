// agents/legal.js — Legal Agent
// Aeldorado by Solanacy Technologies
//
// Grounding added (2026-07-07): the legal agent used to answer statute
// citations, section numbers, and punishment details purely from training
// knowledge. Confirmed in live testing that this produces a specific
// failure mode — not fabrication, but *oversimplification*: e.g. correctly
// naming "BNS Section 316" for criminal breach of trust, but flattening
// its graded, role-dependent punishment tiers (3/7/10-years-or-life
// depending on the accused's capacity) down to a single "up to 3 years"
// figure. A prompt-only instruction ("mention if a statute has tiers") was
// judged insufficient on its own — it doesn't fix the underlying
// training-recall gap, and the same shape of gap could recur for any other
// tiered/graded provision the model hasn't fully recalled. So instead of
// (or in addition to) an instruction, this agent now follows the same
// grounded-search + claim-verification pattern research.js already proved
// out: shouldSearchLive decides whether a given legal task actually
// depends on a checkable external fact (a specific statute's current text,
// a recent amendment, a filing deadline) as opposed to general legal
// reasoning/drafting that doesn't need it (e.g. "draft me an NDA" doesn't
// need a live search; "what's the punishment under BNS 316" does).

import { generateWithFallback } from "../core/retry.js";
import { safeExtractJSON }      from "../core/json-utils.js";
import { getModelList }         from "./agent-utils.js";
import { shouldSearchLive, runGroundedSearch, appendSourceList, GROUNDED_CITATION_RULES } from "../core/grounded-search.js";
import { verifyGroundedClaims } from "../core/claim-verification.js";
import { logger } from "../core/logger.js";

// [PROPRIETARY — REDACTED] Full persona/expertise/guardrail prompt removed.
// Notable rule preserved in production: statutes with tiered/graded
// provisions (penalty varies by role, transaction value, company size,
// etc.) must have the applicable tier explicitly identified, with a flag
// that other tiers exist — never presenting only the simplest tier as if
// it were the whole provision. Always includes an AI-generated-information
// legal disclaimer.
const LEGAL_SYSTEM = `[REDACTED — proprietary system prompt not included in public showcase]`;

// Same system prompt, with the grounded-citation rules spliced in — used
// only on the branch where shouldSearchLive returned true and a search
// actually succeeded, mirroring how research.js appends
// GROUNDED_CITATION_RULES to its own base prompt.
const LEGAL_SYSTEM_GROUNDED = `${LEGAL_SYSTEM}

${GROUNDED_CITATION_RULES}`;

export async function runLegalAgent({ task, rawMessage, ai, model, options = {} }) {
  const models = getModelList(ai, model);

  // Gate: most legal-agent tasks (drafting an NDA, general contract
  // structuring advice, explaining what a clause type does) are reasoning/
  // drafting tasks with no live, checkable fact dependency — searching for
  // those would add latency for no accuracy benefit. Only tasks that
  // actually hinge on a current/checkable fact (a specific section's exact
  // current text, a recent amendment, a filing deadline) go down the
  // grounded path. Fails safe to false (ungrounded) on any classifier error.
  let needsSearch = false;
  try {
    needsSearch = await shouldSearchLive({ task, ai, model });
  } catch (e) {
    logger.error("Legal agent: shouldSearchLive check failed, proceeding ungrounded", { error: e.message });
  }

  if (!needsSearch) {
    const response = await generateWithFallback(ai, {
      models,
      config: {
        systemInstruction: LEGAL_SYSTEM,
        temperature: options.temperature || 0.2,
        maxOutputTokens: options.max_tokens || 4096,
      },
      contents: task,
      label: "LEGAL",
    });

    return safeExtractJSON(response.text || "", { summary: response.text?.slice(0, 500), response: response.text });
  }

  // Grounded path — same searchQuery pattern as research.js: search with
  // the clean original user message, not `task` (which may have project
  // memory prepended), so the search string sent out doesn't get polluted
  // with unrelated context and return irrelevant results.
  const searchQuery = (rawMessage && rawMessage.trim()) || task;
  const search = await runGroundedSearch({ task, searchQuery, agentLabel: "Legal", ai, model });

  if (!search.ok) {
    // No live data found or search blocked — fall back to an ungrounded
    // answer rather than refusing outright, but the model's own rules
    // (never fabricate citations, recommend counsel) still apply. This
    // differs from research.js's hard refusal-on-no-data because Legal's
    // domain knowledge (general legal concepts, drafting) is still useful
    // even without live grounding, whereas Research's whole value
    // proposition is the live data itself.
    logger.warn("Legal agent: live search unavailable, falling back to ungrounded answer", { reason: search.reason });

    const response = await generateWithFallback(ai, {
      models,
      config: {
        systemInstruction: LEGAL_SYSTEM,
        temperature: options.temperature || 0.2,
        maxOutputTokens: options.max_tokens || 4096,
      },
      contents: task,
      label: "LEGAL",
    });

    const parsed = safeExtractJSON(response.text || "", { summary: response.text?.slice(0, 500), response: response.text });
    parsed.liveDataFound = false;
    return parsed;
  }

  const response = await generateWithFallback(ai, {
    models,
    config: {
      systemInstruction: LEGAL_SYSTEM_GROUNDED,
      temperature: options.temperature || 0.2,
      // Grounded legal answers cite sources and often need to lay out
      // multiple tiers/sub-sections — same reasoning as research.js's
      // scaled token budget, but Legal answers tend to need less source
      // volume than a market-research synthesis, so a flat bump covers it
      // without the extra per-source scaling complexity.
      maxOutputTokens: options.max_tokens || 8192,
    },
    contents: search.groundedTask,
    label: "LEGAL",
    jsonMode: true,
  });

  const rawText = (response.text || "").trim();

  if (!rawText) {
    logger.error("Legal agent: model returned empty response", { task: task.slice(0, 200) });
    return {
      summary: "The AI model returned an empty response.",
      analysis: null,
      risks: [],
      recommendations: [],
      compliance_notes: [],
      disclaimer: "This analysis is AI-generated for informational purposes only. It does not constitute legal advice. Please consult a qualified attorney for specific legal matters.",
      response: "Something went wrong generating the response just now — the live sources were found fine, but the answer came back empty. Please try again.",
      liveDataFound: true,
    };
  }

  const cleanedForDisplay = rawText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const looksLikeRawJson = cleanedForDisplay.startsWith("{") || cleanedForDisplay.startsWith("[");

  const fallback = looksLikeRawJson
    ? {
        summary: "The response was cut off before it could be fully generated.",
        response: "The answer got cut off partway through — this can happen with longer, detailed answers. Please try again, or ask a more specific/narrower question.",
      }
    : { summary: cleanedForDisplay.slice(0, 500), response: cleanedForDisplay };

  const parsed = safeExtractJSON(rawText, fallback);
  parsed.liveDataFound = true;

  // Same reasoning as research.js: always derive sources from search.sources
  // in the sorted order used to build [N] citations, never trust a
  // model-generated sources list, to keep the [N] mapping and the displayed
  // source list in lockstep.
  parsed.sources = search.sources.map(s => s.url);

  // Verification loop — identical call as research.js. Fails safe by
  // construction: if this throws, parsed.response is untouched and the
  // agent's answer still ships normally.
  if (typeof parsed.response === "string" && parsed.response.trim()) {
    try {
      const verifyResult = await verifyGroundedClaims({
        responseText: parsed.response,
        sources: search.sources,
        ai,
        model,
      });
      parsed.response = verifyResult.responseText;
      parsed.verification = verifyResult.verification;

      if (verifyResult.verification.ran && verifyResult.verification.failedClaims > 0) {
        logger.warn("Legal agent: unverified claims flagged", {
          failedClaims: verifyResult.verification.failedClaims,
          totalClaims: verifyResult.verification.totalClaims,
        });
      }
    } catch (e) {
      logger.error("Legal agent: verification step threw unexpectedly, skipping", { error: e.message });
      parsed.verification = { ran: false, totalClaims: 0, failedClaims: 0, flagged: [] };
    }
  }

  parsed.response = appendSourceList(parsed.response, parsed.sources);

  return parsed;
}
