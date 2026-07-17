// core/claim-verification.js — Post-Generation Claim Verification Loop
// Aeldorado by Solanacy Technologies
//
// A self-checking pipeline layered on top of single-pass grounded
// generation. Every [N]-cited claim in a
// grounded answer gets checked against the ACTUAL fetched content of
// SOURCE N — not re-asked to the same model that wrote the claim, and not
// trusted just because a citation marker is present.
//
// Design goals (why this file exists as its own module, not inline in
// research.js):
//   1. GENERIC — takes { responseText, sources } and nothing else. No agent
//      name, no user/tenant data, no hardcoded schema. Any grounded agent
//      (CFO, Sales, Legal, Marketing) can reuse this unchanged once they
//      adopt the same [N]-citation convention Research already uses.
//   2. MODEL-DEPENDENCE MINIMIZED — claim EXTRACTION is pure regex/string
//      work, zero model calls. Only the actual support-check is an LLM
//      call, and it's ONE batched call (not one call per claim), given
//      ONLY the cited source's raw text — it cannot lean on training
//      knowledge to rubber-stamp a claim, because the prompt structurally
//      forces a source-text-only judgment.
//   3. FAILS SAFE — any error in this pipeline must never break or block
//      the underlying answer. On failure, return the original response
//      untouched with verification marked unavailable, never throw up to
//      the agent.

import { generateWithFallback } from "./retry.js";
import { safeExtractJSON } from "./json-utils.js";
import { getModelList } from "../agents/agent-utils.js";
import { logger } from "./logger.js";

// Matches one or more bracketed source refs at a claim boundary: [1], [2][3],
// [1, 2], [1,2,3], [2] [3], etc. Deliberately permissive on separators since
// models are inconsistent about "[2][3]" vs "[2, 3]" vs "[2],[3]" — each
// bracket pair can itself contain a comma-separated list of numbers, and
// consecutive bracket groups (with optional whitespace between them) are
// also matched as one marker run.
const CITATION_MARKER_RE = /((?:\[\d+(?:\s*,\s*\d+)*\]\s*)+)/g;

/**
 * Splits `text` into sentences, keeping punctuation, without pulling in a
 * full NLP dependency. Good enough for citation-claim boundaries — this
 * doesn't need to be linguistically perfect, just consistent.
 *
 * Deliberately does NOT split on a "." that's immediately preceded and
 * followed by a digit (e.g. "5.25%", "3.7 million") — a naive [^.!?]+[.!?]
 * split treats every decimal point as a sentence end, which both truncates
 * the actual claim sentence AND silently swallows the leading fragment as
 * its own (non-cited, discarded) "sentence". Numbers are exactly the kind of
 * thing a research/finance-oriented grounded answer is full of, so this
 * isn't a rare edge case here — it's a common case.
 */
function splitSentences(text) {
  // Temporarily mask decimal points inside numbers so they don't get
  // treated as sentence boundaries, then restore them after splitting.
  const DECIMAL_PLACEHOLDER = "\u0000DECIMAL\u0000";
  const masked = text.replace(/(\d)\.(\d)/g, `$1${DECIMAL_PLACEHOLDER}$2`);

  const rawSentences = masked.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [masked];

  return rawSentences
    .map(s => s.replace(new RegExp(DECIMAL_PLACEHOLDER, "g"), ".").trim())
    .filter(Boolean);
}

/**
 * Extracts every citation-bearing sentence from a grounded response, paired
 * with which source number(s) it cites. Pure string processing — no model
 * call, so this always runs and always costs ~0ms.
 *
 * @returns {Array<{ claim: string, sourceIndices: number[] }>}
 */
export function extractCitedClaims(responseText) {
  if (!responseText || typeof responseText !== "string") return [];

  const sentences = splitSentences(responseText);
  const claims = [];

  for (const sentence of sentences) {
    const markers = sentence.match(CITATION_MARKER_RE);
    if (!markers) continue;

    const sourceIndices = new Set();
    for (const marker of markers) {
      const nums = marker.match(/\d+/g) || [];
      nums.forEach(n => sourceIndices.add(parseInt(n, 10)));
    }

    if (sourceIndices.size > 0) {
      claims.push({ claim: sentence.trim(), sourceIndices: [...sourceIndices].sort((a, b) => a - b) });
    }
  }

  return claims;
}

const VERIFY_SYSTEM = `You are a strict fact-checking auditor. You will be given a list of CLAIMS, each naming which SOURCE(s) it says it came from, followed by the full text of those sources.

Your ONLY job: for each claim, decide whether the cited source(s) actually contain/support that claim.

RULES — NEVER VIOLATE:
1. Judge ONLY against the provided source text. Do not use outside knowledge to decide if a claim is "probably true" — a claim can be true in the real world and STILL FAIL this check if the cited source doesn't actually say it.
2. A claim PASSES only if the cited source text contains that fact, in substance (paraphrase is fine, exact wording is not required).
3. A claim FAILS if: the source doesn't mention it at all, the source says something different/contradictory, the source is vaguer than the claim states (e.g. claim gives an exact number but source only gives a range or doesn't give one), or the claim cites the wrong source number for that fact.
4. If a claim cites multiple sources, it passes if AT LEAST ONE of them supports it.
5. Be strict but fair — don't fail a claim over minor rounding or rephrasing that preserves meaning.

Respond with ONLY a JSON array, one object per claim, in the same order given:
[{"index": 0, "verdict": "pass" | "fail", "reason": "one short sentence, only if fail"}]`;

/**
 * Runs the actual verification LLM call for a batch of claims. Batched into
 * ONE call regardless of claim count, to keep this cheap and fast — the
 * per-claim isolation is achieved by structuring the prompt with explicit
 * indices, not by making N separate calls.
 */
async function verifyClaimsBatch({ claims, sources, ai, model }) {
  const sourceBlock = sources
    .map((s, i) => `SOURCE ${i + 1} (${s.url}):\n${(s.content || "").slice(0, 3000)}`)
    .join("\n\n---\n\n");

  const claimsBlock = claims
    .map((c, i) => `CLAIM ${i}: "${c.claim}" (cites source(s): ${c.sourceIndices.join(", ")})`)
    .join("\n");

  const prompt = `CLAIMS TO VERIFY:\n${claimsBlock}\n\n=== SOURCE TEXT ===\n\n${sourceBlock}`;

  const models = getModelList(ai, model);
  const response = await generateWithFallback(ai, {
    models,
    config: { systemInstruction: VERIFY_SYSTEM, temperature: 0, maxOutputTokens: 2048 },
    contents: prompt,
    label: "CLAIM_VERIFY",
    jsonMode: true,
  });

  const parsed = safeExtractJSON(response.text, []);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Main entry point. Verifies every [N]-cited claim in `responseText` against
 * `sources` (the same array already used to build the [N] mapping upstream —
 * caller MUST pass sources in the identical order used for citation numbers).
 *
 * Fails safe: on any internal error, returns the original response
 * unmodified with verification.ran = false. Never throws.
 *
 * @param {object} params
 * @param {string} params.responseText
 * @param {Array<{url, content}>} params.sources
 * @param {object} params.ai
 * @param {string} [params.model]
 * @returns {Promise<{ responseText: string, verification: object }>}
 */
export async function verifyGroundedClaims({ responseText, sources, ai, model }) {
  const noOp = {
    responseText,
    verification: { ran: false, totalClaims: 0, failedClaims: 0, flagged: [] },
  };

  try {
    if (!sources || sources.length === 0) return noOp;

    const claims = extractCitedClaims(responseText);
    if (claims.length === 0) return noOp;

    const results = await verifyClaimsBatch({ claims, sources, ai, model });

    if (!results.length) {
      logger.warn("Claim verification returned no results, skipping", { claimCount: claims.length });
      return noOp;
    }

    let annotatedText = responseText;
    const flagged = [];

    for (const result of results) {
      if (result.verdict !== "fail") continue;
      const claim = claims[result.index];
      if (!claim) continue;

      flagged.push({ claim: claim.claim, sourceIndices: claim.sourceIndices, reason: result.reason || "not supported by cited source" });

      // Annotate the unsupported claim in-place with a visible flag rather
      // than silently deleting it — deleting risks mangling sentence flow
      // (e.g. leaving a dangling connector word), and silent removal hides
      // from the user that something was caught and pulled, which cuts
      // against the whole point of showing verification is happening.
      if (annotatedText.includes(claim.claim)) {
        annotatedText = annotatedText.replace(
          claim.claim,
          `${claim.claim} [⚠ unverified — cited source did not confirm this]`
        );
      }
    }

    return {
      responseText: annotatedText,
      verification: {
        ran: true,
        totalClaims: claims.length,
        failedClaims: flagged.length,
        flagged,
      },
    };
  } catch (e) {
    logger.error("Claim verification pipeline failed, returning unverified response", { error: e.message });
    return noOp;
  }
}
