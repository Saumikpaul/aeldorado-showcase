// core/query-expansion.js — Multi-Query Search Expansion
// Aeldorado by Solanacy Technologies
//
// PHASE 2 of the Research agent power-up plan: a single search query is
// often too narrow for a genuinely broad research task (e.g. "TAM for
// electric scooters in India" really needs market-size data, competitor
// pricing, AND recent funding/policy news — three different searches, not
// one). This module decides whether a task needs more than one search
// angle and, if so, proposes focused sub-queries, then runs them in
// parallel and merges the results into one deduplicated source pool.
//
// Design goals (matching claim-verification.js's approach):
//   1. GENERIC — takes { task, searchQuery, ai, model, agentLabel } only.
//      No agent-specific logic, reusable by CFO/Sales/Legal/Marketing once
//      they adopt live search the same way Research does.
//   2. MODEL-DEPENDENCE MINIMIZED — exactly ONE classification/expansion
//      call decides everything (whether to expand + what the sub-queries
//      are), not a chain of calls. Simple/narrow questions take the
//      existing single-query path unchanged — this only adds cost/latency
//      for genuinely broad tasks.
//   3. FAILS SAFE — if the expansion call fails or returns garbage, falls
//      straight back to single-query search with the original searchQuery.
//      Never blocks or breaks the answer.

import { liveWebSearch, metaSearchOnlySearch } from "./live-search.js";
import { generateWithFallback } from "./retry.js";
import { safeExtractJSON } from "./json-utils.js";
import { getModelList } from "../agents/agent-utils.js";
import { logger } from "./logger.js";

// LOAD-REDUCTION FIX (2026-07-07, confirmed via production logs): our
// self-hosted metasearch instance visibly struggles under concurrent multi-
// query load — logs showed most secondary engines (Brave, DuckDuckGo,
// Startpage, Wikipedia, Google Scholar) returning "too many requests" or
// CAPTCHA-suspended on nearly every call once 3+ sub-queries ran in
// parallel, each itself falling through a 3-engine (metasearch engine->Google->DDG)
// chain on failure. Worst case: 1 user question could trigger up to
// MAX_SUBQUERIES x 3 = 12 external search attempts. Capping at 2 sub-queries
// halves that worst case and keeps concurrent metasearch load within what a
// single free/self-hosted instance can actually sustain, while still
// covering "genuinely two angles" tasks (the common case per EXPANSION_SYSTEM
// below) — a task needing true 3-4-way breadth is rare enough that losing it
// is a better trade than routinely starving the metasearch instance.
const MAX_SUBQUERIES = 2;

// Caps total merged sources across all sub-queries before they're sent to
// the model — keeps a single generation call's context bounded regardless
// of how many sub-queries ran or how many results each contributed.
const MAX_MERGED_SOURCES = 10;

const EXPANSION_SYSTEM = `You decide whether a research task is broad enough to need MULTIPLE distinct search queries to answer well, or whether one search is enough.

A task needs multiple queries when it has genuinely separate angles that a single search string would not surface together — for example "market size for X" (needs: market size reports/data AND recent industry news AND possibly regulatory context), or "compare pricing of X and Y" (needs: X's pricing page/info AND Y's pricing page/info as separate searches, since one combined query tends to surface only one of them well).

A task does NOT need multiple queries when it's a single direct factual question ("what is the current repo rate", "who is the CEO of X", "latest news on Y") — one focused search covers it, and splitting it would just waste calls on redundant/overlapping searches.

If multiple queries are warranted, propose exactly ${MAX_SUBQUERIES} SHORT, DISTINCT search queries (each 3-8 words, like something you'd actually type into a search engine — not a full sentence) that together cover the task's most important angles. Pick the ${MAX_SUBQUERIES} angles that matter most if the task has more than that — don't propose near-duplicate queries that would return overlapping results.

Either way, ALSO provide "tightenedQuery": a single short search-engine-style query (3-8 words, keyword-dense, no filler words like "current"/"please"/"can you tell me") that best captures the task's single core topic if it had to be searched with just one query. This is used whenever needsExpansion is false, since long natural-language questions dilute keyword relevance on real search engines — a search engine matches "B2B SaaS pricing benchmarks India" far better than the full sentence "what are the current market pricing benchmarks for similar B2B SaaS tools in India". Avoid generic words that collide with unrelated topics (e.g. avoid the bare word "current" when you mean "current/recent data" — say "latest" or "2026" or drop it and rely on other keywords instead, since "current" alone has matched physics/dictionary/brand-name pages in past testing here).

Respond with ONLY a JSON object, nothing else:
{"needsExpansion": true|false, "queries": ["query 1", "query 2", ...], "tightenedQuery": "short query"}

If needsExpansion is false, "queries" should be an empty array, but "tightenedQuery" must still be provided.`;

/**
 * Decides whether `task` needs multi-query search and, if so, what the
 * sub-queries should be. Fails safe: any error returns
 * { needsExpansion: false, queries: [] }, so the caller's fallback to
 * single-query search is always the safe default.
 */
async function planQueries({ task, ai, model }) {
  try {
    const models = getModelList(ai, model);
    const response = await generateWithFallback(ai, {
      models,
      config: { systemInstruction: EXPANSION_SYSTEM, temperature: 0.2, maxOutputTokens: 512 },
      contents: task,
      label: "QUERY_EXPANSION",
      jsonMode: true,
    });

    const parsed = safeExtractJSON(response.text, { needsExpansion: false, queries: [], tightenedQuery: "" });

    // tightenedQuery fails safe to "" (falsy) here — callers must treat an
    // empty string as "no tightened query available" and fall back to
    // their own original searchQuery, never assume this is always populated.
    const tightenedQuery = typeof parsed.tightenedQuery === "string" ? parsed.tightenedQuery.trim() : "";

    if (!parsed.needsExpansion || !Array.isArray(parsed.queries) || parsed.queries.length === 0) {
      return { needsExpansion: false, queries: [], tightenedQuery };
    }

    // Defensive trim: even though the prompt caps at MAX_SUBQUERIES, never
    // trust a model to actually respect a stated limit — enforce it here.
    const queries = parsed.queries
      .filter(q => typeof q === "string" && q.trim().length > 0)
      .slice(0, MAX_SUBQUERIES);

    return { needsExpansion: queries.length > 0, queries, tightenedQuery };
  } catch (e) {
    logger.warn("Query expansion planning failed, falling back to single query", { error: e.message });
    return { needsExpansion: false, queries: [], tightenedQuery: "" };
  }
}

/**
 * Deduplicates a merged source array by URL, keeping the first occurrence
 * (earlier sub-queries run first in the array, so earlier = higher
 * priority in case of any ordering-dependent behavior downstream).
 */
function dedupeSourcesByUrl(sources) {
  const seen = new Set();
  const deduped = [];
  for (const s of sources) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    deduped.push(s);
  }
  return deduped;
}

/**
 * Interleaves multiple per-query source arrays round-robin style (one from
 * query 1, one from query 2, one from query 3, back to query 1, ...) rather
 * than concatenating them end-to-end. This matters once MAX_MERGED_SOURCES
 * caps the total: a naive concatenation-then-slice would let an early
 * sub-query's results fill the entire cap and silently starve every later
 * sub-query of any representation at all, defeating the actual point of
 * asking multiple distinct questions in the first place.
 */
function interleaveSourceLists(sourceLists) {
  const interleaved = [];
  const maxLen = Math.max(0, ...sourceLists.map(l => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of sourceLists) {
      if (list[i]) interleaved.push(list[i]);
    }
  }
  return interleaved;
}

/**
 * Runs either a single search (existing behavior, unchanged) or, for
 * genuinely broad tasks, multiple parallel searches merged into one
 * deduplicated source pool.
 *
 * Returns the same shape liveWebSearch does: { hasLiveData, sources,
 * attemptedUrls, blocked, engine } — so this is a drop-in replacement for
 * a liveWebSearch call in runGroundedSearch, not a parallel code path
 * callers need to special-case.
 *
 * @param {object} params
 * @param {string} params.task - Full task context, used only for the
 *   expansion-planning call (needs task context to judge breadth).
 * @param {string} params.searchQuery - The clean query for single-search
 *   fallback (same value research.js already computes from rawMessage).
 * @param {object} params.ai
 * @param {string} [params.model]
 * @param {string} [params.agentLabel]
 */
// LOAD-REDUCTION FIX (2026-07-07): lowered from 15s. Production logs show
// a fully-failing sub-query (metasearch engine timeout -> Google CAPTCHA-block ->
// DuckDuckGo timeout) taking 20-25s end to end even before this outer
// timeout fires — so 15s wasn't actually preventing the slow-failure case
// it was meant to cap, it wasn't fully waiting either. Since a slow sub-
// query is dead weight regardless of the outer cap's exact value, cutting
// to 10s shaves latency off the common case (one bad sub-query dragging on
// a mostly-successful multi-query call) without meaningfully changing which
// sub-queries actually succeed — most successful searches resolve well
// under 10s per the "engine result breakdown" log timings observed.
const SUBQUERY_TIMEOUT_MS = 10000;

function withTimeout(promise, timeoutMs, fallbackValue) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), timeoutMs)),
  ]);
}

const EMPTY_SEARCH_RESULT = { hasLiveData: false, sources: [], attemptedUrls: [], blocked: false, engine: "timeout" };

// REVERTED (2026-07-07): time_range=year bias was tried here for
// "is this still current" queries, but confirmed live to backfire — on a
// legal query it pulled in generic recent NEWS (yahoo.com, aol.com,
// nypost.com, reason.com) ahead of on-topic-but-not-dated legal sites,
// because recency bias alone has no topic constraint. Replaced below with
// a narrower, safer fix: for the Legal agent specifically, nudge the query
// toward known-good Indian legal sites via the metasearch engine's site: OR-group syntax,
// rather than biasing all results by date regardless of topic.
// Site list deliberately avoids government domains (e.g. indiacode.gov.in)
// despite being the most "authoritative" on paper — .gov.in sites are
// commonly slow, occasionally down, and more prone to bot-blocking/CAPTCHA
// than commercial legal-content sites, which directly works against the
// actual goal here (fresh, scrapable, low block-rate). These are all
// lightweight, frequently-updated, HTML-based Indian legal reference/news
// sites that the metasearch engine can reliably fetch:
const LEGAL_SITE_FOCUS = "(site:devgan.in OR site:indiankanoon.org OR site:scconline.com OR site:lawrato.com OR site:vakeel360.com OR site:barandbench.com OR site:livelaw.in)";

// Same reasoning as LEGAL_SITE_FOCUS, applied to Research: confirmed via
// live testing that a plain business/market query with no domain focus at
// all can return irrelevant sources (US local newspapers, insurance
// company sites) instead of business/market-research content. These are
// general business/market/finance sites, not India-only like Legal's list,
// since Research fields much broader topics than Legal does. Deliberately
// excludes government/official-statistics domains (e.g. mospi.gov.in) for
// the same reason as Legal's list — more prone to slow responses/bot-
// blocking than commercial sites, working against fresh+scrapable results.
//
// EXPANDED (2026-07-07): the original 7-domain list correctly killed junk
// sources but was too narrow for niche/vertical topics (e.g. SaaS pricing
// benchmarks specifically) — confirmed live, a query for B2B SaaS pricing
// benchmarks returned only tangentially-related content from these general
// finance-news sites, not the actual benchmark data. Verified via direct
// web search which sites carry that kind of specialized, frequently-
// updated content before adding them — deliberately EXCLUDED several
// results that looked relevant on the surface but turned out to be
// self-promotional agency/lead-gen SEO content (growthspreeofficial.com,
// cookleads.com) rather than genuine primary research, since adding those
// would reintroduce exactly the "confidently-stated but non-authoritative"
// problem this whole session has been fixing. Added only sources with a
// real claimed research methodology (client-engagement data, annual
// surveys, analyst interviews) or being a well-known dedicated SaaS
// benchmarking firm:
//   - upgrowth.in: India-focused SaaS GTM/pricing consultancy, publishes
//     benchmarks from its own client-engagement data specifically
//     calibrated to Indian market dynamics (the exact niche gap found)
//   - benchmarkit.ai, saas-capital.com: established, dedicated SaaS
//     benchmarking research firms running real annual surveys, not
//     agency content marketing
//   - mordorintelligence.com: established market-research/analyst firm,
//     cites real underlying methodology (interviews, government stats)
const RESEARCH_SITE_FOCUS = "(site:economictimes.indiatimes.com OR site:moneycontrol.com OR site:livemint.com OR site:business-standard.com OR site:reuters.com OR site:bloomberg.com OR site:statista.com OR site:upgrowth.in OR site:benchmarkit.ai OR site:saas-capital.com OR site:mordorintelligence.com)";

function isLegalAgent(agentLabel) {
  return (agentLabel || "").toLowerCase() === "legal";
}

function isResearchAgent(agentLabel) {
  return (agentLabel || "").toLowerCase() === "research";
}

export async function expandedLiveSearch({ task, searchQuery, ai, model, agentLabel = "Agent" }) {
  const plan = await planQueries({ task, ai, model });

  // Multiple sites via OR inside one site: group is standard metasearch-engine/
  // upstream-engine syntax — this narrows results toward known-authoritative
  // sources without hard-excluding everything else (if none of the listed
  // sites return anything, the metasearch engine still returns whatever else matched the
  // rest of the query terms; it isn't a hard site:-only restriction since
  // the OR group is additive to the query, not a replacement for it).
  // Only one focus applies at a time (an agent is either Legal or Research,
  // never both), so order between the two checks doesn't matter.
  const focusedQuery = q => {
    if (isLegalAgent(agentLabel)) return `${q} ${LEGAL_SITE_FOCUS}`;
    if (isResearchAgent(agentLabel)) return `${q} ${RESEARCH_SITE_FOCUS}`;
    return q;
  };

  if (!plan.needsExpansion) {
    // QUERY-TIGHTENING FIX (2026-07-07): confirmed via live testing that a
    // long natural-language searchQuery (e.g. a full sentence the user
    // typed) sent to the metasearch engine as-is returns weaker/more irrelevant results
    // than a short keyword-dense query on the exact same topic — the
    // EXPANSION_SYSTEM prompt already produces tight 3-8 word queries for
    // the needsExpansion=true branch, but the false branch previously fell
    // straight through to the raw, untightened searchQuery with no
    // refinement step at all. plan.tightenedQuery reuses the same single
    // model call above (no added latency/cost) — falls back to the
    // original searchQuery whenever tightenedQuery is empty (model omitted
    // it, or the whole planQueries call failed and fell back safely).
    const effectiveQuery = plan.tightenedQuery || searchQuery;
    return liveWebSearch({ query: focusedQuery(effectiveQuery) });
  }

  logger.info(`${agentLabel} agent: multi-query search expansion`, { subQueries: plan.queries });

  // LOAD-REDUCTION FIX (2026-07-07): sub-queries use metaSearchOnlySearch, not
  // liveWebSearch's full metasearch-engine->Google->DuckDuckGo fallback chain. Running
  // N sub-queries in parallel, each independently retrying through all 3
  // engines on failure, is what pushed a single research question to up to
  // MAX_SUBQUERIES x 3 external search attempts and made one slow/failing
  // sub-query take 20+ seconds even after this file's own SUBQUERY_TIMEOUT_MS
  // fires. Redundancy already exists at the sub-query level (2 independent
  // angles); adding a full 3-engine retry chain to EACH one compounds load
  // without a proportional accuracy gain. If the metasearch engine alone comes back empty
  // for a given sub-query, that sub-query simply contributes zero sources —
  // the other sub-quer(y/ies) and the interleave/merge step below absorb it.
  const results = await Promise.allSettled(
    plan.queries.map(q => withTimeout(metaSearchOnlySearch({ query: focusedQuery(q) }), SUBQUERY_TIMEOUT_MS, EMPTY_SEARCH_RESULT))
  );

  const perQuerySourceLists = [];
  const allAttemptedUrls = [];
  let anyBlocked = false;
  const engines = new Set();

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const val = r.value;
    if (val.blocked) anyBlocked = true;
    if (val.engine && val.engine !== "timeout") engines.add(val.engine);
    perQuerySourceLists.push(val.sources || []);
    allAttemptedUrls.push(...(val.attemptedUrls || []));
  }

  // Interleave round-robin across sub-queries BEFORE dedup and BEFORE the
  // cap, so every sub-query gets fair representation in the final pool
  // rather than an early, prolific sub-query silently crowding out the
  // others once MAX_MERGED_SOURCES is applied.
  const interleaved = interleaveSourceLists(perQuerySourceLists);
  let dedupedSources = dedupeSourcesByUrl(interleaved).slice(0, MAX_MERGED_SOURCES);

  // SAFETY NET (2026-07-07): sub-queries deliberately skip the Google/DDG
  // fallback chain (see metaSearchOnlySearch above) to reduce load — but that
  // means if the metasearch instance itself is briefly down/timing out, ALL sub-queries
  // come back empty with zero fallback attempted at all, which is worse
  // than the pre-multi-query single-search behavior. Rather than surfacing
  // "no live data" in that case, fall back once to the ORIGINAL single
  // searchQuery through the full liveWebSearch chain (metasearch engine->Google->DDG)
  // — one full-chain attempt, not per sub-query, so this only adds load in
  // the specific case where the lighter path already came back with
  // nothing to lose.
  if (dedupedSources.length === 0) {
    logger.warn(`${agentLabel} agent: all sub-queries returned empty, falling back to single full-chain search`, {
      subQueries: plan.queries, searchQuery,
    });
    const fallbackResult = await liveWebSearch({ query: focusedQuery(plan.tightenedQuery || searchQuery) });
    if (fallbackResult.hasLiveData) {
      return { ...fallbackResult, expandedQueries: plan.queries };
    }
    dedupedSources = fallbackResult.sources || [];
  }

  // VISIBILITY FIX (found via live MCP test, 2026-07-07): previously there
  // was no log line at all connecting "these sub-queries ran" to "here's
  // the final merged source count" — a real production case showed all 3
  // sub-queries individually returning real metasearch results, then total
  // silence, then a "no live data found" answer, with no way to tell from
  // logs alone whether the problem was the search stage, the fetch stage,
  // or the merge stage. This makes the merge outcome explicit regardless of
  // whether it succeeded or came back empty.
  logger.info(`${agentLabel} agent: multi-query search merge result`, {
    subQueries: plan.queries,
    perQueryContribution: plan.queries.map((q, i) => ({ query: q, sourcesFound: (perQuerySourceLists[i] || []).length })),
    mergedBeforeCap: interleaved.length,
    mergedAfterDedupeCap: dedupedSources.length,
  });

  // A multi-query expansion should only be reported as "blocked" if EVERY
  // sub-query came back blocked with zero usable sources overall — a
  // partial block (2 of 3 sub-queries blocked, 1 succeeded) still leaves
  // real live data to answer with, so it isn't the same failure mode as a
  // full block and shouldn't be reported as one.
  const fullyBlocked = anyBlocked && dedupedSources.length === 0;

  return {
    hasLiveData: dedupedSources.length > 0,
    sources: dedupedSources,
    attemptedUrls: allAttemptedUrls,
    blocked: fullyBlocked,
    engine: [...engines].join("+") || "none",
    expandedQueries: plan.queries, // surfaced for methodology/transparency, not required by callers
  };
}
