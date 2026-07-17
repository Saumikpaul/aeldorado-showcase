// core/google-search.js — Google Search Result Scraper (No Third-Party API)
// Aeldorado by Solanacy Technologies
//
// Hits Google's search result page using a real headless browser (Playwright),
// not plain fetch(). No Serper/Tavily/Brave/Bing or any paid search API involved.
//
// WHY PLAYWRIGHT (not plain fetch): confirmed via production logs that Google
// serves a "please enable JavaScript" interstitial to non-browser HTTP clients
// instead of real results — a JS engine is required to pass that gate, not
// just a convincing User-Agent header.
//
// HONEST LIMITS (documented, not hidden):
// - Google can still detect and block headless browsers (fingerprinting,
//   rate-limiting). This reduces detection risk, it does not eliminate it.
// - Free-tier Render (512MB RAM) can only safely run ONE browser instance
//   at a time — a concurrency lock below queues requests instead of letting
//   multiple Chromium instances crash the whole service via OOM.
// - Each search is slower than plain fetch (~2-4s browser overhead).
// - No proxy/IP rotation (deliberately out of scope for now).
// - Google's result page markup changes periodically; selectors may need
//   updates over time.

import { chromium } from "playwright";
import { logger } from "./logger.js";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
];

const NAV_TIMEOUT_MS = 15000;
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 4000;
const MAX_RESULTS = 8;

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay() {
  const ms = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Concurrency lock ────────────────────────────────────────────────────
// Free-tier Render (512MB RAM) cannot safely run more than one Chromium
// instance at once. This is a simple promise-chain queue: every call to
// googleSearch() waits for the previous one to fully finish (browser closed)
// before starting. Requests queue instead of racing and OOM-crashing the
// service. On paid tiers with more RAM, this can be relaxed to a small pool.
let queue = Promise.resolve();
function withConcurrencyLock(fn) {
  const run = queue.then(fn, fn); // run fn regardless of previous success/failure
  queue = run.catch(() => {});     // never let a rejection break the chain
  return run;
}

function looksBlocked(html) {
  return (
    html.includes("Our systems have detected unusual traffic") ||
    html.includes("recaptcha") ||
    html.includes('id="captcha-form"')
  );
}

function extractRealUrl(href) {
  if (!href) return null;
  if (href.startsWith("/url?")) {
    const params = new URLSearchParams(href.slice(5));
    return params.get("q");
  }
  if (href.startsWith("http")) return href;
  return null;
}

async function runSearch(query) {
  await randomDelay();

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      userAgent: randomUserAgent(),
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });

    const page = await context.newPage();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${MAX_RESULTS}&hl=en`;

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    // Give Google's JS a moment to finish rendering results client-side.
    await page.waitForTimeout(1500);

    const html = await page.content();

    if (looksBlocked(html)) {
      logger.warn("Google search blocked (CAPTCHA/unusual traffic)", { query });
      return { success: false, blocked: true, error: "Blocked by Google (CAPTCHA/rate-limit)", results: [] };
    }

    // Extract results directly in-page — more reliable than re-parsing
    // serialized HTML with Cheerio since we already have a live DOM here.
    const containerSelectors = ["div.g", "div.tF2Cxc", "div.MjjYud", "div[data-sokoban-container]"];
    let results = [];

    for (const sel of containerSelectors) {
      const count = await page.locator(sel).count();
      if (count === 0) continue;

      results = await page.locator(sel).evaluateAll((nodes) => {
        return nodes.map((el) => {
          const linkEl = el.querySelector("a");
          const h3 = el.querySelector("h3");
          const snippetEl = el.querySelector("div[data-sncf], .VwiC3b, .IsZvec");
          return {
            href: linkEl ? linkEl.getAttribute("href") : null,
            title: h3 ? h3.textContent.trim() : "",
            snippet: snippetEl ? snippetEl.textContent.trim() : "",
          };
        });
      });

      results = results
        .map(r => ({ url: extractRealUrl(r.href), title: r.title, snippet: r.snippet }))
        .filter(r => r.url && r.url.startsWith("http") && r.title);

      if (results.length > 0) break;
    }

    if (results.length === 0) {
      logger.warn("Google search: zero results parsed (Playwright)", {
        query,
        htmlLength: html.length,
        htmlSample: html.slice(0, 500).replace(/\s+/g, " "),
      });
    }

    return { success: true, blocked: false, results: results.slice(0, MAX_RESULTS) };
  } catch (e) {
    logger.error("Google search (Playwright) failed", { error: e.message, query });
    return {
      success: false,
      blocked: false,
      error: e.name === "TimeoutError" ? "Timeout" : e.message,
      results: [],
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Search Google directly via a headless browser and return parsed organic
 * result links + snippets. Always resolves (never throws) — on failure/block,
 * returns { blocked: true } or { success: false, error } so callers can
 * degrade gracefully. Concurrency-locked to one search at a time to protect
 * free-tier memory limits.
 */
export async function googleSearch(query) {
  return withConcurrencyLock(() => runSearch(query));
}
