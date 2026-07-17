// agents/ceo.js — CEO Agent (Direct Call Wrapper)
// Aeldorado by Solanacy Technologies

import { generateWithFallback } from "../core/retry.js";
import { safeExtractJSON }      from "../core/json-utils.js";
import { getModelList }         from "./agent-utils.js";

// ─────────────────────────────────────────────────────────────────────────
// [PROPRIETARY — REDACTED FOR PUBLIC SHOWCASE]
// The full system prompt engineering (persona definition, expertise scoping,
// response-style rules, guardrails, and structured JSON output contract)
// has been removed from this public copy. In production this is a carefully
// tuned ~30-line prompt defining the CEO agent's executive persona, its
// memory-context usage rules, anti-hallucination guardrails, and a strict
// JSON output schema (summary / analysis / recommendations / response).
// ─────────────────────────────────────────────────────────────────────────
const CEO_DIRECT_SYSTEM = `[REDACTED — proprietary system prompt not included in public showcase]`;

export async function runCEOAgent({ task, ai, model, options = {} }) {
  const models = getModelList(ai, model);

  const response = await generateWithFallback(ai, {
    models,
    config: {
      systemInstruction: CEO_DIRECT_SYSTEM,
      temperature: options.temperature || 0.3,
      maxOutputTokens: options.max_tokens || 4096,
    },
    contents: task,
    label: "CEO",
  });

  return safeExtractJSON(response.text || "", { summary: response.text?.slice(0, 500), response: response.text });
}
