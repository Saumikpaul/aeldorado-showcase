// core/json-utils.js — Safe JSON Extraction from AI Responses
// Aeldorado by Solanacy Technologies
// Adapted from Solanacy Backend v1

/**
 * Safely extract JSON from an AI response that may contain markdown fences,
 * extra text, or malformed output.
 *
 * @param {string} text       - Raw AI response text
 * @param {object} fallback   - Fallback object if parsing fails
 * @returns {object}
 */
import { logger } from "./logger.js";

export function safeExtractJSON(text, fallback = {}) {
  if (!text || typeof text !== "string") return fallback;

  // Strategy 1: Try direct parse
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Strategy 2: Extract from markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch { /* continue */ }
  }

  // Strategy 3: Find first { ... } block
  const braceStart = text.indexOf("{");
  const braceEnd   = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(text.slice(braceStart, braceEnd + 1));
    } catch { /* continue */ }
  }

  // Strategy 4: Find first [ ... ] block
  const bracketStart = text.indexOf("[");
  const bracketEnd   = text.lastIndexOf("]");
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    try {
      return JSON.parse(text.slice(bracketStart, bracketEnd + 1));
    } catch { /* continue */ }
  }

  // All strategies failed — return fallback with raw snippet
  logger.warn("Failed to extract JSON from AI response", { snippet: text.slice(0, 200) });
  return { ...fallback, _rawSnippet: text.slice(0, 300), _parseError: true };
}
