// core/duckduckgo-search.js — DuckDuckGo Search Result Scraper (No Third-Party API)
// Aeldorado by Solanacy Technologies
//
// Fallback search source for when Google scraping is blocked. Uses DDG's
// HTML-only endpoint (html.duckduckgo.com/html/), which does not require JS
// rendering, so a plain fetch() works here — no Playwright needed for this
// source specifically.
//
// HONEST LIMITS (documented, not hidden):
// - DDG's HTML endpoint has historically been more lenient toward automated
//   requests than Google, but it is not immune to rate-limiting either —
//   sustained heavy use can still get throttled.
// - DDG's result coverage/freshness is generally considered weaker than
//   Google's for some query types (especially very recent news).
// - No proxy/IP rotation (same deliberate scope decision as google-search.js).
// - DDG's HTML markup can change; selectors may need maintenance over time.

import * as cheerio from "cheerio";
import { logger } from "./logger.js";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
];

const FETCH_TIMEOUT_MS = 8000;
const MIN_DELAY_MS = 800;
const MAX_DELAY_MS = 2500;
const MAX_RESULTS = 8;

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay() {
  const ms = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * DDG's HTML endpoint wraps result links in a redirect
 * (/l/?uddg=<encoded-real-url>&...). Extract the real destination.
 */
function extractRealUrl(href) {
  if (!href) return null;
  if (href.startsWith("//duckduckgo.com/l/") || href.startsWith("/l/")) {
    const qIndex = href.indexOf("uddg=");
    if (qIndex === -1) return null;
    const rest = href.slice(qIndex + 5);
    const ampIndex = rest.indexOf("&");
    const encoded = ampIndex === -1 ? rest : rest.slice(0, ampIndex);
    try {
      return decodeURIComponent(encoded);
    } catch {
      return null;
    }
  }
  if (href.startsWith("http")) return href;
  return null;
}

function looksBlocked(html) {
  return html.includes("unusual traffic") || html.includes("blocked") && html.includes("captcha");
}

/**
 * Search DuckDuckGo's HTML endpoint and return parsed organic result links +
 * snippets. Always resolves (never throws) — failures return
 * { success: false, error } so callers can degrade gracefully.
 */
export async function duckDuckGoSearch(query) {
  await randomDelay();

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "User-Agent": randomUserAgent(),
          "Accept": "text/html",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `q=${encodeURIComponent(query)}`,
      },
      FETCH_TIMEOUT_MS
    );

    if (!res.ok) {
      logger.warn("DuckDuckGo search non-OK response", { status: res.status, query });
      return { success: false, blocked: res.status === 429, error: `HTTP ${res.status}`, results: [] };
    }

    const html = await res.text();

    if (looksBlocked(html)) {
      logger.warn("DuckDuckGo search blocked", { query });
      return { success: false, blocked: true, error: "Blocked by DuckDuckGo", results: [] };
    }

    const $ = cheerio.load(html);
    const results = [];

    $(".result, .web-result").each((_, el) => {
      const $el = $(el);
      const linkEl = $el.find("a.result__a, a.result__url").first();
      const href = extractRealUrl(linkEl.attr("href"));
      const title = $el.find("a.result__a").first().text().trim();
      const snippet = $el.find(".result__snippet").first().text().trim();

      if (href && href.startsWith("http") && title) {
        results.push({ url: href, title, snippet });
      }
    });

    if (results.length === 0) {
      logger.warn("DuckDuckGo search: zero results parsed", {
        query,
        htmlLength: html.length,
        htmlSample: html.slice(0, 500).replace(/\s+/g, " "),
      });
    }

    return { success: true, blocked: false, results: results.slice(0, MAX_RESULTS) };
  } catch (e) {
    logger.error("DuckDuckGo search fetch failed", { error: e.message, query });
    return { success: false, blocked: false, error: e.name === "AbortError" ? "Timeout" : e.message, results: [] };
  }
}
