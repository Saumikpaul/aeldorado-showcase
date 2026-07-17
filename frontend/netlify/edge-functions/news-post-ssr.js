// netlify/edge-functions/news-post-ssr.js — Server-Side Rendered Newsroom (single post)
// Aeldorado by Solanacy Technologies
//
// Same reasoning as news-ssr.js: crawlers and AI agents that don't run JS
// need the full article HTML on the very first response — including the
// markdown body already converted to HTML, and per-post OG/meta tags for
// correct link previews and citations.

import { marked } from "https://esm.sh/marked@12.0.2";

const API_BASE = "https://api.aeldorado.solanacy.in";

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function notFoundHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>Post not found — Aeldorado Newsroom</title>
<meta name="robots" content="noindex" />
<link rel="stylesheet" href="/css/legal.css" /></head>
<body style="padding:120px 24px;text-align:center;">
  <h1 style="font-size:1.6rem;margin-bottom:12px;">This post doesn't exist or isn't published yet.</h1>
  <a href="/news" style="color:var(--lg-accent, #2563eb);">← Back to Newsroom</a>
</body></html>`;
}

export default async (request, context) => {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const slug = parts[1]; // /news/:slug

  if (!slug) {
    return new Response(notFoundHtml(), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  let post = null;
  try {
    const res = await fetch(`${API_BASE}/v1/news/${encodeURIComponent(slug)}`);
    if (res.ok) {
      const data = await res.json();
      post = data.post;
    }
  } catch {
    // fall through to notFound below
  }

  if (!post) {
    return new Response(notFoundHtml(), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const bodyHtml = marked.parse(post.bodyMarkdown || "");
  const title = escapeHtml(post.title);
  const description = escapeHtml(post.excerpt || post.title);
  const canonicalUrl = `https://aeldorado.solanacy.in/news/${encodeURIComponent(post.slug)}`;
  const ogImage = post.coverImage || "https://aeldorado.solanacy.in/assets/og-banner.png";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — Aeldorado Newsroom</title>
  <link rel="icon" type="image/png" href="/assets/aeldorado.png" />
  <link rel="apple-touch-icon" href="/assets/aeldorado.png" />
  <meta name="description" content="${description}" />
  <link rel="canonical" href="${canonicalUrl}" />

  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Aeldorado" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${canonicalUrl}" />
  <meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="article:published_time" content="${escapeHtml(post.publishedAt)}" />
  <meta property="article:section" content="${escapeHtml(post.category)}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${escapeHtml(ogImage)}" />

  <meta name="robots" content="index, follow" />

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": ${JSON.stringify(post.title)},
    "description": ${JSON.stringify(post.excerpt || post.title)},
    "url": ${JSON.stringify(canonicalUrl)},
    "datePublished": ${JSON.stringify(post.publishedAt)},
    "dateModified": ${JSON.stringify(post.updatedAt || post.publishedAt)},
    "articleSection": ${JSON.stringify(post.category)},
    ${post.coverImage ? `"image": ${JSON.stringify(post.coverImage)},` : ""}
    "publisher": {
      "@type": "Organization",
      "name": "Solanacy Technologies",
      "url": "https://solanacy.in",
      "logo": { "@type": "ImageObject", "url": "https://aeldorado.solanacy.in/assets/aeldorado.png" }
    },
    "author": { "@type": "Organization", "name": "Aeldorado" }
  }
  </script>

  <link rel="stylesheet" href="/css/legal.css" />
  <style>
    .post-layout { max-width: 740px; margin: 0 auto; padding: 112px 24px 90px; }
    .post-back { display: inline-flex; align-items: center; gap: 6px; font-size: 0.85rem; font-weight: 500; color: var(--lg-text-2); margin-bottom: 28px; }
    .post-back:hover { color: var(--lg-accent); }
    .post-cat { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--lg-accent); margin-bottom: 10px; }
    .post-title { font-size: 2.1rem; font-weight: 700; letter-spacing: -0.03em; line-height: 1.2; color: var(--lg-text-1); margin-bottom: 12px; }
    .post-date { font-size: 0.85rem; color: var(--lg-text-3); margin-bottom: 32px; }
    .post-cover { width: 100%; border-radius: var(--lg-card-r); margin-bottom: 36px; display: block; }
    .post-body { font-size: 1.02rem; line-height: 1.75; color: var(--lg-text-1); }
    .post-body h1, .post-body h2, .post-body h3 { font-weight: 700; letter-spacing: -0.02em; margin: 2em 0 0.6em; }
    .post-body h1 { font-size: 1.5rem; }
    .post-body h2 { font-size: 1.3rem; }
    .post-body h3 { font-size: 1.1rem; }
    .post-body p { margin: 0 0 1.2em; }
    .post-body a { color: var(--lg-accent); text-decoration: underline; }
    .post-body ul, .post-body ol { margin: 0 0 1.2em; padding-left: 1.4em; }
    .post-body li { margin-bottom: 0.4em; }
    .post-body img { max-width: 100%; border-radius: 12px; margin: 1.2em 0; }
    .post-body code { background: rgba(37,99,235,0.08); color: #1e3a8a; padding: 2px 6px; border-radius: 4px; font-family: var(--lg-mono); font-size: 0.88em; }
    .post-body pre { background: #0d1117; color: #e6edf3; padding: 18px 20px; border-radius: 12px; overflow-x: auto; margin: 1.4em 0; }
    .post-body pre code { background: none; color: inherit; padding: 0; }
    .post-body blockquote { border-left: 3px solid var(--lg-accent); padding-left: 16px; color: var(--lg-text-2); margin: 1.4em 0; font-style: italic; }
    .post-body hr { border: none; border-top: 1px solid rgba(37,99,235,0.12); margin: 2.4em 0; }
  </style>
</head>
<body>

<nav>
  <a class="nav-brand" href="/">
    <svg viewBox="0 0 32 32" fill="none" width="28" height="28">
      <defs>
        <linearGradient id="lg1" x1="0" y1="0" x2="32" y2="32"><stop stop-color="#3b82f6" offset="0%"/><stop stop-color="#7c3aed" offset="100%"/></linearGradient>
        <linearGradient id="lg2" x1="0" y1="0" x2="32" y2="32"><stop stop-color="#9ca3af" offset="0%"/><stop stop-color="#4b5563" offset="100%"/></linearGradient>
      </defs>
      <path d="M16 3L3 27h6l7-13 7 13h6L16 3z" fill="url(#lg1)"/>
      <path d="M16 16l-3.5 6.5h7L16 16z" fill="url(#lg2)"/>
    </svg>
    <span class="brand-name">Aeldorado</span>
  </a>
  <div class="nav-links">
    <a href="/">Home</a>
    <a href="/docs">Docs</a>
    <a href="/news">Newsroom</a>
    <a href="/#pricing">Pricing</a>
    <a href="/contact">Contact</a>
  </div>
</nav>

<div class="post-layout">
  <a class="post-back" href="/news">← Back to Newsroom</a>
  <div class="post-cat">${escapeHtml(post.category)}</div>
  <h1 class="post-title">${title}</h1>
  <div class="post-date">${formatDate(post.publishedAt)}</div>
  ${post.coverImage ? `<img class="post-cover" src="${escapeHtml(post.coverImage)}" alt="" />` : ""}
  <div class="post-body">${bodyHtml}</div>
</div>

<footer>
  <div class="footer-inner">
    <div class="footer-links">
      <a href="/docs">Docs</a>
      <a href="/news">Newsroom</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a href="/contact">Contact</a>
    </div>
    <p class="footer-copy">© 2026 Aeldorado by <a href="https://solanacy.in" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">Solanacy Technologies</a>. All rights reserved.</p>
    <p class="footer-legal">Owned &amp; operated by <strong>Saumik Paul</strong> · <a href="https://solanacy.in" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">Solanacy Technologies</a></p>
  </div>
</footer>

</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=60",
    },
  });
};

export const config = { path: "/news/*" };
