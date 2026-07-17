// core/live-search.js — Live Web Search Pipeline
// Aeldorado by Solanacy Technologies
//
// Single entry point agents call to get live web data for a query.
// Pipeline: query our self-hosted metasearch instance first (aggregates Google,
// Bing, DuckDuckGo, Brave, Startpage with its own bot-avoidance logic) ->
// if the metasearch instance itself is unreachable/blocked/empty, fall back to scraping
// Google directly -> if that's blocked too, fall back to scraping
// DuckDuckGo directly -> fetch + extract each result page.
// No Serper/Tavily/Brave/Bing or any external SEARCH API is paid for or
// required anywhere here — the metasearch engine is self-hosted, and the direct scrapers
// remain as a last-resort fallback if our own metasearch instance is down.

import { metaSearchQuery }  from "./meta-search.js";
import { googleSearch }     from "./google-search.js";
import { duckDuckGoSearch } from "./duckduckgo-search.js";
import { fetchMultiple }    from "./web-fetcher.js";
import { logger } from "./logger.js";

// PHASE 2 — generic irrelevant-domain filter, applied uniformly to results
// from ALL THREE engines (our metasearch engine, Google, DuckDuckGo) at one shared choke
// point, rather than duplicating a filter inside each engine-specific file.
//
// Root cause this addresses (confirmed in production logs, 2026-07): a
// factual query like "current RBI repo rate" returned real, correct
// results ALONGSIDE completely irrelevant ones — dictionary.cambridge.org,
// play.google.com, www.iciba.com — because the metasearch engine's own
// isDictionaryResult() filter (meta-search.js) only catches a narrow
// hostname list (dictionary.com, thesaurus.com, wiktionary.org) and has no
// concept of "app store" or "translation portal" domains at all, and
// Google/DuckDuckGo direct-scrape have no such filter whatsoever.
//
// This is intentionally NOT a"trustworthiness" ranking (that's a much
// bigger, fuzzier claim — see classifyDomain() in grounded-search.js for
// the existing lightweight source-type hint, which is a different, narrower
// concept). This is strictly: "is this domain's content TYPE structurally
// incapable of answering a research/factual query" — dictionaries, app
// stores, and generic word-lookup sites fall in that bucket regardless of
// which specific query brought them up.
//
// Deliberately a plain hostname substring list, not a model call — the
// judgment here ("is this a dictionary/app-store domain") doesn't vary by
// query context, so paying for an LLM call to re-derive it every time would
// be pure waste. Kept here (not per-engine) so every engine benefits and a
// future 4th engine gets it for free too.
const IRRELEVANT_DOMAIN_SUBSTRINGS = [
  // Dictionary / translation / word-lookup — content is definitional, not
  // factual/current-event, no matter what the query is about.
  "dictionary.cambridge.org", "dictionary.com", "thesaurus.com",
  "wiktionary.org", "wordnet", "iciba.com", "youdao.com", "bab.la",
  "reverso.net", "linguee.com", "collinsdictionary.com", "merriam-webster.com",
  // App stores / software marketplaces — never a source for a factual
  // research claim, regardless of query topic.
  "play.google.com", "apps.apple.com", "apkpure.com", "apkmirror.com",
  "chrome.google.com/webstore", "microsoft.com/store",
  // Generic low-signal aggregators/spam patterns that show up across
  // unrelated queries with no real content of their own.
  "pinterest.com", "quora.com/unanswered",
  // CONFIRMED VIA LIVE TEST (2026-07-07): a query containing the word
  // "direct" (e.g. "direct competitors to X") surfaced directv.com,
  // directauto.com, and directvonline.com as results — these are unrelated
  // US satellite-TV/insurance brands that appear to match on the literal
  // substring "direct" in a weaker upstream engine's keyword search, not on
  // topical relevance. Same failure shape as the dictionary-domain problem
  // (a generic word in the query pulling in a same-named but unrelated
  // brand/site) — blocklisted here rather than left to recur on any future
  // query using the word "direct". If similar unrelated-brand-name
  // collisions turn up for other common words, add them here following the
  // same pattern rather than trying to build a general solution — this is
  // a known-junk list, not a relevance classifier.
  "directv.com", "directauto.com", "directvonline.com",
  // CONFIRMED VIA LIVE TEST (2026-07-07): a legal query containing common
  // words like "section", "IPC", "current", "trust" surfaced grammar/
  // word-explanation sites (grammarlearns.com, writingexplained.org,
  // wiserread.com, langeek.co) and unrelated brand domains (current.com,
  // a banking app; www.airtel.in, a telecom company) instead of legal
  // sources — same substring-collision shape as the directv/dictionary
  // cases above, just triggered by different common words this time. Also
  // caused a real accuracy regression: the Legal agent's grounded answer
  // on an IPC-406-to-BNS-316 question was WORSE than its own ungrounded
  // answer, because it trusted these junk "sources" over its own correct
  // training knowledge that the IPC was replaced by the BNS on 2024-07-01.
  "grammarlearns.com", "writingexplained.org", "wiserread.com", "langeek.co",
  "current.com", "www.airtel.in", "airtel.in",
];

/**
 * True if a result's URL points at a domain that is structurally incapable
 * of contributing a factual/research claim (dictionaries, app stores, etc.)
 * — independent of query topic. Fails open (returns false / "keep it") on
 * a malformed URL, since a filter erring toward exclusion on bad input
 * would silently shrink the source pool for no good reason.
 */
export function isIrrelevantDomain(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return IRRELEVANT_DOMAIN_SUBSTRINGS.some(pattern => host.includes(pattern) || url.toLowerCase().includes(pattern));
}

/**
 * Filters a raw engine result list (shape: [{url, title, snippet, ...}])
 * down to ones worth fetching, logging what got dropped for visibility —
 * mirrors the logging style already established in meta-search.js's own
 * isDictionaryResult filtering, so both filters are equally observable in
 * production logs.
 */
function filterIrrelevantResults(results, engine, query) {
  const kept = [];
  const dropped = [];
  for (const r of results) {
    if (isIrrelevantDomain(r.url)) {
      dropped.push(r.url);
    } else {
      kept.push(r);
    }
  }
  if (dropped.length > 0) {
    logger.warn("Live search: filtered out structurally-irrelevant domains", { engine, query, droppedCount: dropped.length, dropped });
  }
  return kept;
}

function buildLiveResult({ sources, candidateUrls, blocked, engine }) {
  return { hasLiveData: sources.length > 0, sources, attemptedUrls: candidateUrls, blocked, engine };
}

async function fetchSourcesFromResults(searchResult, engine, query) {
  const relevantResults = filterIrrelevantResults(searchResult.results, engine, query);
  const candidateUrls = relevantResults.map(r => r.url);

  if (candidateUrls.length === 0) {
    // Every result from this engine got filtered out as structurally
    // irrelevant (already logged by filterIrrelevantResults above) — worth
    // a distinct log here since this is a DIFFERENT failure mode from "no
    // fetchable content" below: here, the search itself found nothing
    // usable in principle, before a single network fetch was attempted.
    logger.warn("Live search: zero candidate URLs after relevance filtering, nothing to fetch", { engine, query });
    return buildLiveResult({ sources: [], candidateUrls: [], blocked: false, engine });
  }

  const fetchResults = await fetchMultiple(candidateUrls, 5);

  // publishedDate comes from the search engine's own metadata (the metasearch engine
  // passes this through from upstream engines where available), not from
  // web-fetcher.js's page-fetch — that only extracts body text, it doesn't
  // parse a page's structured data for a publish date. Building a lookup
  // here so we can attach it to fetched sources without changing
  // web-fetcher.js's own contract.
  const publishedDateByUrl = new Map(
    relevantResults.map(r => [r.url, r.publishedDate || null])
  );

  const sources = fetchResults
    .filter(r => r.success)
    .map(r => ({ ...r, publishedDate: publishedDateByUrl.get(r.url) || null }));

  // If a page's own content couldn't be extracted (e.g. JS-heavy site), fall
  // back to the search engine's own snippet for that URL rather than
  // dropping it entirely — a snippet is thin, but still real live data.
  if (sources.length === 0) {
    // CRITICAL VISIBILITY FIX (found via live MCP test, 2026-07-07): this
    // branch — every one of N candidate URLs failed to fetch usable content
    // — previously had ZERO logging. A real production case hit exactly
    // this: the metasearch engine returned real results for all 3 sub-queries (confirmed
    // via the "engine result breakdown" logs), yet the final answer was
    // "no live data found", with literally nothing in the logs between the
    // last search-results log and the next unrelated request — this is
    // that missing link. Logging WHY each candidate failed (not just that
    // it did) so the actual cause — blocked/paywalled sites, non-HTML
    // content-type, JS-rendered pages with no server-side content — is
    // visible without needing to reproduce the failure again.
    logger.warn("Live search: all candidate URLs failed content extraction", {
      engine,
      query,
      candidateCount: candidateUrls.length,
      failures: fetchResults.map(r => ({ url: r.url, error: r.error })),
    });

    const snippetFallback = relevantResults
      .filter(r => r.snippet && r.snippet.length > 30)
      .map(r => ({ url: r.url, title: r.title, content: r.snippet, success: true, fetchedAt: new Date().toISOString(), fromSnippet: true, publishedDate: r.publishedDate || null }));

    if (snippetFallback.length === 0) {
      logger.error("Live search: snippet fallback also empty, this engine contributes zero sources", {
        engine, query, candidateCount: candidateUrls.length,
      });
    } else {
      logger.info("Live search: falling back to search-engine snippets", {
        engine, query, snippetCount: snippetFallback.length,
      });
    }

    return buildLiveResult({ sources: snippetFallback, candidateUrls, blocked: false, engine });
  }

  return buildLiveResult({ sources, candidateUrls, blocked: false, engine });
}

/**
 * Meta-search-only variant of the search pipeline, with no Google/DuckDuckGo
 * fallback chain. Used specifically for multi-query sub-queries (see
 * core/query-expansion.js): when running 2+ sub-queries in parallel, each
 * one falling all the way through the metasearch engine -> Google -> DuckDuckGo on
 * failure multiplies external request load for comparatively little
 * benefit — the OTHER sub-queries already provide redundancy at the
 * "which angle got covered" level, so a single sub-query's own 3-engine
 * exhaustive retry isn't worth its added latency/load in this context.
 * Single-query callers (the common case, most agent calls) keep using
 * liveWebSearch's full fallback chain unchanged — this is additive, not
 * a replacement.
 */
export async function metaSearchOnlySearch({ query, timeRange = null }) {
  const metaResult = await metaSearchQuery(query, timeRange);

  if (metaResult.success && !metaResult.blocked && metaResult.results.length > 0) {
    return fetchSourcesFromResults(metaResult, "meta-search", query);
  }

  logger.warn("Live search (Meta-search-only, sub-query mode): no usable results, not falling back further", {
    query, blocked: metaResult.blocked || false, error: metaResult.error,
  });

  return buildLiveResult({ sources: [], candidateUrls: [], blocked: metaResult.blocked || false, engine: "none" });
}

/**
 * Run the full live search pipeline for a query.
 *
 * @param {object} params
 * @param {string} params.query - The user/task query to find live data for.
 * @param {string|null} [params.timeRange] - Optional metasearch time_range
 *   ("day"|"week"|"month"|"year"), applied only to the metasearch leg of this
 *   pipeline — the Google/DuckDuckGo direct-scrape fallbacks below have no
 *   equivalent param, so a caller relying on time-biased results should
 *   expect that bias to weaken if the metasearch instance itself is unavailable and this
 *   falls through to a fallback engine. Defaults to null (existing
 *   behavior, unchanged) for every caller that doesn't pass it.
 * @returns {Promise<{ hasLiveData: boolean, sources: Array, attemptedUrls: Array, blocked: boolean, engine: string }>}
 */
export async function liveWebSearch({ query, timeRange = null }) {
  // ── Primary: self-hosted metasearch engine ──────────────────────────────────────
  const metaResult = await metaSearchQuery(query, timeRange);

  if (metaResult.success && !metaResult.blocked && metaResult.results.length > 0) {
    return fetchSourcesFromResults(metaResult, "meta-search", query);
  }

  if (metaResult.blocked) {
    logger.warn("Live search: Meta-search engine blocked/rate-limited, falling back to direct Google scrape", { query });
  } else {
    logger.warn("Live search: no meta-search results, falling back to direct Google scrape", { query, error: metaResult.error });
  }

  // ── Fallback: direct Google scrape ────────────────────────────────────
  const googleResult = await googleSearch(query);

  if (!googleResult.blocked && googleResult.success && googleResult.results.length > 0) {
    return fetchSourcesFromResults(googleResult, "google", query);
  }

  if (googleResult.blocked) {
    logger.warn("Live search: Google blocked, falling back to DuckDuckGo", { query });
  } else {
    logger.warn("Live search: no Google results found, falling back to DuckDuckGo", { query, error: googleResult.error });
  }

  // Fallback: DuckDuckGo. Tried whenever Google is blocked OR simply returns
  // nothing usable — either way, worth a second attempt before giving up.
  const ddgResult = await duckDuckGoSearch(query);

  if (ddgResult.success && ddgResult.results.length > 0) {
    return fetchSourcesFromResults(ddgResult, "duckduckgo", query);
  }

  // All three sources failed. Only report "blocked" if every source that
  // could be blocked, was — an empty-but-not-blocked result is a different
  // situation for the caller than a genuine block across the board.
  const allBlocked = (metaResult.blocked || false) && googleResult.blocked && ddgResult.blocked;
  logger.error("Live search: meta-search engine, Google, and DuckDuckGo all failed", {
    query,
    metaSearchError: metaResult.error,
    googleError: googleResult.error,
    ddgError: ddgResult.error,
  });

  return buildLiveResult({ sources: [], candidateUrls: [], blocked: allBlocked, engine: "none" });
}
