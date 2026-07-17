// agents/sales.js — Sales Agent
// Aeldorado by Solanacy Technologies
//
// Mostly reasons over provided context (leads, deals, product info) — that
// needs no live search. But some Sales questions depend on current
// real-world facts (a competitor's current pricing, a prospect company's
// recent news, current market conditions for a pitch) that the model can't
// reliably know from training. shouldSearchLive() judges this per task
// rather than searching every time or never.
//
// DETERMINISTIC PRE-PASS: mirrors cfo.js. Deal scoring, forecasting, quota
// attainment, and sales velocity are quantitative and were previously pure
// model guesses (deal_analyzer "estimated win probability" with no formula
// behind it at all). These now run through sales-calc.js in code; the model
// only explains/strategizes around a verified number. Objection handling
// gets similar treatment via a structured framework lookup instead of
// invented-each-time responses — see sales-calc.js header comment.

import { generateWithFallback } from "../core/retry.js";
import { safeExtractJSON }      from "../core/json-utils.js";
import { getModelList }         from "./agent-utils.js";
import { shouldSearchLive, runGroundedSearch, appendSourceList, GROUNDED_CITATION_RULES } from "../core/grounded-search.js";
import { logger } from "../core/logger.js";
import { SALES_CALCULATORS, matchObjectionFramework } from "../core/sales-calc.js";

// [PROPRIETARY — REDACTED] Full persona/expertise/guardrail prompt removed.
// Notable rules preserved in production: forbids inventing win-probability/
// forecast/quota numbers in free text when a verified calculation exists
// (see tryDeterministicCalculation below), and requires confidence labels
// on deal scores to be surfaced honestly rather than hidden when favorable.
const SALES_SYSTEM = `[REDACTED — proprietary system prompt not included in public showcase]`;

// Extraction-only system prompt — pulls structured numeric parameters out of
// the user's question without doing any math itself. Mirrors cfo.js's
// PARAM_EXTRACTION_SYSTEM exactly, adapted to the sales calculator shapes.
// [PROPRIETARY — REDACTED] Full extraction prompt removed. Maps free-text
// questions to one of 4 deterministic sales calculators (deal_score,
// weighted_forecast, quota_attainment, sales_velocity) plus a confidence
// object per factor, distinguishing "which calculator + params were
// identified" confidence from "how certain are the underlying business
// facts" confidence — the latter is surfaced to the end user honestly.
const PARAM_EXTRACTION_SYSTEM = `[REDACTED — proprietary extraction prompt not included in public showcase]`;

/**
 * Pre-pass: ask the model to identify whether this task needs a deterministic
 * calculation and extract the raw numbers, WITHOUT doing the arithmetic
 * itself. If successful, run the real calculation in code and hand the
 * verified result back to the main Sales pass so it only has to explain a
 * number that is already correct, instead of inventing one freehand.
 * Mirrors cfo.js's tryDeterministicCalculation.
 */
async function tryDeterministicCalculation({ task, ai, model }) {
  try {
    const extraction = await generateWithFallback(ai, {
      models: [model],
      config: {
        systemInstruction: PARAM_EXTRACTION_SYSTEM,
        temperature: 0,
        maxOutputTokens: 512,
      },
      contents: task,
      label: "Sales-param-extraction",
      jsonMode: true,
    });

    const parsed = safeExtractJSON(extraction.text || "", null);
    if (!parsed || !parsed.calculatorNeeded || parsed.extractionConfidence !== "high") {
      return null;
    }

    const calc = SALES_CALCULATORS[parsed.calculatorNeeded];
    if (!calc) return null;

    const hasAllParams = calc.requiredParams.every(
      (p) => parsed.params && parsed.params[p] !== undefined && parsed.params[p] !== null
    );
    if (!hasAllParams) return null;

    const result = calc.fn(parsed.params);
    return {
      calculatorUsed: parsed.calculatorNeeded,
      inputParams: parsed.params,
      verifiedResult: result,
    };
  } catch (e) {
    logger.error("Sales agent: deterministic calculation pre-pass failed, falling back to free-text reasoning", { error: e.message });
    return null;
  }
}

// Lightweight, keyword-based objection detection — deterministic, no LLM
// call needed. Looks for an explicit objection quote/description in the
// task text and matches it to a known framework. If nothing matches, the
// model reasons freely (this only grounds the common, recognizable cases).
function tryObjectionFrameworkMatch(task) {
  try {
    return matchObjectionFramework(task);
  } catch (e) {
    logger.error("Sales agent: objection framework matching failed, proceeding without it", { error: e.message });
    return { matched: false };
  }
}

const SALES_SYSTEM_GROUNDED = `${SALES_SYSTEM}

${GROUNDED_CITATION_RULES}

The LIVE SOURCE DATA below covers only the current/live-fact part of this task, if any — your own sales expertise (rules above) still applies to everything else. Don't force citations onto your own strategy/pitch content, only onto facts that actually came from the live sources.`;

export async function runSalesAgent({ task, rawMessage, ai, model, options = {} }) {
  const models = getModelList(ai, model);

  // Same reasoning as research.js: search with the clean user question, not
  // `task` — `task` may have project memory prepended (names, company facts,
  // etc.), which would otherwise get sent to the search engine verbatim and
  // return zero relevant results. Some callers only ever pass `task`, so
  // fall back to it if rawMessage isn't given.
  const searchQuery = (rawMessage && rawMessage.trim()) || task;

  let needsSearch = false;
  try {
    needsSearch = await shouldSearchLive({ task: searchQuery, ai, model: models[0] });
  } catch (e) {
    logger.error("Sales agent: live-search decision failed, proceeding without search", { error: e.message });
  }

  let contents = task;
  let systemInstruction = SALES_SYSTEM;
  let searchSources = null;

  // Deterministic calculation pre-pass — catches deal scoring, forecasting,
  // quota attainment, and sales velocity math and computes it in code rather
  // than trusting the model's free-text "estimate." See sales-calc.js header
  // comment for why this exists (deal_analyzer previously guessed win
  // probability from vibes with no formula at all).
  let verifiedCalculation = null;
  try {
    verifiedCalculation = await tryDeterministicCalculation({ task: searchQuery, ai, model: models[0] });
  } catch (e) {
    logger.error("Sales agent: unexpected error in calculation pre-pass, proceeding without it", { error: e.message });
  }

  // Structured objection-handling match — grounds the counter-strategy in a
  // known framework instead of letting the model invent one from scratch.
  const objectionMatch = tryObjectionFrameworkMatch(searchQuery);

  if (verifiedCalculation) {
    contents =
      `${task}\n\n` +
      `VERIFIED CALCULATION (computed in code, not by you — use these exact numbers, do not recompute or override them):\n` +
      `Calculator used: ${verifiedCalculation.calculatorUsed}\n` +
      `Input parameters: ${JSON.stringify(verifiedCalculation.inputParams)}\n` +
      `Verified result: ${JSON.stringify(verifiedCalculation.verifiedResult)}\n\n` +
      `Explain this result clearly to the user, showing the relevant factors from the verified calculation above. Do not perform your own independent scoring/math that could contradict these verified numbers.`;
  }

  if (objectionMatch.matched) {
    contents =
      `${contents}\n\n` +
      `VERIFIED OBJECTION FRAMEWORK (matched from a structured knowledge base, not invented — use this strategy, personalize the wording to this specific deal):\n` +
      `Category: ${objectionMatch.category}\n` +
      `Framework: ${objectionMatch.framework}`;
  }

  if (needsSearch) {
    const search = await runGroundedSearch({ task, searchQuery, agentLabel: "Sales", ai, model });
    if (search.ok) {
      // Preserve any verified-calculation/objection-framework blocks already
      // injected above — append the grounded search content rather than
      // overwriting it, so a query needing BOTH a live fact (e.g. current
      // competitor pricing) AND a deterministic calculation doesn't silently
      // lose the calculation.
      contents = (verifiedCalculation || objectionMatch.matched)
        ? `${search.groundedTask}\n\n${contents}`
        : search.groundedTask;
      systemInstruction = SALES_SYSTEM_GROUNDED;
      searchSources = search.sources;
    }
    // If search failed (blocked/no_data), fall through and answer with the
    // Sales agent's own expertise rather than hard-failing the whole task.
  }

  const response = await generateWithFallback(ai, {
    models,
    config: {
      systemInstruction,
      temperature: options.temperature || 0.4,
      maxOutputTokens: options.max_tokens || 4096,
    },
    contents,
    label: "SALES",
    jsonMode: true,
  });

  const parsed = safeExtractJSON(response.text || "", { summary: response.text?.slice(0, 500), response: response.text });

  if (searchSources && searchSources.length > 0) {
    parsed.sources = searchSources.map(s => s.url);
    parsed.response = appendSourceList(parsed.response, parsed.sources);
    parsed.liveDataFound = true;
  }

  if (verifiedCalculation) {
    parsed.verifiedCalculation = verifiedCalculation;
  }

  if (objectionMatch.matched) {
    parsed.objectionFramework = { category: objectionMatch.category, key: objectionMatch.key };
  }

  return parsed;
}
