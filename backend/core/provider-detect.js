// core/provider-detect.js — Auto-detect AI Provider from API Key
// Aeldorado by Solanacy Technologies
//
// Detects provider from key prefix pattern and returns available models.
// Supports: Gemini (Google), OpenAI, Anthropic
// All models are latest active versions as of June 2026.

/**
 * Provider definitions — key detection patterns and available models.
 * Ordered by detection priority (most specific first).
 */
const PROVIDERS = {
  gemini: {
    name: "Google Gemini",
    icon: "gemini",
    detect: (key) => key.startsWith("AIza"),
    models: [
      // Gemini 3.5 Series (Latest)
      { id: "gemini-3.5-flash",      name: "Gemini 3.5 Flash",       tier: "flagship", context: "1M tokens",   description: "Newest flagship — frontier agentic and coding performance" },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite",   tier: "flagship", context: "1M tokens",   description: "Latest flagship — agentic, coding, production" },
      // Gemini 3.1 Series
      { id: "gemini-3.1-pro",        name: "Gemini 3.1 Pro",         tier: "pro",      context: "1M tokens",   description: "Smarter, more capable — complex problem-solving" },
      { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite",  tier: "fast",     context: "1M tokens",   description: "Cost-efficient, high-volume, low-latency" },
      // Gemini 2.5 Series (Legacy but still active)
      { id: "gemini-2.5-pro",        name: "Gemini 2.5 Pro",         tier: "pro",      context: "1M tokens",   description: "Deep reasoning, complex analysis" },
      { id: "gemini-2.5-flash",      name: "Gemini 2.5 Flash",       tier: "fast",     context: "1M tokens",   description: "Balanced speed and quality" },
      // Gemma 4 Open Models
      { id: "gemma-4-31b-it",        name: "Gemma 4 31B",            tier: "open",     context: "128K tokens",  description: "Open-weight, advanced reasoning" },
      { id: "gemma-4-26b-a4b-it",    name: "Gemma 4 26B A4B",        tier: "open",     context: "128K tokens",  description: "Open-weight, efficient" },
      { id: "gemma-4-12b-it",        name: "Gemma 4 12B",            tier: "open",     context: "128K tokens",  description: "Open-weight, runs on laptops" },
    ],
    defaultModel: "gemini-3.1-flash-lite",
  },

  openai: {
    name: "OpenAI",
    icon: "openai",
    detect: (key) => key.startsWith("sk-") && !key.startsWith("sk-ant-"),
    models: [
      // GPT-5.5 (Latest Flagship)
      { id: "gpt-5.5",         name: "GPT-5.5",          tier: "flagship", context: "1M tokens",   description: "Latest flagship — complex reasoning, coding" },
      // GPT-5.4 Series
      { id: "gpt-5.4",         name: "GPT-5.4",          tier: "pro",      context: "1M tokens",   description: "Standard with native computer-use" },
      { id: "gpt-5.4-pro",     name: "GPT-5.4 Pro",      tier: "pro",      context: "1M tokens",   description: "Maximum reasoning depth" },
      { id: "gpt-5.4-mini",    name: "GPT-5.4 Mini",     tier: "fast",     context: "512K tokens",  description: "High-speed, cost-efficient" },
      { id: "gpt-5.4-nano",    name: "GPT-5.4 Nano",     tier: "fast",     context: "128K tokens",  description: "Most affordable, simple tasks" },
    ],
    defaultModel: "gpt-5.5",
  },

  anthropic: {
    name: "Anthropic Claude",
    icon: "anthropic",
    detect: (key) => key.startsWith("sk-ant-"),
    models: [
      // Claude Opus 4.x Series
      { id: "claude-opus-4-8",    name: "Claude Opus 4.8",    tier: "flagship", context: "200K tokens",  description: "Latest Opus — highest intelligence" },
      { id: "claude-opus-4-7",    name: "Claude Opus 4.7",    tier: "pro",      context: "200K tokens",  description: "High-end reasoning and vision" },
      { id: "claude-opus-4-6",    name: "Claude Opus 4.6",    tier: "pro",      context: "200K tokens",  description: "Premium reasoning" },
      // Claude Sonnet
      { id: "claude-sonnet-5",    name: "Claude Sonnet 5",    tier: "flagship", context: "200K tokens",  description: "Latest Sonnet — most agentic, near-Opus reasoning and coding" },
      { id: "claude-sonnet-4-6",  name: "Claude Sonnet 4.6",  tier: "balanced", context: "200K tokens",  description: "Balanced production model" },
      // Claude Haiku
      { id: "claude-haiku-4-5",   name: "Claude Haiku 4.5",   tier: "fast",     context: "200K tokens",  description: "Fast, cost-efficient" },
    ],
    defaultModel: "claude-sonnet-5",
  },
};

/**
 * Detect the AI provider from an API key.
 */
export function detectProvider(apiKey) {
  if (!apiKey || typeof apiKey !== "string" || apiKey.length < 10) return null;

  for (const [providerId, provider] of Object.entries(PROVIDERS)) {
    if (provider.detect(apiKey)) {
      return {
        provider: providerId,
        name:     provider.name,
        icon:     provider.icon,
        models:   provider.models,
        defaultModel: provider.defaultModel,
      };
    }
  }

  return null;
}

/**
 * Get available models for a specific provider.
 */
export function getProviderModels(providerId) {
  const provider = PROVIDERS[providerId];
  return provider ? provider.models : null;
}

/**
 * Validate that a model belongs to a provider.
 */
export function isValidModel(providerId, modelId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return false;
  return provider.models.some(m => m.id === modelId);
}

/**
 * Get the default model for a provider.
 */
export function getDefaultModel(providerId) {
  const provider = PROVIDERS[providerId];
  return provider ? provider.defaultModel : null;
}

/**
 * Mask an API key for display: show first 8 + last 4 chars.
 */
export function maskApiKey(apiKey) {
  if (!apiKey || apiKey.length < 12) return "••••••••";
  return `${apiKey.slice(0, 8)}${"•".repeat(6)}${apiKey.slice(-4)}`;
}

/**
 * List all supported providers (for frontend).
 */
export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    name:   p.name,
    icon:   p.icon,
    models: p.models,
    defaultModel: p.defaultModel,
  }));
}
