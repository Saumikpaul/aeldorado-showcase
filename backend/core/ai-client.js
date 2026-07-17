// core/ai-client.js — Unified AI Client Factory (Multi-Provider)
// Aeldorado by Solanacy Technologies
//
// Creates per-request AI client instances using the USER's API key.
// Supports: Gemini, OpenAI, Anthropic
// Keys are decrypted in-memory and discarded after the call completes.

import { GoogleGenAI } from "@google/genai";
import { logger } from "./logger.js";

/**
 * Supported provider factories.
 * Each provider returns an AI client instance + a unified generate function.
 */
const PROVIDER_FACTORIES = {
  gemini: (apiKey) => {
    const ai = new GoogleGenAI({ apiKey });
    return {
      provider: "gemini",
      raw: ai,
      /**
       * Unified generate — same interface across providers.
       */
      async generate({ model, systemPrompt, message, temperature, maxTokens, stream, jsonMode }) {
        const config = {
          systemInstruction: systemPrompt,
          temperature: temperature || 0.3,
          maxOutputTokens: maxTokens || 4096,
        };

        // Enforce valid JSON at the API level rather than hoping the model
        // follows a "respond in JSON" prompt instruction. This matters most
        // on creative/long-form tasks (e.g. "write me an email template") —
        // a Sales agent asked to write a cold-email template can otherwise
        // return plain-text commentary about the template with no JSON
        // structure at all, so safeExtractJSON's fallback drops the entire
        // `data` object and the template text itself risks getting mixed
        // into unstructured prose instead of a clean `response` field.
        // responseMimeType makes the model structurally unable to return
        // non-JSON, regardless of how demanding the rest of the task is.
        if (jsonMode) {
          config.responseMimeType = "application/json";
        }

        if (stream) {
          const response = await ai.models.generateContentStream({
            model,
            config,
            contents: message,
          });
          return { stream: response, type: "gemini-stream" };
        }

        const response = await ai.models.generateContent({
          model,
          config,
          contents: message,
        });
        return {
          text: response.text || "",
          usage: {
            inputTokens:  response.usageMetadata?.promptTokenCount || 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
            totalTokens:  response.usageMetadata?.totalTokenCount || 0,
          },
        };
      },
    };
  },

  openai: (apiKey) => {
    return {
      provider: "openai",
      raw: null,
      async generate({ model, systemPrompt, message, temperature, maxTokens, stream, jsonMode }) {
        const body = {
          model: model || "gpt-5.4-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: message },
          ],
          temperature: temperature || 0.3,
          max_tokens: maxTokens || 4096,
          stream: !!stream,
        };

        // Same reasoning as the Gemini provider: enforce valid JSON at the
        // API level via OpenAI's native response_format instead of relying
        // on the model to follow a prompt instruction under pressure from a
        // long/creative generation task.
        if (jsonMode) {
          body.response_format = { type: "json_object" };
        }

        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (stream) {
          return { stream: res.body, type: "openai-stream" };
        }

        const data = await res.json();
        if (data.error) {
          logger.error("OpenAI API error", { error: data.error, model });
          throw new Error(data.error.message);
        }

        return {
          text: data.choices?.[0]?.message?.content || "",
          usage: {
            inputTokens:  data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
            totalTokens:  data.usage?.total_tokens || 0,
          },
        };
      },
    };
  },

  anthropic: (apiKey) => {
    return {
      provider: "anthropic",
      raw: null,
      async generate({ model, systemPrompt, message, temperature, maxTokens, stream }) {
        const body = {
          model: model || "claude-sonnet-4-6",
          system: systemPrompt,
          messages: [
            { role: "user", content: message },
          ],
          temperature: temperature || 0.3,
          max_tokens: maxTokens || 4096,
          stream: !!stream,
        };

        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });

        if (stream) {
          return { stream: res.body, type: "anthropic-stream" };
        }

        const data = await res.json();
        if (data.error) {
          logger.error("Anthropic API error", { error: data.error, model });
          throw new Error(data.error.message);
        }

        const textBlocks = (data.content || []).filter(b => b.type === "text");
        return {
          text: textBlocks.map(b => b.text).join("") || "",
          usage: {
            inputTokens:  data.usage?.input_tokens || 0,
            outputTokens: data.usage?.output_tokens || 0,
            totalTokens:  (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
          },
        };
      },
    };
  },
};

/**
 * Create a unified AI client for the specified provider.
 * This client is ephemeral — created per-request and discarded.
 */
export function createAIClient(provider, apiKey) {
  const factory = PROVIDER_FACTORIES[provider];
  if (!factory) {
    throw new Error(`Unsupported AI provider: "${provider}". Supported: ${Object.keys(PROVIDER_FACTORIES).join(", ")}`);
  }
  return factory(apiKey);
}

/**
 * Check if a provider is currently supported.
 */
export function isProviderSupported(provider) {
  return provider in PROVIDER_FACTORIES;
}

/**
 * List all supported providers.
 */
export function listSupportedProviders() {
  return Object.keys(PROVIDER_FACTORIES);
}
