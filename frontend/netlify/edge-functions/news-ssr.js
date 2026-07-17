// netlify/edge-functions/news-ssr.js — Server-Side Rendered Newsroom (listing)
// Aeldorado by Solanacy Technologies
//
// Why this exists: the original /news page fetched posts client-side via
// JS. Most AI/search crawlers (GPTBot, ClaudeBot, PerplexityBot, Googlebot's
// first pass) don't execute JavaScript, so they'd only ever see an empty
// "Loading…" shell. This Edge Function runs at request time, fetches the
// published posts straight from the API, and returns fully-formed HTML —
// so a crawler and a human browser see the exact same content.

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
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function cardHtml(post) {
  const cover = post.coverImage
    ? `<img class="news-card-cover" src="${escapeHtml(post.coverImage)}" alt="" loading="lazy" />`
    : `<div class="news-card-cover"></div>`;
  return `
    <a class="news-card" href="/news/${encodeURIComponent(post.slug)}">
      ${cover}
      <div class="news-card-body">
        <div class="news-card-cat">${escapeHtml(post.category)}</div>
        <div class="news-card-title">${escapeHtml(post.title)}</div>
        ${post.excerpt ? `<div class="news-card-excerpt">${escapeHtml(post.excerpt)}</div>` : ""}
        <div class="news-card-date">${formatDate(post.publishedAt)}</div>
      </div>
    </a>
  `;
}

function pillHtml(cat, active) {
  return `<button class="news-filter-pill${active ? " active" : ""}" data-category="${escapeHtml(cat)}">${escapeHtml(cat) || "All"}</button>`;
}

export default async (request, context) => {
  const url = new URL(request.url);
  const category = url.searchParams.get("category") || "";

  let posts = [];
  let categories = [];
  let nextCursor = null;
  let fetchFailed = false;

  try {
    const apiUrl = new URL(`${API_BASE}/v1/news`);
    apiUrl.searchParams.set("limit", "12");
    if (category) apiUrl.searchParams.set("category", category);

    const res = await fetch(apiUrl.toString());
    if (res.ok) {
      const data = await res.json();
      posts = data.posts || [];
      categories = data.categories || [];
      nextCursor = data.nextCursor || null;
    } else {
      fetchFailed = true;
    }
  } catch {
    fetchFailed = true;
  }

  const gridHtml = fetchFailed
    ? `<div class="news-error">Couldn't load the newsroom right now. Please try again shortly.</div>`
    : posts.length
      ? posts.map(cardHtml).join("")
      : `<div class="news-empty">No posts yet — check back soon.</div>`;

  const filterPills = [pillHtml("", !category), ...categories.map((c) => pillHtml(c, c === category))].join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Newsroom — Aeldorado by Solanacy Technologies</title>
  <link rel="icon" type="image/png" href="/assets/aeldorado.png" />
  <link rel="apple-touch-icon" href="/assets/aeldorado.png" />
  <meta name="description" content="Product updates, announcements, and engineering notes from the Aeldorado team." />
  <link rel="canonical" href="https://aeldorado.solanacy.in/news" />

  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Aeldorado" />
  <meta property="og:title" content="Newsroom — Aeldorado by Solanacy Technologies" />
  <meta property="og:description" content="Product updates, announcements, and engineering notes from the Aeldorado team." />
  <meta property="og:url" content="https://aeldorado.solanacy.in/news" />
  <meta property="og:image" content="https://aeldorado.solanacy.in/assets/og-banner.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:locale" content="en_US" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Newsroom — Aeldorado by Solanacy Technologies" />
  <meta name="twitter:description" content="Product updates, announcements, and engineering notes from the Aeldorado team." />
  <meta name="twitter:image" content="https://aeldorado.solanacy.in/assets/og-banner.png" />

  <meta name="robots" content="index, follow" />

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "Aeldorado Newsroom",
    "url": "https://aeldorado.solanacy.in/news",
    "description": "Product updates, announcements, and engineering notes from the Aeldorado team.",
    "publisher": {
      "@type": "Organization",
      "name": "Solanacy Technologies",
      "url": "https://solanacy.in"
    },
    "hasPart": [
      ${posts.map((p) => `{
        "@type": "NewsArticle",
        "headline": ${JSON.stringify(p.title)},
        "url": "https://aeldorado.solanacy.in/news/${p.slug}",
        "datePublished": ${JSON.stringify(p.publishedAt)},
        "articleSection": ${JSON.stringify(p.category)}
      }`).join(",\n      ")}
    ]
  }
  </script>

  <link rel="stylesheet" href="/css/legal.css" />
  <style>
    .news-layout { max-width: 1080px; margin: 0 auto; padding: 108px 24px 80px; }
    .news-header { margin-bottom: 40px; }
    .news-header h1 { font-size: 2.4rem; font-weight: 700; letter-spacing: -0.035em; color: var(--lg-text-1); margin-bottom: 8px; }
    .news-header p { color: var(--lg-text-2); font-size: 1rem; }
    .news-filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 36px; }
    .news-filter-pill {
      font-family: var(--lg-font); font-size: 0.82rem; font-weight: 500; padding: 7px 16px;
      border-radius: 999px; border: 1px solid rgba(37,99,235,0.16); background: rgba(255,255,255,0.6);
      color: var(--lg-text-2); cursor: pointer; text-decoration: none; display: inline-block;
      transition: all 180ms ease;
    }
    .news-filter-pill:hover { border-color: var(--lg-accent); color: var(--lg-accent); }
    .news-filter-pill.active { background: var(--lg-accent); border-color: var(--lg-accent); color: #fff; }
    .news-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 24px; }
    .news-card {
      position: relative; isolation: isolate; display: flex; flex-direction: column;
      background: var(--lg-card-bg); border: 1px solid var(--lg-card-bd); border-radius: var(--lg-card-r);
      overflow: hidden; text-decoration: none;
      box-shadow: 0 2px 12px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.88);
      transition: transform 220ms cubic-bezier(0.22,1,0.36,1), box-shadow 220ms ease;
    }
    .news-card::before {
      content: ""; position: absolute; inset: 0; border-radius: inherit;
      backdrop-filter: blur(6px) saturate(160%); -webkit-backdrop-filter: blur(6px) saturate(160%);
      z-index: -1; border-top: 1px solid rgba(255,255,255,0.85);
    }
    .news-card:hover { transform: translateY(-3px); box-shadow: 0 8px 28px rgba(37,99,235,0.12), 0 2px 8px rgba(0,0,0,0.06); }
    .news-card-cover { width: 100%; height: 160px; object-fit: cover; background: linear-gradient(135deg, rgba(59,130,246,0.12), rgba(124,58,237,0.10)); }
    .news-card-body { padding: 20px 22px 22px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
    .news-card-cat { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--lg-accent); }
    .news-card-title { font-size: 1.08rem; font-weight: 700; letter-spacing: -0.015em; color: var(--lg-text-1); line-height: 1.35; }
    .news-card-excerpt { font-size: 0.86rem; color: var(--lg-text-2); line-height: 1.55; flex: 1; }
    .news-card-date { font-size: 0.76rem; color: var(--lg-text-3); margin-top: 6px; }
    .news-empty, .news-error { grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--lg-text-2); }
    .news-pagination { display: flex; justify-content: center; gap: 10px; margin-top: 40px; }
    @media (max-width: 640px) { .news-layout { padding: 96px 16px 60px; } .news-header h1 { font-size: 1.9rem; } }
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

<div class="news-layout">
  <div class="news-header">
    <h1>Newsroom</h1>
    <p>Product updates, announcements, and engineering notes from the Aeldorado team.</p>
  </div>

  <div class="news-filters">${filterPills}</div>

  <div class="news-grid">${gridHtml}</div>

  ${nextCursor ? `<div class="news-pagination"><a class="news-filter-pill" href="/news?category=${encodeURIComponent(category)}&cursor=${encodeURIComponent(nextCursor)}">More posts →</a></div>` : ""}
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

export const config = { path: "/news" };
