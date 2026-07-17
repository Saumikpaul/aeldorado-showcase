// core/grounded-search.js — Shared Live-Search Grounding Utilities
// Aeldorado by Solanacy Technologies
//
// Extracted from agents/research.js so that any agent doing its own live
// search (CFO, Sales, Legal, Marketing) gets the exact same grounding
// quality Research has — numbered [N] citations mapped deterministically
// to sources, publish-date awareness, source-type hints, and a hard rule
// against filling gaps from training knowledge — instead of each agent
// re-implementing (and likely drifting from) this logic independently.
//
// This module does NOT decide *whether* to search — that's each agent's
// own judgment call. This module only standardizes what happens *after*
// a decision to search has been made: building the grounded prompt block
// and providing the prompt rules every grounded agent should include
// verbatim.

import { liveWebSearch } from "./live-search.js";
import { expandedLiveSearch } from "./query-expansion.js";
import { generateWithFallback } from "./retry.js";
import { getModelList } from "../agents/agent-utils.js";
import { logger } from "./logger.js";

const SEARCH_DECISION_SYSTEM = `You decide whether answering a task requires CURRENT, LIVE, or RECENT real-world information that could have changed since a model's training — as opposed to stable domain knowledge, general reasoning, or things the user themselves provided in the task (numbers, context, data to analyze).

A "TODAY'S DATE" line will appear above the task — use it. Your training data has a cutoff well before that date; anything about the outside world's *current state* (a rate, a price, who holds a role, whether something still exists or is still true) may have changed in the gap between your cutoff and today, even if you feel confident you know the answer. That confidence is exactly the failure mode this check exists to catch — a stale fact recalled fluently is more dangerous than an obvious unknown, because it gets stated without hesitation.

Answer "true" if the task depends on: current prices/rates/figures of any kind, recent news or events, a competitor's or company's current offerings/pricing/status, current status of a person/company/policy/law, anything dated in the near past or future relative to TODAY'S DATE, or any specific real-world fact that a reasonable person would expect to look up rather than recall from memory — regardless of whether the question uses words like "latest" or "current" explicitly. A question can imply "as of now" without ever using that phrase (e.g. "what does X cost", "how does Y's pricing compare", "what's the interest rate").

Answer "false" only if the task is: analysis/reasoning over data the user already gave you, general domain expertise that doesn't change (how financial ratios work, standard legal concepts, marketing best practices, how something works conceptually), a request to draft/write something from provided inputs, or a hypothetical/estimation task with no real-world current-fact dependency.

When genuinely unsure whether a fact could have moved since training, prefer "true" — an unnecessary search costs a little latency, but answering a real-world current-fact question from possibly-stale memory risks a confidently wrong answer with no way for the user to catch it.

Respond with ONLY the single word true or false, nothing else.`;

// Today's date, stamped into every grounded prompt (and the search-decision
// call) so the model has an actual anchor to judge staleness against.
// Without this, a model has no way to know its own training knowledge
// (e.g. "the repo rate is 6.00%, as of April 2025") is over a year out of
// date relative to "now" — it will confidently state a stale number
// because nothing in its context tells it *when* now is. Recomputed
// per-call (not a module-load constant) so a long-running process never
// serves a stale date of its own.
//
// FIX (2026-07-07): explicitly pinned to Asia/Kolkata (IST). Without a
// timeZone override, new Date().toLocaleDateString() uses whatever
// timezone the Node process itself runs in — Render's containers default
// to UTC, not IST. Aeldorado is an India-focused product; for roughly 5.5
// hours every day (UTC 18:30-23:59, i.e. IST 00:00-05:29), an
// unpinned UTC stamp would report the WRONG calendar date relative to
// India's actual "today" — one day behind. That's exactly the window
// where every staleness/recency judgment in this file (gapDays
// calculation, "is this source recent enough", "which source is most
// recent") would be silently computed against the wrong reference date.
// Confirmed via live testing that the container itself resolves to UTC
// with no TZ override, so this can't be left to environment config alone.
function currentDateStamp() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

/**
 * Fast, cheap classification call deciding whether a task needs live web
 * search before answering. Deliberately a separate lightweight call (not
 * folded into the main generation) so it's fast and doesn't bias the main
 * answer's own reasoning — the agent calling this stays in full control of
 * whether to act on the result.
 *
 * Fails safe: on any error, returns false (don't search) rather than
 * blocking the agent's response on a broken classifier — the agent still
 * has its own domain knowledge to fall back on either way.
 */
export async function shouldSearchLive({ task, ai, model }) {
  try {
    const models = getModelList(ai, model);
    const response = await generateWithFallback(ai, {
      models,
      config: {
        systemInstruction: SEARCH_DECISION_SYSTEM,
        temperature: 0,
        maxOutputTokens: 10,
      },
      // Stamp today's date onto the decision call too — otherwise the
      // classifier has to guess how old its own training knowledge is
      // relative to "now" when deciding if a fact "could have changed
      // since training." Same task text the main call will use later.
      contents: `TODAY'S DATE: ${currentDateStamp()}\n\n${task}`,
      label: "SEARCH_DECISION",
    });


    const answer = (response.text || "").trim().toLowerCase();
    return answer.startsWith("true");
  } catch (e) {
    logger.error("shouldSearchLive classification failed, defaulting to no-search", { error: e.message });
    return false;
  }
}

// Lightweight, rule-based hint about what kind of domain a source is —
// not a reliability score (that would be a much bigger claim than we can
// actually back), just a category the model can use as one input among
// several when weighing conflicting sources. Deliberately simple: a
// suffix/substring check, no external allowlist/API to maintain.
export function classifyDomain(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (host.endsWith(".gov") || host.includes(".gov.")) return "government";
  if (host.endsWith(".edu") || host.includes(".ac.")) return "academic";
  if (host.includes("wikipedia.org")) return "wiki (community-edited)";
  if (host.endsWith(".org")) return "nonprofit/org";
  if (
    host.includes("reuters.com") || host.includes("apnews.com") ||
    host.includes("bloomberg.com") || host.includes("nytimes.com") ||
    host.includes("bbc.co") || host.includes("hindustantimes.com") ||
    host.includes("timesofindia.com") || host.includes("cbsnews.com")
  ) return "news outlet";
  return null; // no strong signal either way — not worth guessing
}

// CODE-LEVEL RECENCY FIX (2026-07-07): previously, "find the most recent
// source and prioritize it" was a PROMPT instruction only (rule 4 below) —
// entirely the model's discretion to actually scan every source's date and
// act on it. Confirmed via live testing: this failed in practice — a
// present-tense question ("how should businesses act NOW") got answered
// using an older source's figures without any staleness disclosure, even
// though the rule explicitly required one. A discretionary instruction the
// model can silently skip is not the same as an enforced behavior.
//
// Fix: sort sources by parsed publishedDate (newest first) IN CODE before
// they ever reach the prompt, and explicitly mark the most recent one. This
// removes "find the most recent source" as a task the model has to perform
// correctly — it's now positional (source 1 always is the most recent) and
// explicitly labeled, not something the model has to compute from a wall of
// SOURCE blocks in whatever order the search engine happened to return them.

/**
 * Best-effort date parse. Returns a millis timestamp or null if unparseable/
 * missing — never throws, since publishedDate comes from third-party search
 * engine metadata in wildly inconsistent formats (or is absent entirely).
 */
function parseSourceDate(publishedDate) {
  if (!publishedDate) return null;
  const t = Date.parse(publishedDate);
  return Number.isNaN(t) ? null : t;
}

/**
 * Sorts sources newest-first by publishedDate. Sources with no parseable
 * date are pushed to the end (treated as "unknown recency", never assumed
 * current) rather than sorted arbitrarily — an undated source competing for
 * the "most recent" slot against a dated one would be exactly backwards.
 * Stable for ties / all-undated input (Array.sort is stable in modern JS),
 * so this never reorders same-date or all-undated sources unpredictably.
 */
function sortSourcesByRecency(sources) {
  return [...sources].sort((a, b) => {
    const da = parseSourceDate(a.publishedDate);
    const db = parseSourceDate(b.publishedDate);
    if (da === null && db === null) return 0;
    if (da === null) return 1;  // a has no date -> sorts after b
    if (db === null) return -1; // b has no date -> a sorts before it
    return db - da; // newest first
  });
}

/** Whole days between two millis timestamps, always >= 0. */
function daysBetween(newerMs, olderMs) {
  return Math.max(0, Math.round((newerMs - olderMs) / (1000 * 60 * 60 * 24)));
}

// If the single most recent source is older than this many days relative to
// today, a mandatory staleness-disclosure instruction (with the actual
// computed day-gap) is injected directly into the task text — deliberately
// generous (45 days) so it catches a genuinely stale fast-moving figure (a
// policy rate, a stock price) without false-triggering on normal
// information that just hasn't been re-reported very recently.
const STALENESS_WARNING_DAYS = 45;

// Builds the same SOURCE 1/2/3... block format Research uses, so every
// grounded agent's [N] citations map onto an identically-structured prompt.
//
// CODE-LEVEL RECENCY ENFORCEMENT: sources are sorted newest-first before
// numbering — SOURCE 1 is always the most recent dated source, not
// whatever order the search engine happened to return. It's explicitly
// marked "MOST RECENT DATED SOURCE" inline, and if it's older than
// STALENESS_WARNING_DAYS relative to today, a mandatory staleness
// disclosure (with the actual computed day-gap) is injected directly into
// the task text — not left as a general prompt rule the model has to
// remember to apply on its own.
export function buildGroundedTask(task, sources) {
  const sorted = sortSourcesByRecency(sources);
  const mostRecentMs = sorted.length > 0 ? parseSourceDate(sorted[0].publishedDate) : null;

  const sourceBlock = sorted
    .map((s, i) => {
      const dateLine = s.publishedDate ? `\nPUBLISHED: ${s.publishedDate}` : "";
      const isMostRecent = i === 0 && mostRecentMs !== null;
      const recencyFlag = isMostRecent
        ? "\n⭐ MOST RECENT DATED SOURCE — prioritize this source's facts as the current/primary answer for anything time-sensitive."
        : "";
      const domainType = classifyDomain(s.url);
      const typeLine = domainType ? `\nSOURCE TYPE: ${domainType}` : "";
      return `SOURCE ${i + 1}: ${s.url}\nTITLE: ${s.title}${dateLine}${typeLine}${recencyFlag}\nCONTENT:\n${s.content}`;
    })
    .join("\n\n---\n\n");

  let stalenessInstruction = "";
  if (mostRecentMs !== null) {
    const gapDays = daysBetween(Date.now(), mostRecentMs);
    if (gapDays > STALENESS_WARNING_DAYS) {
      stalenessInstruction = `\n\n=== MANDATORY STALENESS DISCLOSURE (computed, not optional) ===\nThe most recent dated source available (SOURCE 1) is ${gapDays} days old relative to TODAY'S DATE. For ANY part of your answer that is time-sensitive (rates, prices, current status, "as of now" claims), you MUST explicitly state that your most recent available source is ${gapDays} days old and that a more current figure may exist which your search did not surface. Do not present SOURCE 1's figures as if they reflect today's exact state — frame them as "the most recent figure available, as of [SOURCE 1's own date]."`;
    }
  } else {
    stalenessInstruction = `\n\n=== MANDATORY STALENESS DISCLOSURE (computed, not optional) ===\nNone of the sources found have a parseable published date. For any time-sensitive part of your answer, you MUST state that recency cannot be confirmed from these sources — do not imply the information is current.`;
  }

  return `TODAY'S DATE: ${currentDateStamp()}\n\n${task}\n\n=== LIVE SOURCE DATA (sorted newest-first; use ONLY this — do not use training knowledge) ===\n\n${sourceBlock}${stalenessInstruction}`;
}

// The grounding/citation rules every grounded agent should include verbatim
// when it decides to search live, numbered 0-6 independently of whatever
// rule numbers precede it in an agent's own system prompt (e.g. research.js
// splices this in after its own rules 1-7) — so citation behavior,
// recency-weighing, and source-type handling stay identical across every
// grounded agent regardless of each agent's own prompt structure.
export const GROUNDED_CITATION_RULES = `GROUNDED-ANSWER RULES (apply whenever LIVE SOURCE DATA is present below) — NEVER VIOLATE:
0. A "TODAY'S DATE" line appears above the task. Treat that as the actual current date, full stop — not your training-data cutoff, not any date you might otherwise assume. Any number, rate, price, status, or fact you recall from training is a snapshot from *before* your cutoff, and today (per the date line) may be much later than that. This means: for the live-data-dependent part of the question, your own recalled figure is not a competing answer to weigh against the sources — it is what you are being asked to replace. If your trained recollection and the LIVE SOURCE DATA disagree on a number, the sources win, always, with no exception. CRITICAL DISTINCTION: TODAY'S DATE tells you what "now" is — it is NOT the date any source's information is from. Never write "as of [TODAY'S DATE]" for a fact that came from a source published earlier than that. If a source is dated April 2025 and TODAY'S DATE is July 2026, that fact is "as of April 2025" (over a year old), not "as of July 2026" — say so explicitly, and note that a newer figure may exist that your sources didn't surface.
1. You MUST answer the live-data-dependent part of the question ONLY using the LIVE SOURCE DATA provided. Do not supplement with your own training knowledge for that part, even to "fill in a detail" or "double check" a source — the source is the only input that counts for that part of the answer.
2. If the live source data doesn't cover some part of the question, explicitly say the live sources found don't cover it — never fill the gap from memory. Critically: "my sources don't mention X" is NOT the same claim as "X doesn't exist" — never upgrade an absence-from-sources into a claim that something doesn't exist, isn't real, or is a mistake on the user's part. Sources can be incomplete, outdated, or simply not have indexed something real yet. State only what the sources do or don't say.
3. When you state a fact drawn from a source, mark it inline with that source's number in brackets, e.g. "the repo rate is 5.25% [2]." Use the same numbering as the SOURCE blocks (SOURCE 1 → [1], SOURCE 2 → [2], etc.) — don't invent your own numbering or renumber sources. If a sentence draws on more than one source, cite all of them: "...as of June 2026 [1][3]." Every non-obvious factual claim from live data should have at least one [N] next to it.
4. Before answering anything time-sensitive (news, prices, rates, policy, "latest"/"current"/"this week"/"today" questions), you MUST first scan every source's PUBLISHED date and identify which source is the MOST RECENT relative to TODAY'S DATE above. Answer using the most recent source's facts as the primary/current answer, and label that fact with ITS OWN published date, not TODAY'S DATE — "the rate was 5.25% as of [source's date] [N]" is correct; "the rate is 5.25% as of [TODAY'S DATE] [N]" is only correct if the source's own date actually IS today or very recent. If the most recent source available is itself old relative to TODAY'S DATE (e.g. over a few months for a fast-moving figure like a policy rate), say plainly that this may no longer be current and a fresher number may exist. Do not present an older source's numbers as "current" just because it appeared first or was the source you read first. If sources disagree because they're from different dates, state the most recent figure as the best available answer and mention the earlier one only as prior history if relevant ("previously X, as of [older date] [N]; more recently Y as of [newer date] [M]"), never blending them into one undated "current" claim. If NO source has a published date at all, say your answer's recency can't be confirmed — don't silently imply it's current. Not every source will have a published date — that's normal, just don't fabricate one, and don't skip the comparison step just because some sources lack one.
5. When a source has a SOURCE TYPE hint (government, academic, wiki, news outlet, etc.), treat it as one weak signal among several, not a verdict — a government/news source isn't automatically correct and a wiki source isn't automatically wrong. But specifically for facts a company/organization would publish about itself (official pricing, product names/tiers, specifications, official statements), prioritize the organization's own official domain over third-party blogs, resellers, or aggregator sites if they conflict — a reseller/partner site can misname a product tier or quote outdated pricing even when well-intentioned. When citing a specific product name, price, or tier, double-check it against the most official-looking source in the set before stating it as fact, and don't blend details from two different products/tiers of the same company into one answer.
6. Before finalizing any live-data figure in your answer, silently check it against the SOURCE blocks above — if you cannot point to which SOURCE N contains that exact figure, do not state it; either find the correct figure in the sources or say the sources don't cover it.`;

/**
 * Runs a live search and returns either a ready-to-use grounded task string
 * (task + formatted SOURCE blocks) or a structured failure the caller can
 * turn into an early return, mirroring how research.js handles blocked/
 * no-data cases. Callers are expected to check `result.ok` first.
 *
 * PHASE 2: now goes through expandedLiveSearch (core/query-expansion.js)
 * instead of calling liveWebSearch directly. For simple/narrow tasks this
 * is IDENTICAL to the old behavior (single query, same liveWebSearch call
 * under the hood) — expandedLiveSearch only takes the multi-query path for
 * tasks its own cheap classification call judges as genuinely broad, and
 * fails back to single-query on any error. ai/model are now required
 * params (previously unused by this function) purely so that
 * classification call can run; agentLabel continues to double as the log
 * label for both this function's own error logging and the expansion
 * module's.
 *
 * On success: { ok: true, groundedTask, sources: [{url, ...}] }
 * On failure: { ok: false, reason: "blocked" | "no_data", message }
 */
export async function runGroundedSearch({ task, searchQuery, agentLabel, ai, model }) {
  let liveResult;
  try {
    liveResult = await expandedLiveSearch({ task, searchQuery, ai, model, agentLabel });
  } catch (e) {
    logger.error(`${agentLabel} agent live search failed`, { error: e.message, query: searchQuery });
    liveResult = { hasLiveData: false, sources: [], attemptedUrls: [], blocked: false };
  }

  if (liveResult.blocked) {
    return {
      ok: false,
      reason: "blocked",
      message: "Live search got rate-limited just now — this can happen with direct scraping. Try again in a bit.",
    };
  }

  if (!liveResult.hasLiveData) {
    return {
      ok: false,
      reason: "no_data",
      message: "I couldn't find live data on this from the web just now, so I won't guess from memory. Try rephrasing the query or a more specific topic, and I'll search again.",
      attemptedCount: liveResult.attemptedUrls.length,
    };
  }

  // CRITICAL: buildGroundedTask sorts sources newest-first internally (see
  // sortSourcesByRecency) before numbering them SOURCE 1, 2, 3... — the
  // model's [N] citations are based on THAT sorted order. If this function
  // returned liveResult.sources in its original (unsorted) order while the
  // prompt used the sorted order, the numbered source list shown to the
  // user (built from this return value via appendSourceList) would silently
  // point at the WRONG sources — [2] in the model's answer would map to a
  // different URL than [2] in the displayed list. Sorting here identically
  // keeps both in lockstep.
  const sortedSources = sortSourcesByRecency(liveResult.sources);

  return {
    ok: true,
    groundedTask: buildGroundedTask(task, sortedSources),
    sources: sortedSources,
  };
}

// Builds the numbered "[1] domain.com" list appended to a grounded
// response's visible text — identical format/behavior to what Research
// does, so [N] in an agent's prose and "[N]" in this list always resolve
// to the same source for the user, regardless of which agent answered.
export function appendSourceList(responseText, sourceUrls) {
  if (!responseText || !sourceUrls || sourceUrls.length === 0) return responseText;

  const sourceList = sourceUrls
    .map((url, i) => {
      try {
        return `[${i + 1}] ${new URL(url).hostname}`;
      } catch {
        return `[${i + 1}] ${url}`;
      }
    })
    .join("\n");

  return `${responseText}\n\nSources:\n${sourceList}`;
}
