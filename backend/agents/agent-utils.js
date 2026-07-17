// agents/agent-utils.js — Shared utilities for all agents
// Aeldorado by Solanacy Technologies

/**
 * Get model fallback list based on the AI client's provider.
 * Ensures agents always use models that match the user's provider.
 */
export const PROVIDER_MODELS = {
  gemini:    ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro"],
  openai:    ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4"],
  anthropic: ["claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"],
};

export function getModelList(ai, model) {
  const provider = ai?.provider || "gemini";
  const fallbacks = PROVIDER_MODELS[provider] || PROVIDER_MODELS.gemini;
  return model ? [model, ...fallbacks.slice(0, 2)] : fallbacks;
}

