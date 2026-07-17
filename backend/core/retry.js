// core/retry.js — Retry wrapper + model fallback for AI calls
// Aeldorado by Solanacy Technologies
// Adapted from Solanacy Backend v1 — model-aware config handling

/**
 * Known model families and their capabilities.
 * Used to auto-strip unsupported config params before calling.
 */
const GEMMA_MODELS = ["gemma-4-31b-it", "gemma-4-26b-a4b-it", "gemma-4-12b-it"];

function isGemmaModel(model) {
  return GEMMA_MODELS.some(gm => model.includes(gm) || model.startsWith("gemma"));
}

/**
 * Sanitize config for a specific model — strips unsupported params.
 * Gemma 4 uses thinkingLevel ("HIGH"/"MINIMAL"), NOT thinkingBudget.
 * Gemini 2.5/3 uses thinkingBudget (number).
 */
function sanitizeConfigForModel(model, config) {
  const cleaned = { ...config };

  if (isGemmaModel(model) && cleaned.thinkingConfig) {
    const tc = { ...cleaned.thinkingConfig };

    if ("thinkingBudget" in tc) {
      delete tc.thinkingBudget;
      if (!tc.thinkingLevel) {
        tc.thinkingLevel = "HIGH";
      }
    }

    if (tc.thinkingLevel && !["HIGH", "MINIMAL"].includes(tc.thinkingLevel)) {
      tc.thinkingLevel = "HIGH";
    }

    cleaned.thinkingConfig = tc;
  }

  return cleaned;
}

/**
 * Exponential backoff retry for any async function.
 * Retries on transient errors (500, 503, RESOURCE_EXHAUSTED, timeout).
 */
import { logger } from "./logger.js";

export async function withRetry(fn, { maxRetries = 2, baseDelayMs = 1000, label = "call" } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = e.message || "";
      const isRetryable = msg.includes("500") || msg.includes("503")
        || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("timeout")
        || msg.includes("UNAVAILABLE") || msg.includes("DEADLINE_EXCEEDED");

      if (!isRetryable || attempt === maxRetries) throw e;

      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      logger.warn(`Retry attempt ${attempt + 1} failed`, { label, error: msg, retryIn: Math.round(delay) });
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Generate AI content with automatic model fallback.
 * Tries models in order; if one fails, falls back to the next.
 * Auto-sanitizes config per model (handles Gemma vs Gemini differences).
 *
 * Works with the unified ai-client.js which exposes ai.generate().
 */
export async function generateWithFallback(ai, { models, config, contents, label = "AI", jsonMode = false }) {
  let lastError;
  for (const model of models) {
    const start = Date.now();
    try {
      const cleanConfig = sanitizeConfigForModel(model, config);
      const response = await withRetry(
        () => ai.generate({
          model,
          systemPrompt: cleanConfig.systemInstruction || "",
          message:      contents,
          temperature:  cleanConfig.temperature,
          maxTokens:    cleanConfig.maxOutputTokens,
          jsonMode,
        }),
        { label: `${label}:${model}`, maxRetries: 2 }
      );

      const elapsed = Date.now() - start;
      logger.info(`AI model responded`, { label, model, latency: elapsed });
      return response; // { text, usage }
    } catch (e) {
      const elapsed = Date.now() - start;
      lastError = e;
      logger.warn(`AI model failed`, { label, model, latency: elapsed, error: e.message });
    }
  }
  throw lastError;
}
