// agents/support.js — Support Agent
// Aeldorado by Solanacy Technologies

import { generateWithFallback } from "../core/retry.js";
import { safeExtractJSON }      from "../core/json-utils.js";
import { getModelList }         from "./agent-utils.js";

// [PROPRIETARY — REDACTED] Full persona/expertise/guardrail prompt removed.
// Notable rule preserved in production: the agent has no real system
// access, so it's explicitly forbidden from writing in a tense that claims
// an action already happened ("I have processed your refund") since it
// hasn't — templates must stay honest about what's still pending, either as
// next-step instructions for a human agent or as non-overclaiming
// customer-facing language.
const SUPPORT_SYSTEM = `[REDACTED — proprietary system prompt not included in public showcase]`;

export async function runSupportAgent({ task, ai, model, options = {} }) {
  const models = getModelList(ai, model);

  const response = await generateWithFallback(ai, {
    models,
    config: {
      systemInstruction: SUPPORT_SYSTEM,
      temperature: options.temperature || 0.3,
      maxOutputTokens: options.max_tokens || 4096,
    },
    contents: task,
    label: "SUPPORT",
  });

  return safeExtractJSON(response.text || "", { summary: response.text?.slice(0, 500), response: response.text });
}
