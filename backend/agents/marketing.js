// agents/marketing.js — Marketing Agent
// Aeldorado by Solanacy Technologies

import { generateWithFallback } from "../core/retry.js";
import { safeExtractJSON }      from "../core/json-utils.js";
import { getModelList }         from "./agent-utils.js";

// [PROPRIETARY — REDACTED] Full persona/expertise/guardrail prompt removed.
// Notable rule preserved in production: when asked to announce unverifiable
// events (funding rounds, metrics, partnerships), the agent treats the
// request as "draft this claim" rather than "confirm this fact" — it writes
// the content without inventing supporting details (investor names, dates,
// extra figures) that weren't actually provided.
const MARKETING_SYSTEM = `[REDACTED — proprietary system prompt not included in public showcase]`;

export async function runMarketingAgent({ task, ai, model, options = {} }) {
  const models = getModelList(ai, model);

  const response = await generateWithFallback(ai, {
    models,
    config: {
      systemInstruction: MARKETING_SYSTEM,
      temperature: options.temperature || 0.6,
      maxOutputTokens: options.max_tokens || 4096,
    },
    contents: task,
    label: "MARKETING",
  });

  return safeExtractJSON(response.text || "", { summary: response.text?.slice(0, 500), response: response.text });
}
