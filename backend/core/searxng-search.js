// core/searxng-search.js — SearXNG Metasearch Client
// Aeldorado by Solanacy Technologies
//
// Primary search source. Calls our own self-hosted SearXNG instance
// (see the `solanacy-searxng` repo) instead of scraping Google/DuckDuckGo
// directly from this backend. SearXNG queries multiple upstream engines
// itself (Google, Bing, DuckDuckGo, Brave, Startpage, Wikipedia) and
// aggregates the results, with its own mature bot-avoidance logic (header
// handling, rate limiting, engine rotation) that we don't have to build or
// debug here.
//
// HONEST LIMITS (documented, not hidden):
// - SearXNG still scrapes the same underlying engines under the hood. It
//   reduces the blocking problem through better engineering, it does not
//   make it disappear — individual upstream engines (Brave, Startpage, DDG)
//   can still rate-limit or CAPTCHA-block our SearXNG instance under heavy
//   sustained traffic, same as our own direct scrapers could.
// - This is a single, self-hosted instance with no proxy/IP rotation of its
//   own beyond what SearXNG does internally across engines.
// - If SearXNG returns zero results for a query (rather than an error), we
//   still fall back to the direct-scrape pipeline — SearXNG occasionally
//   comes back empty on a query even when no engine reported blocked.

import { logger } from "./logger.js";

const SEARXNG_BASE_URL = process.env.SEARXNG_BASE_URL || "https://solanacy-searxng.onrender.com";
const FETCH_TIMEOUT_MS = 10000;
const MAX_RESULTS = 8;

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Engines whose results are dictionary/translation/thesaurus lookups rather
// than actual factual/current-event web results. Confirmed root cause of a
// real bug (2026-07): factual queries like "USD to INR exchange rate" and
// "who is the UK Prime Minister" were coming back with responses like "the
// provided source materials were exclusively linguistic in nature" — the
// query URL had no `categories` restriction, so SearXNG's default "general"
// category picked up a dictionary/Wiktionary-style engine alongside real web
// engines, and that engine's word-definition result was sometimes the only
// (or dominant) thing that made it into the response.
//
// Two layers of defense against this, since either one alone can fail:
// 1. Restrict the request itself to categories that are actually useful for
//    factual/current-event research (below).
// 2. Filter by engine name on the response too (DICTIONARY_ENGINE_NAMES),
//    in case a dictionary-type engine is still reachable under a category we
//    do request (e.g. it's tagged "general" AND "translate" simultaneously
//    on this instance's config, and we still legitimately want "general").
// PHASE 2/3 FIX (confirmed via production logs, 2026-07-07): the flat
// "general,news,science" category set was originally added to fix a
// dictionary-engine pollution bug (see comment above), but "science" pulls
// in arxiv/semantic-scholar/pubmed for EVERY query regardless of topic —
// for a business/market-research query ("EV charging infrastructure market
// size", "funding rounds", "competitors"), these engines return academic
// papers that are (a) topically irrelevant to a business question and (b)
// frequently direct PDF links, which core/web-fetcher.js explicitly rejects
// (`Unsupported content-type`) — so these results were silently occupying
// slots in the SearXNG result count while contributing zero fetchable
// content, shrinking the EFFECTIVE source pool for exactly the kind of
// broad business query Phase 2's multi-query expansion targets.
//
// Fix: pick categories based on the query's own content — a cheap keyword
// heuristic, not a model call, since "is this business/market-oriented vs
// scientific/technical" is a coarse enough distinction that pattern-matching
// on the query string is reliable and near-instant, and a wrong category
// pick here only means a slightly-suboptimal-but-still-functional search
// (general/news still cover most things), not the kind of factual error
// that would justify spending a model call and its latency to decide.
const BUSINESS_SIGNAL_WORDS = [
  "market size", "market share", "tam", "sam", "som", "revenue", "funding",
  "valuation", "competitor", "competitors", "pricing", "price of", "startup",
  "company", "companies", "industry", "business", "investment", "investor",
  "acquisition", "merger", "ipo", "stock", "shares", "profit", "earnings",
  "customer", "sales", "growth rate", "cagr", "market trend",
];

const SCIENCE_SIGNAL_WORDS = [
  "study", "research paper", "clinical trial", "peer-reviewed", "journal",
  "hypothesis", "experiment", "medical", "biology", "physics", "chemistry",
  "algorithm", "dataset", "model architecture", "scientific", "academic",
];

/**
 * Picks a SearXNG category string based on the query's own content. Falls
 * back to the original flat set (general,news,science) when the query
 * doesn't clearly lean either way — an ambiguous query is exactly the case
 * where keeping "science" available as a safety net (rather than guessing
 * wrong and excluding it) is the safer default, mirroring how this constant
 * behaved for every query before this fix.
 */
export function selectSearchCategories(query) {
  const q = (query || "").toLowerCase();

  const businessScore = BUSINESS_SIGNAL_WORDS.filter(w => q.includes(w)).length;
  const scienceScore = SCIENCE_SIGNAL_WORDS.filter(w => q.includes(w)).length;

  if (businessScore > 0 && scienceScore === 0) {
    // Clear business signal, no science signal — drop "science" category
    // entirely so arxiv/semantic-scholar/pubmed don't compete for result
    // slots on a query they can't usefully answer.
    return "general,news";
  }

  // Ambiguous, science-leaning, or no signal at all — keep the original
  // full set so genuinely scientific/technical queries (and anything this
  // heuristic doesn't recognize) are unaffected.
  return "general,news,science";
}

const DICTIONARY_ENGINE_NAMES = [
  "wiktionary",
  "dictionary",
  "translate",
  "translated",
  "wordnet",
];

function isDictionaryResult(result) {
  const engineName = (result.engine || "").toLowerCase();
  if (DICTIONARY_ENGINE_NAMES.some((name) => engineName.includes(name))) {
    return true;
  }
  // Defense in depth: some dictionary engines don't cleanly report their
  // own name in the `engine` field depending on SearXNG version/config.
  // A result whose URL host is a known dictionary/reference site is the
  // same signal by a different route.
  try {
    const host = new URL(result.url).hostname.toLowerCase();
    if (host.includes("wiktionary.org") || host.includes("dictionary.com") || host.includes("thesaurus.com")) {
      return true;
    }
  } catch {
    // Malformed URL — let the existing `r.url && r.title` filter below handle it.
  }
  return false;
}

/**
 * Search via our self-hosted SearXNG instance and return parsed organic
 * result links + snippets, in the same shape as googleSearch()/
 * duckDuckGoSearch(): { success, blocked, error, results: [{ url, title, snippet }] }.
 * Always resolves (never throws) — failures return { success: false, error }
 * so callers (live-search.js) can fall back to direct scraping.
 *
 * @param {string} query
 * @param {string|null} [timeRange] - SearXNG's time_range param: "day",
 *   "week", "month", or "year". Optional and defaulting to unset (existing
 *   behavior, unchanged) — only passed by callers that have already
 *   decided a query needs recency-biased results (e.g. "is this law still
 *   current"). This biases upstream engines' own ranking toward newer
 *   results where they support it; it does not hard-exclude older pages,
 *   so an evergreen/definitional query asking for it by mistake wouldn't
 *   suddenly come back empty — it would just rank recent pages higher.
 */
export async function searxngSearch(query, timeRange = null) {
  const categories = selectSearchCategories(query);
  if (categories !== "general,news,science") {
    logger.info("SearXNG search: category narrowed by query-type heuristic", { query, categories });
  }
  let url = `${SEARXNG_BASE_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=${encodeURIComponent(categories)}`;
  if (timeRange) {
    url += `&time_range=${encodeURIComponent(timeRange)}`;
  }

  try {
    const res = await fetchWithTimeout(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      FETCH_TIMEOUT_MS
    );

    if (!res.ok) {
      // Our own SearXNG instance rate-limiting/erroring us is a "blocked"
      // condition worth logging distinctly from upstream-engine failures,
      // since it points at our own instance/limiter config rather than a
      // specific search engine.
      logger.warn("SearXNG search non-OK response", { status: res.status, query });
      return { success: false, blocked: res.status === 429, error: `HTTP ${res.status}`, results: [] };
    }

    const data = await res.json();

    const rawResults = data.results || [];
    const dictionaryFiltered = rawResults.filter(isDictionaryResult);
    if (dictionaryFiltered.length > 0) {
      logger.warn("SearXNG search: filtered out dictionary/translation-engine results", {
        query,
        filteredCount: dictionaryFiltered.length,
        filteredEngines: [...new Set(dictionaryFiltered.map(r => r.engine || "unknown"))],
      });
    }

    const results = rawResults
      .filter(r => r.url && r.title)
      .filter(r => !isDictionaryResult(r))
      .slice(0, MAX_RESULTS)
      .map(r => ({ url: r.url, title: r.title, snippet: r.content || "", publishedDate: r.publishedDate || null }));

    // Per-engine result counts, built from the full (unsliced) result set.
    // This catches cases unresponsive_engines does NOT: an engine that
    // returns zero results silently (no timeout, no block reported) rather
    // than actually contributing to the response. This caught Google doing
    // exactly this on a couple of test queries (leading to it being briefly
    // disabled, then re-enabled once a real query showed the opposite
    // problem — Google missing entirely left a real coverage gap on
    // niche/technical topics). Keeping this breakdown so any engine's
    // result contribution (or lack of it) stays visible without needing a
    // manual direct curl against the instance.
    const engineCounts = {};
    for (const r of (data.results || [])) {
      const engineName = r.engine || "unknown";
      engineCounts[engineName] = (engineCounts[engineName] || 0) + 1;
    }

    if (results.length === 0) {
      logger.warn("SearXNG search: zero results parsed", {
        query,
        unresponsiveEngines: data.unresponsive_engines || [],
      });
    } else {
      // Always log the per-engine breakdown at info level for visibility,
      // regardless of whether any engine was reported unresponsive — a
      // silent-zero engine wouldn't show up in unresponsiveEngines at all.
      logger.info("SearXNG search: engine result breakdown", {
        query,
        engineCounts,
        unresponsiveEngines: data.unresponsive_engines || [],
      });

      if (data.unresponsive_engines && data.unresponsive_engines.length > 0) {
        // Non-fatal: some upstream engines failed but SearXNG still returned
        // usable results from the others. Worth logging for visibility into
        // which engines are currently unreliable, not worth failing the call.
        logger.warn("SearXNG search: some engines unresponsive, others succeeded", {
          query,
          unresponsiveEngines: data.unresponsive_engines,
        });
      }
    }

    return { success: true, blocked: false, results };
  } catch (e) {
    logger.error("SearXNG search fetch failed", { error: e.message, query });
    return { success: false, blocked: false, error: e.name === "AbortError" ? "Timeout" : e.message, results: [] };
  }
}
