// agents/research.js — Research Agent
// Aeldorado by Solanacy Technologies
//
// Grounded in live web data. Before answering, this agent runs core/live-search.js
// (AI-proposed domains -> liveness check -> fetch/extract — no third-party search
// API involved). If no live data is found, it refuses to answer from internal/
// training knowledge rather than guessing.

import { generateWithFallback } from "../core/retry.js";
import { safeExtractJSON }      from "../core/json-utils.js";
import { getModelList }         from "./agent-utils.js";
import { runGroundedSearch, appendSourceList, GROUNDED_CITATION_RULES } from "../core/grounded-search.js";
import { verifyGroundedClaims } from "../core/claim-verification.js";
import { logger } from "../core/logger.js";

// [PROPRIETARY — REDACTED] Full persona/expertise/guardrail prompt removed
// from this public copy. GROUNDED_CITATION_RULES (imported, shared across
// agents) still applies on top of this in production — it enforces citing
// only from live-fetched sources, never from training knowledge, when the
// agent is in grounded mode.
const RESEARCH_SYSTEM = `[REDACTED — proprietary system prompt not included in public showcase]

${GROUNDED_CITATION_RULES}`;

export async function runResearchAgent({ task, rawMessage, ai, model, options = {} }) {
  const models = getModelList(ai, model);

  // IMPORTANT: search with the clean user question, not `task` — when called
  // via routes/agents.js, `task` may have project memory prepended (names,
  // company facts, etc.), which would otherwise get sent to Google verbatim
  // as the search string and return zero relevant results. `rawMessage` is
  // the original, unaugmented user message. Some callers (e.g. tool-registry
  // structured tools) only ever pass `task`, so fall back to it if rawMessage
  // isn't given.
  const searchQuery = (rawMessage && rawMessage.trim()) || task;

  const search = await runGroundedSearch({ task, searchQuery, agentLabel: "Research", ai, model });

  if (!search.ok) {
    const methodology = search.reason === "blocked"
      ? "Google search scraping was rate-limited/blocked on this attempt."
      : `Attempted live web search across ${search.attemptedCount} candidate source(s); none were reachable or had extractable content.`;
    return {
      summary: search.reason === "blocked" ? "Live search temporarily blocked." : "No live data found for this query.",
      findings: [],
      analysis: null,
      data: { key_facts: [], market_size: null, trends: [], competitors: [], opportunities: [] },
      methodology,
      sources: [],
      response: search.message,
      liveDataFound: false,
    };
  }

  // Output token budget scales with source count rather than staying
  // fixed. A flat ceiling can't cover both a 1-source single-query answer
  // and a 10-source (MAX_MERGED_SOURCES in query-expansion.js) multi-query
  // synthesis well — a synthesis over a large, deduped multi-query source
  // pool needs meaningfully more room to cite from than a single-source
  // answer does, or generation gets cut off mid-JSON. This scales with how
  // much source material the model actually has to work through and cite
  // from, capped so a pathological source count can't runaway the token
  // budget (and cost) unbounded.
  const sourceCount = search.sources.length;
  const scaledMaxTokens = Math.min(8192 + Math.max(0, sourceCount - 5) * 600, 16384);

  const response = await generateWithFallback(ai, {
    models,
    config: {
      systemInstruction: RESEARCH_SYSTEM,
      temperature: options.temperature || 0.4,
      // Grounded research answers are expected to cite every claim
      // against real live sources, which makes them meaningfully longer
      // than un-grounded answers. A lower token budget risks truncating
      // valid JSON mid-response before the model can close its own
      // markdown fence / closing brace, making safeExtractJSON's fence and
      // brace-matching strategies both fail on otherwise-valid output.
      maxOutputTokens: options.max_tokens || scaledMaxTokens,
    },
    contents: search.groundedTask,
    label: "RESEARCH",
    jsonMode: true,
  });

  const rawText = (response.text || "").trim();

  // Guard against a genuinely empty/whitespace-only model response (some
  // providers occasionally return just a newline with no error). Without
  // this check, safeExtractJSON's own fallback would carry that blank text
  // straight through to `response`, and the user gets a silent empty reply
  // with no indication anything went wrong.
  if (!rawText) {
    logger.error("Research agent: model returned empty response", { task: task.slice(0, 200) });
    return {
      summary: "The AI model returned an empty response.",
      findings: [],
      analysis: null,
      data: { key_facts: [], market_size: null, trends: [], competitors: [], opportunities: [] },
      methodology: "Live data was found and sent to the model, but the model's response was empty — likely a transient issue.",
      sources: search.sources.map(s => s.url),
      response: "Something went wrong generating the response just now — the live sources were found fine, but the answer came back empty. Please try again.",
      liveDataFound: true,
    };
  }

  // Fallback for when safeExtractJSON's own parsing strategies all fail
  // (e.g. a response truncated mid-JSON by hitting maxOutputTokens,
  // possibly wrapped in an unclosed ```json fence). Strip any leading
  // fence marker so raw JSON syntax never reaches the user, and surface a
  // clear message rather than a wall of malformed JSON text.
  const cleanedForDisplay = rawText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const looksLikeRawJson = cleanedForDisplay.startsWith("{") || cleanedForDisplay.startsWith("[");

  const fallback = looksLikeRawJson
    ? {
        summary: "The response was cut off before it could be fully generated.",
        response: "The answer got cut off partway through — this can happen with longer, detailed answers. Please try again, or ask a more specific/narrower question.",
      }
    : { summary: cleanedForDisplay.slice(0, 500), response: cleanedForDisplay };

  const parsed = safeExtractJSON(rawText, fallback);
  parsed.liveDataFound = true;

  // Always derive `sources` from search.sources, in the same order used to
  // number the SOURCE blocks in buildGroundedTask — never trust a
  // model-generated sources list here, even if it provided one, since any
  // reordering would silently break the [N] inline-citation mapping between
  // the model's [1][2][3] markers and what they actually point to. This
  // list IS the citation index.
  parsed.sources = search.sources.map(s => s.url);

  // Verification loop. Runs BEFORE appendSourceList so the
  // claim-extraction regex only sees the model's own prose and [N] markers,
  // not the appended "Sources:\n[1] domain.com" list (which would otherwise
  // get misread as more cited claims). Uses search.sources (not parsed.sources
  // strings) because verification needs each source's actual fetched content,
  // not just its URL. Order matches 1:1 with the [N] numbering already
  // established in buildGroundedTask, so result.index -> claim.sourceIndices
  // -> search.sources[i-1] all line up correctly.
  //
  // Fails safe by construction (see claim-verification.js) — if this throws
  // or times out for any reason, parsed.response is left completely
  // untouched and the agent's answer still ships normally.
  if (typeof parsed.response === "string" && parsed.response.trim()) {
    try {
      const verifyResult = await verifyGroundedClaims({
        responseText: parsed.response,
        sources: search.sources,
        ai,
        model,
      });
      parsed.response = verifyResult.responseText;
      parsed.verification = verifyResult.verification;

      if (verifyResult.verification.ran && verifyResult.verification.failedClaims > 0) {
        logger.warn("Research agent: unverified claims flagged", {
          failedClaims: verifyResult.verification.failedClaims,
          totalClaims: verifyResult.verification.totalClaims,
        });
      }
    } catch (e) {
      // Belt-and-suspenders: verifyGroundedClaims already fails safe
      // internally, but if something outside its own try/catch throws
      // (e.g. a bad ai/model reference), never let that break the answer.
      logger.error("Research agent: verification step threw unexpectedly, skipping", { error: e.message });
      parsed.verification = { ran: false, totalClaims: 0, failedClaims: 0, flagged: [] };
    }
  }

  parsed.response = appendSourceList(parsed.response, parsed.sources);

  return parsed;
}
