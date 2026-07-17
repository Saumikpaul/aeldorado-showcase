// core/web-fetcher.js — Live Web Fetch + Extraction Engine
// Aeldorado by Solanacy Technologies
//
// No third-party search API. This module takes a URL, verifies it's alive,
// fetches raw HTML, and extracts clean readable text from it.
// Used by core/live-search.js as the fetch stage of the live search pipeline.

import * as cheerio from "cheerio";
import { logger } from "./logger.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HEAD_TIMEOUT_MS  = 3000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_CONTENT_CHARS = 6000; // cap per-source content to keep agent context sane

/**
 * Race a fetch against a timeout so a slow/dead site never hangs the pipeline.
 */
function fetchWithTimeout(url, options = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

/**
 * Quick liveness check before committing to a full fetch+parse.
 * Some servers don't support HEAD properly, so a non-2xx/3xx or network
 * error is treated as "not verifiable" rather than immediately fatal —
 * caller decides whether to still attempt a GET.
 */
export async function verifyDomainAlive(url) {
  try {
    const res = await fetchWithTimeout(
      url,
      { method: "HEAD", headers: { "User-Agent": USER_AGENT } },
      HEAD_TIMEOUT_MS
    );
    return res.ok || (res.status >= 300 && res.status < 400);
  } catch (e) {
    logger.warn("Domain liveness check failed", { url, error: e.message });
    return false;
  }
}

/**
 * Strip boilerplate (nav/footer/script/style/ads) and pull readable text
 * from the parts of the page likely to contain actual content.
 */
function extractReadableText($) {
  $("script, style, nav, footer, header, noscript, svg, iframe, form").remove();
  $("[class*='cookie'], [class*='banner'], [class*='ad-'], [id*='cookie']").remove();

  const title = $("title").first().text().trim() || $("h1").first().text().trim();

  // Prefer semantic content containers; fall back to body if none found.
  const candidates = ["article", "main", "[role='main']", ".content", "#content", "body"];
  let bodyText = "";
  for (const sel of candidates) {
    const text = $(sel).first().text().replace(/\s+/g, " ").trim();
    if (text.length > 200) {
      bodyText = text;
      break;
    }
  }
  if (!bodyText) {
    bodyText = $("body").text().replace(/\s+/g, " ").trim();
  }

  return { title, bodyText: bodyText.slice(0, MAX_CONTENT_CHARS) };
}

/**
 * Fetch a single URL and extract clean text content from it.
 * Always resolves (never throws) — failures are returned as
 * { success: false, error } so Promise.allSettled callers don't need
 * special-case handling.
 */
export async function fetchAndExtract(url) {
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } },
      FETCH_TIMEOUT_MS
    );

    if (!res.ok) {
      return { url, success: false, error: `HTTP ${res.status}`, fetchedAt: new Date().toISOString() };
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return { url, success: false, error: `Unsupported content-type: ${contentType}`, fetchedAt: new Date().toISOString() };
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const { title, bodyText } = extractReadableText($);

    if (!bodyText || bodyText.length < 100) {
      return { url, success: false, error: "No extractable content (likely JS-rendered page)", fetchedAt: new Date().toISOString() };
    }

    return {
      url,
      title: title || url,
      content: bodyText,
      success: true,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      url,
      success: false,
      error: e.name === "AbortError" ? "Timeout" : e.message,
      fetchedAt: new Date().toISOString(),
    };
  }
}

/**
 * Fetch multiple URLs with bounded concurrency so we never hammer targets
 * (or our own outbound connections) with an unbounded burst of requests.
 */
export async function fetchMultiple(urls, concurrency = 5) {
  const results = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fetchAndExtract));
    results.push(...batchResults.map(r => (r.status === "fulfilled" ? r.value : { success: false, error: "Unhandled rejection" })));
  }
  return results;
}
