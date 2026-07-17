// agents/cfo.js — CFO Agent (Financial Analysis)
// Aeldorado by Solanacy Technologies
//
// Mostly reasons over data the user provides (revenue figures, expenses,
// projections) — that needs no live search. But some CFO questions depend
// on current real-world facts (today's exchange rate, a current interest
// rate affecting a projection, a just-announced tax change) that the model
// can't reliably know from training. shouldSearchLive() judges this per
// task rather than searching every time or never.

import { generateWithFallback } from "../core/retry.js";
import { safeExtractJSON }      from "../core/json-utils.js";
import { getModelList }         from "./agent-utils.js";
import { shouldSearchLive, runGroundedSearch, appendSourceList, GROUNDED_CITATION_RULES } from "../core/grounded-search.js";
import { logger } from "../core/logger.js";
import { FINANCIAL_CALCULATORS } from "../core/financial-calc.js";

// [PROPRIETARY — REDACTED] Full persona/expertise/guardrail prompt and
// strict JSON output contract (analysis / summary / data / response) removed
// from this public copy. Key behavior preserved in the real system: rule #8
// forbids the model from doing its own compounding/ratio arithmetic when a
// verified deterministic calculation is available (see tryDeterministicCalculation
// below) — this is what fixed an 8x arithmetic error found in testing.
const CFO_SYSTEM = `[REDACTED — proprietary system prompt not included in public showcase]`;

// Extraction-only system prompt — used in the pre-pass whose sole job is to
// pull structured numeric parameters out of the user's question, without
// doing any arithmetic itself. Keeping this a separate, narrow prompt makes
// the extraction step reliable and easy to validate.
// [PROPRIETARY — REDACTED] Full extraction prompt (which maps free-text
// questions to one of 10 deterministic calculator param shapes) removed.
// Output contract preserved here for context — this is what the real
// prompt asks the model to return:
//   { calculatorNeeded: "churn_loss" | "ltv_cac" | "compound_growth" |
//       "margin" | "burn_rate_runway" | "break_even" | "mrr_growth" |
//       "rule_of_40" | "current_ratio" | "revenue_multiple_valuation" | null,
//     params: {...}, confidence: "high" | "low" }
// If required params are missing or the question doesn't clearly match a
// calculator, calculatorNeeded is set to null rather than guessing.
const PARAM_EXTRACTION_SYSTEM = `[REDACTED — proprietary extraction prompt not included in public showcase]`;

/**
 * Pre-pass: ask the model to identify whether this task needs a deterministic
 * calculation and extract the raw numbers, WITHOUT doing the arithmetic
 * itself. If successful, run the real calculation in code and hand the
 * verified result back to the main CFO pass so it only has to explain a
 * number that is already correct, instead of computing it freehand.
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
      label: "CFO-param-extraction",
      jsonMode: true,
    });

    const parsed = safeExtractJSON(extraction.text || "", null);
    if (!parsed || !parsed.calculatorNeeded || parsed.confidence !== "high") {
      return null;
    }

    const calc = FINANCIAL_CALCULATORS[parsed.calculatorNeeded];
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
    logger.error("CFO agent: deterministic calculation pre-pass failed, falling back to free-text reasoning", { error: e.message });
    return null;
  }
}

const CFO_SYSTEM_GROUNDED = `${CFO_SYSTEM}

${GROUNDED_CITATION_RULES}

The LIVE SOURCE DATA below covers only the current/live-fact part of this task, if any — your own financial-analysis expertise (rules above) still applies to everything else. Don't force citations onto your own calculations or reasoning, only onto facts that actually came from the live sources.`;

export async function runCFOAgent({ task, rawMessage, ai, model, options = {} }) {
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
    logger.error("CFO agent: live-search decision failed, proceeding without search", { error: e.message });
  }

  let contents = task;
  let systemInstruction = CFO_SYSTEM;
  let searchSources = null;

  // Deterministic calculation pre-pass — catches compounding/ratio/growth
  // math (churn loss, LTV:CAC, compound growth, margin) and computes it in
  // code rather than trusting the model's free-text arithmetic. See
  // financial-calc.js header comment for why this exists (8x error found
  // in testing on a churn-loss projection).
  let verifiedCalculation = null;
  try {
    verifiedCalculation = await tryDeterministicCalculation({ task: searchQuery, ai, model: models[0] });
  } catch (e) {
    logger.error("CFO agent: unexpected error in calculation pre-pass, proceeding without it", { error: e.message });
  }

  if (verifiedCalculation) {
    contents =
      `${task}\n\n` +
      `VERIFIED CALCULATION (computed in code, not by you — use these exact numbers, do not recompute or override them):\n` +
      `Calculator used: ${verifiedCalculation.calculatorUsed}\n` +
      `Input parameters: ${JSON.stringify(verifiedCalculation.inputParams)}\n` +
      `Verified result: ${JSON.stringify(verifiedCalculation.verifiedResult)}\n\n` +
      `Explain this result clearly to the user, showing the relevant steps from the verified calculation above. Do not perform your own independent arithmetic that could contradict these verified numbers.`;
  }

  if (needsSearch) {
    const search = await runGroundedSearch({ task, searchQuery, agentLabel: "CFO", ai, model });
    if (search.ok) {
      // Preserve the verified-calculation block if one was injected above —
      // append the grounded search content rather than overwriting it, so a
      // query that needs BOTH a live fact (e.g. current interest rate) AND a
      // deterministic calculation doesn't silently lose the calculation.
      contents = verifiedCalculation
        ? `${search.groundedTask}\n\n${contents}`
        : search.groundedTask;
      systemInstruction = CFO_SYSTEM_GROUNDED;
      searchSources = search.sources;
    }
    // If search failed (blocked/no_data), fall through and answer with the
    // CFO's own domain expertise rather than hard-failing the whole task —
    // unlike Research (whose entire purpose is live data), CFO can still
    // often give a useful answer without it, just without the live-fact part.
  }

  const response = await generateWithFallback(ai, {
    models,
    config: {
      systemInstruction,
      temperature: options.temperature || 0.2,
      maxOutputTokens: options.max_tokens || 4096,
    },
    contents,
    label: "CFO",
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

  return parsed;
}
